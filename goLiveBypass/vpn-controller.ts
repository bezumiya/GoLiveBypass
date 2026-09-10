/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "crypto";
import { app } from "electron";
import fs from "fs";
import path from "path";

import * as linux from "./vpn-linux";
import * as proton from "./vpn-proton";
import {
    isSupportedLinuxArchitecture,
    isSupportedVpnArchitecture,
    isSupportedWindowsArchitecture,
    normalizeProtonUsername,
    normalizeVpnSettings,
    protonUsernamesMatch,
    safeDiagnosticDetail,
    validateWireGuardConfig,
    VPN_OWNER_KIND,
    VPN_SCHEMA_VERSION,
    type VpnDiagnostic,
    type VpnOperationResult,
    type VpnOwnerRecord,
    type VpnSettings,
    type VpnState,
    type VpnStatus,
} from "./vpn-types";
import * as windows from "./vpn-windows";

export type ControllerLog = windows.WireSockLogger;

export interface PluginVpnControllerOptions {
    dataDir: string;
    guiDataDir: string;
    readSettings: () => unknown;
    isEnabled: () => boolean;
    log: ControllerLog;
    requestRelaunch?: (namespace: string | null) => Promise<boolean> | boolean;
}

export interface ProtonLoginPayload {
    username: string;
    password?: string;
    twoFactorCode?: string;
    requestId?: string;
}

export interface ProtonOptimizationOptions {
    country?: string;
    freeOnly?: boolean;
    autoPing?: boolean;
    speedTest?: boolean;
    requestId?: string;
    onProgress?: (progress: proton.ProtonOptimizationProgress & { requestId: string }) => void;
}

const OWNER_FILE = "owner.lock";
const MIGRATION_FILE = "migration-v1.json";
const PROFILE_FILE = "wireguard.conf";
const PROFILE_ACCOUNT_FILE = "wireguard-profile-account.json";
const SERVICE_CONFIG_FILE = "wiresock-discord.conf";
const WATCHDOG_MS = 15_000;
const OWNER_MUTEX_SUFFIX = ".mutex";
const OWNER_MUTEX_HOLDER_FILE = "holder.json";
const OWNER_MUTEX_RETRY_MS = 25;
const OWNER_MUTEX_MAX_ATTEMPTS = 80;
const OWNER_MUTEX_STALE_MS = 15_000;

function errorMessage(error: unknown): string {
    return safeDiagnosticDetail(error, 600);
}

type OwnershipToken = Pick<VpnOwnerRecord, "kind" | "pid" | "generation" | "createdAt">;

function ownershipToken(owner: VpnOwnerRecord): OwnershipToken {
    return { kind: owner.kind, pid: owner.pid, generation: owner.generation, createdAt: owner.createdAt };
}

function sameOwnership(a: OwnershipToken | VpnOwnerRecord | null | undefined, b: OwnershipToken | VpnOwnerRecord | null | undefined): boolean {
    return Boolean(a && b
        && a.kind === b.kind
        && a.pid === b.pid
        && a.generation === b.generation
        && a.createdAt === b.createdAt);
}

function isWindows(): boolean {
    return process.platform === "win32";
}

function isLinux(): boolean {
    return process.platform === "linux";
}

function isUnknownWireSockInspection(inspection: windows.WireSockInspection): boolean {
    return !inspection.reliable;
}

function unknownWireSockMessage(inspection: windows.WireSockInspection): string {
    return inspection.reason || "Não foi possível confirmar o estado do WireSock; estado desconhecido.";
}

function processAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as { code?: unknown })?.code === "EPERM";
    }
}

function normalizeUsername(value: string): string {
    return normalizeProtonUsername(value).slice(0, 320);
}

function normalizeLoginRequestId(value: unknown): string {
    const candidate = typeof value === "string" ? value.trim().slice(0, 120) : "";
    return /^[A-Za-z0-9._:-]{1,120}$/.test(candidate) ? candidate : randomUUID();
}

function cancelledLoginResult(): proton.ProtonLoginResult {
    const message = "O login Proton foi cancelado.";
    return { success: false, code: "CANCELLED", message, error: message, retryable: true };
}

interface ProtonProfileSelection {
    country: string;
    freeOnly: boolean;
    autoPing: boolean;
}

function normalizeCountry(value: string): string {
    return value.trim()
        .split(",")
        .map(part => part.trim().toUpperCase())
        .filter(part => /^[A-Z]{2}$/.test(part))
        .join(",");
}

export class PluginVpnController {
    private readonly options: PluginVpnControllerOptions;
    private readonly dataDir: string;
    private readonly profilePath: string;
    private readonly profileAccountPath: string;
    private readonly serviceConfigPath: string;
    private readonly ownerPath: string;
    private state: VpnState = "inactive";
    private generation = 0;
    private discordPid: number | null = null;
    private probePath: string | undefined;
    private lastDiagnostic: VpnDiagnostic | null = null;
    private externalReason: string | null = null;
    private operationQueue: Promise<unknown> = Promise.resolve();
    private watchdog: ReturnType<typeof setInterval> | null = null;
    private watchdogChecking = false;
    private restarting = false;
    private initialized = false;
    private automaticBootSuppressed = false;
    private optimization: { id: string; controller: AbortController } | null = null;
    private protonLogin: { id: string; controller: AbortController } | null = null;
    private routeProbeFlights = new Set<Promise<void>>();
    private ownershipToken: OwnershipToken | null = null;
    private diagnosticGeneration = 0;

    public constructor(options: PluginVpnControllerOptions) {
        this.options = options;
        this.dataDir = path.resolve(options.dataDir);
        this.profilePath = path.join(this.dataDir, PROFILE_FILE);
        this.profileAccountPath = path.join(this.dataDir, PROFILE_ACCOUNT_FILE);
        this.serviceConfigPath = path.join(this.dataDir, SERVICE_CONFIG_FILE);
        this.ownerPath = path.join(this.dataDir, OWNER_FILE);
    }

    public get paths() {
        return { dataDir: this.dataDir, profilePath: this.profilePath, serviceConfigPath: this.serviceConfigPath, ownerPath: this.ownerPath };
    }

    public isRelaunching(): boolean {
        return this.restarting;
    }

    public shouldSkipAutomaticEnable(): boolean {
        return this.automaticBootSuppressed;
    }

    public hasCleanupWork(): boolean {
        if (isLinux()) {
            const owner = this.readOwner();
            const inspection = linux.inspectLinuxNetworkSync(owner);
            if (!inspection.reliable) return true;
            if (inspection.externalConflict && !owner) return false;
            return inspection.active || Boolean(owner);
        }
        const inspection = windows.inspectWireSock(this.serviceConfigPath);
        if (isUnknownWireSockInspection(inspection)) return this.state !== "blocked_external";
        if (inspection.active) return inspection.owned;
        if (this.state === "blocked_external") return false;
        if (this.state === "inactive") return this.readOwner() !== null;
        return true;
    }

    public initialize(): Promise<void> {
        return this.serial(() => this.initializeInternal());
    }

    private async initializeInternal(): Promise<void> {
        if (this.initialized) return;
        if (isLinux()) {
            await this.initializeLinux();
            return;
        }
        if (!isWindows()) return;
        this.initialized = true;
        try {
            await this.migrateGuiState();
            const owner = this.readOwner();
            const inspection = windows.inspectWireSock(this.serviceConfigPath);
            if (isUnknownWireSockInspection(inspection)) {
                this.initialized = false;
                this.state = "recovery_required";
                this.externalReason = null;
                this.setDiagnostic("ownership", false, unknownWireSockMessage(inspection));
                this.options.log("warn", "boot não confirmou o estado do WireSock; cleanup adiado", { mode: "diagnostic-only" });
                return;
            }
            if (!inspection.active) {
                if (this.isLiveForeignOwner(owner)) {
                    this.state = "recovery_required";
                    this.setDiagnostic("ownership", false, "outra instância do plugin ainda possui o lock da VPN");
                    this.options.log("warn", "boot encontrou owner vivo enquanto o serviço não foi confirmado; cleanup adiado");
                    return;
                }
                const relaunchWasNotConfirmed = owner?.restarting === true;
                if (relaunchWasNotConfirmed) this.automaticBootSuppressed = true;
                await this.removeProbe({ staleOwner: owner, sweep: true });
                if (owner && !await this.releaseOwnership(owner)) {
                    this.state = "recovery_required";
                    this.setDiagnostic("ownership", false, "não foi possível liberar o lock da VPN no boot");
                    return;
                }
                if (relaunchWasNotConfirmed) {
                    this.state = "recovery_required";
                    this.setDiagnostic("ownership", false, "o relaunch anterior não confirmou o WireSock; ativação automática suspensa");
                    this.options.log("warn", "relaunch do Discord não confirmou o WireSock; autostart suspenso");
                    return;
                }
                this.state = "inactive";
                return;
            }
            if (!inspection.owned) {
                this.blockExternal(inspection.reason || "WireSock externo já está ativo.");
                return;
            }
            if (!this.options.isEnabled() && this.isLiveForeignOwner(owner)) {
                this.state = "recovery_required";
                this.setDiagnostic("ownership", false, "outra instância do plugin ainda possui o lock da VPN");
                this.options.log("warn", "plugin desativado não interrompeu uma sessão pertencente a outra instância viva");
                return;
            }
            if (!this.options.isEnabled()) {
                this.options.log("warn", "WireSock próprio encontrado com o plugin desativado; restaurando a rede");
                await this.claimActiveOwnership(owner, inspection);
                const cleanup = await this.stopInternal(false);
                if (!cleanup.success) this.initialized = false;
                return;
            }
            this.generation = Math.max(this.generation, owner?.generation ?? 0);
            const adopted = await this.claimActiveOwnership(owner, inspection);
            if (adopted.probePath) await this.cleanupStaleProbes([adopted.probePath]);
            this.state = "active";
            this.discordPid = process.pid;
            this.diagnosticGeneration++;
            this.startWatchdog();
            this.startDiagnostics("adoption");
            this.options.log("info", "sessão WireSock própria adotada após inicialização", { generation: this.generation });
        } catch (error) {
            // Permite que um retry explícito tente a recuperação novamente após
            // uma falha transitória durante o boot.
            this.initialized = false;
            this.state = "recovery_required";
            this.setDiagnostic("ownership", false, errorMessage(error));
            this.options.log("error", "falha ao recuperar sessão VPN no boot", { erro: errorMessage(error) });
        }
    }

    private async initializeLinux(): Promise<void> {
        this.initialized = true;
        if (!isSupportedLinuxArchitecture(process.platform, process.arch)) {
            this.state = "dependency_missing";
            this.setDiagnostic("dependency", false, "O transporte Linux do plugin exige arquitetura x64.");
            return;
        }
        try {
            const owner = this.readOwner();
            const inspection = linux.inspectLinuxNetworkSync(owner);
            if (!inspection.reliable) {
                this.initialized = false;
                this.state = "recovery_required";
                this.setDiagnostic("wireguard", false, inspection.reason || "não foi possível confirmar o namespace Linux");
                this.options.log("warn", "boot Linux não confirmou o estado do plugin; cleanup adiado", { mode: "diagnostic-only" });
                return;
            }
            const ownerPointsToProtectedResource = Boolean(
                owner && (
                    (owner.namespace && linux.isProtectedLinuxName(owner.namespace))
                    || (owner.interfaceName && linux.isProtectedLinuxName(owner.interfaceName))
                ),
            );
            if (inspection.externalConflict && (!owner || ownerPointsToProtectedResource)) {
                this.state = "blocked_external";
                this.externalReason = inspection.reason || "interface ou namespace externo está ativo";
                this.setDiagnostic("ownership", false, this.externalReason);
                this.options.log("warn", "boot Linux preservou recurso de rede externo", { mode: "diagnostic-only" });
                return;
            }
            if (!owner?.namespace || !owner.interfaceName) {
                if (inspection.active) {
                    this.state = "recovery_required";
                    this.setDiagnostic("ownership", false, inspection.reason || "resíduo do namespace Linux sem owner");
                    this.options.log("warn", "boot Linux encontrou namespace residual sem owner; cleanup adiado", { mode: "diagnostic-only" });
                    return;
                }
                if (owner && !await this.releaseOwnership(owner)) {
                    this.state = "recovery_required";
                    this.setDiagnostic("ownership", false, "o owner Linux não contém um namespace recuperável");
                    return;
                }
                const dependencyIssues = linux.linuxDependencyIssues();
                if (dependencyIssues.length > 0) {
                    this.state = "dependency_missing";
                    this.externalReason = dependencyIssues[0];
                    this.setDiagnostic("dependency", false, dependencyIssues.join(" "));
                    return;
                }
                this.state = "inactive";
                return;
            }

            if (!inspection.active) {
                const relaunchWasNotConfirmed = owner.restarting === true;
                if (relaunchWasNotConfirmed) this.automaticBootSuppressed = true;
                if (!await this.releaseOwnership(owner)) {
                    this.state = "recovery_required";
                    this.setDiagnostic("ownership", false, "não foi possível liberar o owner Linux após a perda do namespace");
                    return;
                }
                this.state = relaunchWasNotConfirmed ? "recovery_required" : "inactive";
                if (relaunchWasNotConfirmed)
                    this.setDiagnostic("ownership", false, "o relaunch Linux não confirmou o namespace; ativação automática suspensa");
                else {
                    const dependencyIssues = linux.linuxDependencyIssues();
                    if (dependencyIssues.length > 0) {
                        this.state = "dependency_missing";
                        this.externalReason = dependencyIssues[0];
                        this.setDiagnostic("dependency", false, dependencyIssues.join(" "));
                    }
                }
                return;
            }
            if (!linux.isProcessInNamespace(owner.namespace)) {
                if (owner.pid !== process.pid && processAlive(owner.pid)) {
                    this.state = "blocked_external";
                    this.externalReason = "outra instância do GoLiveBypass ainda possui o namespace Linux";
                    this.setDiagnostic("ownership", false, this.externalReason);
                    return;
                }
                this.automaticBootSuppressed = true;
                this.state = "recovery_required";
                this.setDiagnostic("ownership", false, "o namespace Linux próprio existe, mas este processo está fora dele");
                this.options.log("warn", "boot Linux aguardará ativação explícita para recriar o namespace", { mode: "diagnostic-only" });
                return;
            }

            this.generation = Math.max(this.generation, owner.generation);
            await this.adoptLinuxOwnership(owner);
            this.state = "active";
            this.discordPid = process.pid;
            this.diagnosticGeneration++;
            this.startWatchdog();
            this.startDiagnostics("adoption");
            this.options.log("info", "sessão WireGuard Linux própria adotada após inicialização", { generation: this.generation, namespace: owner.namespace });
        } catch (error) {
            this.initialized = false;
            this.state = "recovery_required";
            this.setDiagnostic("ownership", false, errorMessage(error));
            this.options.log("error", "falha ao recuperar sessão VPN Linux no boot", { erro: errorMessage(error) });
        }
    }
    private getLinuxStatus(): VpnStatus {
        if (!isSupportedLinuxArchitecture(process.platform, process.arch)) {
            return {
                state: "dependency_missing",
                platform: "unsupported",
                architecture: process.arch,
                owned: false,
                active: false,
                generation: this.generation,
                discordPid: null,
                profilePath: null,
                configPath: null,
                externalReason: "O transporte Linux do plugin exige Linux x64.",
                lastDiagnostic: this.lastDiagnostic,
                message: "Linux x64 necessário",
            };
        }

        const owner = this.readOwner();
        const inspection = linux.inspectLinuxNetworkSync(owner);
        const ownerPointsToProtectedResource = Boolean(
            owner && (
                (owner.namespace && linux.isProtectedLinuxName(owner.namespace))
                || (owner.interfaceName && linux.isProtectedLinuxName(owner.interfaceName))
            ),
        );
        const externalBlocked = inspection.externalConflict && (!owner || ownerPointsToProtectedResource);
        const inside = Boolean(owner?.namespace && linux.isProcessInNamespace(owner.namespace));
        const active = this.state === "active"
            && inspection.reliable
            && inspection.active
            && inspection.owned
            && inside
            && !externalBlocked;
        const dependencyIssues = linux.linuxDependencyIssues();
        const reportedState: VpnState = externalBlocked
            ? "blocked_external"
            : this.state === "active" && !active
                ? inspection.reliable && !inspection.active ? "inactive" : "restart_pending"
                : this.state === "inactive" && !inspection.active && dependencyIssues.length > 0
                    ? "dependency_missing"
                    : this.state;
        const externalReason = externalBlocked
            ? inspection.reason || "interface ou namespace externo está ativo"
            : inspection.reliable ? (this.externalReason || null) : inspection.reason || "estado do namespace Linux desconhecido";
        const message = reportedState === "inactive"
            ? "VPN inativa"
            : reportedState === "blocked_external"
                ? externalReason || "Recurso VPN externo está ativo"
                : reportedState === "dependency_missing"
                    ? externalReason || dependencyIssues[0] || "Dependência Linux ausente"
                    : this.statusMessage();
        return {
            state: reportedState,
            platform: "linux",
            architecture: process.arch,
            owned: Boolean(owner && inspection.owned && !externalBlocked),
            active,
            generation: this.generation,
            discordPid: this.discordPid,
            profilePath: fs.existsSync(this.profilePath) ? this.profilePath : null,
            configPath: owner?.namespace ? this.serviceConfigPath : null,
            namespace: owner?.namespace ?? null,
            interfaceName: owner?.interfaceName ?? null,
            requiresRelaunch: Boolean(owner?.namespace && inspection.active && inspection.owned && !inside && !externalBlocked),
            dependencies: dependencyIssues,
            externalReason,
            lastDiagnostic: this.lastDiagnostic,
            message,
        };
    }

    public getStatus(): VpnStatus {
        if (isLinux()) return this.getLinuxStatus();
        if (!isSupportedWindowsArchitecture(process.platform, process.arch)) {
            return {
                state: "blocked_external",
                platform: "unsupported",
                architecture: process.arch,
                owned: false,
                active: false,
                generation: this.generation,
                discordPid: null,
                profilePath: null,
                configPath: null,
                externalReason: "A VPN do plugin nesta versão está disponível somente no Windows x64.",
                lastDiagnostic: this.lastDiagnostic,
                message: "Windows x64 necessário",
            };
        }
        const inspection = windows.inspectWireSock(this.serviceConfigPath);
        if (isUnknownWireSockInspection(inspection)) {
            const message = this.state === "active" || this.state === "restart_pending"
                ? unknownWireSockMessage(inspection)
                : this.statusMessage();
            return {
                state: this.state,
                platform: "windows",
                architecture: process.arch,
                owned: false,
                active: false,
                generation: this.generation,
                discordPid: this.discordPid,
                profilePath: fs.existsSync(this.profilePath) ? this.profilePath : null,
                configPath: fs.existsSync(this.serviceConfigPath) ? this.serviceConfigPath : null,
                externalReason: null,
                lastDiagnostic: this.lastDiagnostic,
                message,
            };
        }
        if (inspection.reliable && inspection.active && !inspection.owned) {
            const reason = inspection.reason || "WireSock externo está ativo.";
            if (this.state !== "blocked_external" || this.externalReason !== reason) this.blockExternal(reason);
        }
        const active = this.state === "active" && inspection.active && inspection.owned;
        const reportedState: VpnState = this.state === "active" && !inspection.active ? "inactive" : this.state;
        return {
            state: reportedState,
            platform: "windows",
            architecture: process.arch,
            owned: inspection.owned && (active || this.readOwner() !== null),
            active,
            generation: this.generation,
            discordPid: this.discordPid,
            profilePath: fs.existsSync(this.profilePath) ? this.profilePath : null,
            configPath: fs.existsSync(this.serviceConfigPath) ? this.serviceConfigPath : null,
            externalReason: this.externalReason,
            lastDiagnostic: this.lastDiagnostic,
            message: reportedState === "inactive" ? "VPN inativa" : this.statusMessage(),
        };
    }

    public enable(): Promise<VpnOperationResult> {
        this.automaticBootSuppressed = false;
        return this.serial(() => this.startInternal(true));
    }

    public shutdown(relaunch = true): Promise<VpnOperationResult> {
        this.cancelProtonLogin();
        this.optimization?.controller.abort();
        return this.serial(() => this.stopInternal(relaunch));
    }

    public restoreNetwork(): Promise<VpnOperationResult> {
        this.cancelProtonLogin();
        this.optimization?.controller.abort();
        return this.serial(() => this.stopInternal(isLinux()));
    }

    public restartDiscord(): Promise<VpnOperationResult> {
        this.cancelProtonLogin();
        this.optimization?.controller.abort();
        return this.serial(() => this.restartInternal());
    }

    public async importCustomConfig(sourcePath: string): Promise<{ success: boolean; error?: string; path?: string }> {
        try {
            if (!isWindows() && !isLinux()) throw new Error("O transporte VPN do plugin exige Windows x64 ou Linux x64.");
            const source = path.resolve(sourcePath.trim());
            if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("Arquivo WireGuard não encontrado.");
            const raw = fs.readFileSync(source, "utf8");
            const validation = validateWireGuardConfig(raw);
            if (!validation.valid) throw new Error(validation.error);
            this.clearProtonProfileAccount();
            this.writeProfileAtomically(raw);
            return { success: true, path: this.profilePath };
        } catch (error) {
            return { success: false, error: errorMessage(error) };
        }
    }

    public testConfig(sourcePath?: string): { success: boolean; error?: string; path?: string } {
        try {
            const target = sourcePath?.trim() ? path.resolve(sourcePath.trim()) : this.profilePath;
            if (!fs.existsSync(target)) throw new Error("Nenhuma configuração WireGuard foi encontrada.");
            const validation = validateWireGuardConfig(fs.readFileSync(target, "utf8"));
            if (!validation.valid) throw new Error(validation.error);
            return { success: true, path: target };
        } catch (error) {
            return { success: false, error: errorMessage(error) };
        }
    }

    public loginProton(payload: ProtonLoginPayload, solveCaptcha: (url: string, signal: AbortSignal) => Promise<string | null>): Promise<proton.ProtonLoginResult> {
        if (this.protonLogin) {
            const message = "Já existe um login Proton em andamento.";
            return Promise.resolve({ success: false, code: "CONFIGURATION_ERROR", message, error: message, retryable: true });
        }

        const operation = { id: normalizeLoginRequestId(payload.requestId), controller: new AbortController() };
        this.protonLogin = operation;
        return this.serial(async () => {
            const isCurrent = () => this.protonLogin === operation && !operation.controller.signal.aborted;
            try {
                if (!isCurrent()) return cancelledLoginResult();
                const username = normalizeUsername(payload.username);
                const previousUsername = normalizeUsername(proton.savedSessionUsername(this.dataDir) || this.settings().protonUsername);
                const switchingAccount = Boolean(previousUsername && username && previousUsername.toLowerCase() !== username.toLowerCase());
                const currentStatus = switchingAccount ? this.getStatus() : null;
                if (switchingAccount && (currentStatus?.active || this.state === "active")) {
                    const message = "Restaure a rede antes de trocar a conta Proton.";
                    return { success: false, code: "CONFIGURATION_ERROR", message, error: message, retryable: false };
                }

                let result = await proton.loginProton(this.dataDir, username, payload.password, payload.twoFactorCode, undefined, this.options.log);
                if (!isCurrent()) return cancelledLoginResult();
                for (let attempt = 0; attempt < 3 && (result.code === "CAPTCHA_REQUIRED" || result.code === "CAPTCHA_INVALID"); attempt++) {
                    if (!result.captchaUrl) break;
                    const token = await solveCaptcha(result.captchaUrl, operation.controller.signal);
                    if (!isCurrent()) return cancelledLoginResult();
                    if (!token) return { success: false, code: "CAPTCHA_CANCELLED", message: "A verificação Proton foi cancelada.", retryable: true };
                    result = await proton.loginProton(this.dataDir, username, payload.password, payload.twoFactorCode, token, this.options.log);
                    if (!isCurrent()) return cancelledLoginResult();
                }
                if (result.success && switchingAccount) {
                    try {
                        this.clearProtonProfileAccount();
                        this.options.log("info", "marcador do perfil Proton invalidado após troca de conta");
                    } catch (error) {
                        // A ausência do marcador também força regeneração; não transforma
                        // uma sessão autenticada em falha por um cleanup opcional.
                        this.options.log("warn", "não consegui limpar o marcador do perfil Proton", { erro: errorMessage(error) });
                    }
                }
                return result;
            } finally {
                if (this.protonLogin === operation) this.protonLogin = null;
            }
        });
    }

    public cancelProtonLogin(requestId?: string): boolean {
        const operation = this.protonLogin;
        if (!operation) return false;
        if (typeof requestId === "string" && requestId.trim() && operation.id !== requestId.trim()) return false;
        operation.controller.abort();
        // Este caminho é deliberadamente fora da fila serial: o login pode estar
        // bloqueado aguardando o CAPTCHA e a fila não teria como cancelá-lo.
        proton.cancelProtonLogin(this.dataDir);
        return true;
    }

    public checkProtonSession(username: string) {
        return proton.checkProtonSession(this.dataDir, normalizeUsername(username));
    }

    public getProtonPlan(username: string) {
        return proton.getProtonPlan(this.dataDir, normalizeUsername(username), this.options.log);
    }

    public logoutProton(): Promise<{ success: boolean; error?: string }> {
        return this.serial(async () => {
            const owner = this.readOwner();
            if (isLinux()) {
                const inspection = linux.inspectLinuxNetworkSync(owner);
                if (!inspection.reliable)
                    return { success: false, error: inspection.reason || "Não foi possível confirmar o namespace Linux." };
                if (inspection.active || owner || this.state !== "inactive")
                    return { success: false, error: "Restaure a rede antes de sair da conta Proton." };
            } else {
                const inspection = windows.inspectWireSock(this.serviceConfigPath);
                if (isUnknownWireSockInspection(inspection))
                    return { success: false, error: unknownWireSockMessage(inspection) };
                if (inspection.active || owner || this.state !== "inactive")
                    return { success: false, error: "Restaure a rede antes de sair da conta Proton." };
            }

            try {
                const settings = this.settings();
                // O perfil e a configuração do serviço contêm a PrivateKey. Só
                // removemos esses arquivos quando o modo Proton os gerou; um
                // .conf personalizado nunca deve ser apagado pelo logout.
                if (!proton.removeProtonSession(this.dataDir))
                    return { success: false, error: "Não foi possível remover a sessão Proton do armazenamento local." };
                if (settings.mode === "proton") this.clearProtonArtifacts();
                return { success: true };
            } catch (error) {
                this.options.log("warn", "não consegui concluir o logout Proton", { erro: errorMessage(error) });
                return { success: false, error: "Não foi possível limpar todos os dados locais da sessão Proton." };
            }
        });
    }

    public async optimizeProton(options: ProtonOptimizationOptions): Promise<proton.ProtonOptimizationResult & { cancelled?: boolean; deferred?: boolean }> {
        if (!isSupportedVpnArchitecture(process.platform, process.arch)) return { success: false, error: "A VPN do plugin exige Windows x64 ou Linux x64." };
        if (this.optimization) return { success: false, error: "Já existe uma otimização Proton em andamento." };

        const id = options.requestId || `proton-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const operationController = new AbortController();
        this.optimization = { id, controller: operationController };

        return this.serial(async () => {
            try {
                const settings = this.settings();
                const username = normalizeUsername(settings.protonUsername);
                if (!username) return { success: false, error: "Faça login com sua conta Proton antes de otimizar a rota." };
                const selection: ProtonProfileSelection = {
                    country: normalizeCountry(options.country ?? settings.protonCountry),
                    freeOnly: options.freeOnly ?? settings.protonFreeOnly,
                    autoPing: options.autoPing ?? settings.protonAutoPing,
                };

                const status = this.getStatus();
                const wasActive = status.active;
                if (status.state === "blocked_external" || this.state === "blocked_external")
                    return { success: false, error: status.externalReason || this.externalReason || "Túnel externo está ativo." };
                if (isLinux() && status.requiresRelaunch)
                    return { success: false, error: "Reinicie o Discord para entrar no namespace Linux antes de otimizar a rota." };

                const restorePreviousRoute = async (): Promise<string | null> => {
                    if (!wasActive) return null;
                    const restored = await this.startInternal(false);
                    return restored.success ? null : restored.error || "Não foi possível reativar a rota WireGuard anterior.";
                };

                if (operationController.signal.aborted) return { success: false, cancelled: true, error: "Otimização Proton cancelada." };
                // Linux cannot return this process to the host namespace after
                // removing its tunnel. Keep the current route while measuring;
                // the successful path below performs a single stop + external
                // relaunch so the next process can activate the new profile.
                if (wasActive && !isLinux()) {
                    const stopped = await this.stopInternal(false);
                    if (!stopped.success) return { success: false, error: stopped.error || "Não foi possível pausar a VPN para otimizar a rota." };
                    if (operationController.signal.aborted) {
                        const restoreError = await restorePreviousRoute();
                        return { success: false, cancelled: true, error: restoreError || "Otimização Proton cancelada." };
                    }
                }

                let result: proton.ProtonOptimizationResult;
                try {
                    result = await proton.generateOptimalProtonConfig(this.dataDir, {
                        username,
                        country: selection.country,
                        freeOnly: selection.freeOnly,
                        autoPing: selection.autoPing,
                        speedTest: options.speedTest === true,
                        signal: operationController.signal,
                        onProgress: progress => options.onProgress?.({ ...progress, requestId: id }),
                        log: this.options.log,
                    });
                    if (result.success) this.writeProtonProfileAccount(username, selection);
                } catch (error) {
                    if (wasActive && !isLinux()) {
                        const restoreError = await restorePreviousRoute();
                        if (restoreError) this.options.log("error", "otimização falhou e a rota anterior não voltou", { erro: restoreError });
                    }
                    throw error;
                }
                if (operationController.signal.aborted) {
                    const restoreError = wasActive && !isLinux() ? await restorePreviousRoute() : null;
                    return { success: false, cancelled: true, error: restoreError || "Otimização Proton cancelada." };
                }
                if (result.success && wasActive) {
                    if (isLinux()) {
                        const stopped = await this.stopInternal(true);
                        if (!stopped.success) return { ...result, success: false, error: stopped.error || "A rota foi otimizada, mas não consegui relançar o Discord fora do namespace Linux." };
                        return { ...result, deferred: true, message: "Rota Proton otimizada; o Discord será relançado para aplicar a nova configuração." };
                    }
                    const restartError = await restorePreviousRoute();
                    if (restartError) return { ...result, success: false, error: restartError };
                } else if (!result.success && wasActive && !isLinux()) {
                    const restoreError = await restorePreviousRoute();
                    if (restoreError) return { ...result, error: `${result.error || "A otimização falhou."} ${restoreError}` };
                }
                return result;
            } finally {
                if (this.optimization?.id === id) this.optimization = null;
            }
        });
    }

    public cancelOptimization(requestId: string): boolean {
        if (!this.optimization || this.optimization.id !== requestId) return false;
        this.optimization.controller.abort();
        return true;
    }

    private settings(): VpnSettings {
        const raw = this.options.readSettings();
        const settings = normalizeVpnSettings(raw);
        if (!settings.protonUsername) settings.protonUsername = proton.savedSessionUsername(this.dataDir);
        return settings;
    }

    private serial<T>(operation: () => Promise<T>): Promise<T> {
        const current = this.operationQueue.catch(() => {}).then(operation);
        this.operationQueue = current.catch(() => {});
        return current;
    }

    private statusMessage(): string {
        switch (this.state) {
            case "active": return "VPN WireGuard ativa para este Discord";
            case "authorizing": return "Solicitando autorização administrativa";
            case "preparing": return "Preparando perfil e WireGuard";
            case "starting": return "Iniciando túnel WireGuard";
            case "restart_pending": return "VPN preparada; reiniciando Discord";
            case "stopping": return "Restaurando rede normal";
            case "blocked_external": return this.externalReason || "Recurso VPN externo está ativo";
            case "dependency_missing": return this.externalReason || "Dependência Linux ausente";
            case "recovery_required": return "A rede precisa de recuperação manual";
            default: return "VPN inativa";
        }
    }

    private setDiagnostic(kind: VpnDiagnostic["kind"], ok: boolean, detail: unknown): void {
        this.lastDiagnostic = { at: new Date().toISOString(), kind, ok, detail: safeDiagnosticDetail(detail) };
    }

    private blockExternal(reason: string): void {
        this.state = "blocked_external";
        this.externalReason = safeDiagnosticDetail(reason);
        this.diagnosticGeneration++;
        this.setDiagnostic("ownership", false, this.externalReason);
        this.stopWatchdog();
        this.options.log("warn", "VPN recusada para preservar WireSock externo", { motivo: this.externalReason });
    }

    private async startInternal(relaunch: boolean): Promise<VpnOperationResult> {
        if (isLinux()) return this.startLinuxInternal(relaunch);
        if (!isSupportedWindowsArchitecture(process.platform, process.arch)) {
            this.state = "blocked_external";
            this.externalReason = "A VPN do plugin nesta versão está disponível somente no Windows x64.";
            return { success: false, state: this.state, error: this.externalReason };
        }
        const existing = windows.inspectWireSock(this.serviceConfigPath);
        if (isUnknownWireSockInspection(existing)) {
            this.state = "recovery_required";
            this.externalReason = null;
            const error = unknownWireSockMessage(existing);
            this.setDiagnostic("ownership", false, error);
            this.options.log("warn", "ativação adiada porque o estado do WireSock é desconhecido", { mode: "diagnostic-only" });
            return { success: false, state: this.state, error };
        }
        if (existing.active && existing.owned) {
            if (this.state !== "active") {
                const owner = this.readOwner();
                this.generation = Math.max(this.generation, owner?.generation ?? 0);
                const adopted = await this.claimActiveOwnership(owner, existing);
                if (adopted.probePath) await this.cleanupStaleProbes([adopted.probePath]);
                this.state = "active";
                this.discordPid = process.pid;
                this.diagnosticGeneration++;
                this.startWatchdog();
                this.startDiagnostics("adoption");
            }
            return { success: true, state: "active", message: this.statusMessage() };
        }
        if (existing.active && !existing.owned) {
            this.blockExternal(existing.reason || "WireSock externo está ativo.");
            return { success: false, state: this.state, error: this.externalReason || undefined };
        }

        this.state = "preparing";
        this.externalReason = null;
        this.generation++;
        this.diagnosticGeneration++;
        let owner: VpnOwnerRecord | null = null;
        let started = false;
        try {
            await this.migrateGuiState();
            owner = await this.acquireOwnership();
            await this.cleanupStaleProbes(this.probePath ? [this.probePath] : []);
            const settings = this.settings();
            if (settings.mode === "proton") {
                if (!settings.protonUsername) throw new Error("Faça login com sua conta Proton antes de ativar.");
                const selection = this.protonProfileSelection(settings);
                if (!fs.existsSync(this.profilePath) || !this.protonProfileMatches(settings.protonUsername, selection)) {
                    const generated = await proton.generateOptimalProtonConfig(this.dataDir, {
                        username: settings.protonUsername,
                        country: selection.country,
                        freeOnly: selection.freeOnly,
                        autoPing: selection.autoPing,
                        log: this.options.log,
                    });
                    if (!generated.success) throw new Error(generated.error || "Não foi possível gerar a configuração Proton.");
                    this.writeProtonProfileAccount(settings.protonUsername, selection);
                }
            } else {
                if (!settings.customConfigPath) throw new Error("Configure um arquivo WireGuard personalizado antes de ativar.");
                const imported = await this.importCustomConfig(settings.customConfigPath);
                if (!imported.success) throw new Error(imported.error);
            }
            const raw = fs.readFileSync(this.profilePath, "utf8");
            const validation = windows.validateWireGuardProfile(raw);
            if (!validation.valid) throw new Error(validation.error);

            const apps = this.discordAllowedApps();
            const probe = this.prepareRouteProbe();
            if (probe) apps.push(probe);
            owner.probePath = probe;
            await this.writeOwner(owner);
            this.state = "starting";
            const startedResult = await windows.startWireSockService(this.serviceConfigPath, raw, apps, this.options.log);
            started = true;
            owner.configPath = startedResult.configPath;
            owner.restarting = relaunch;
            await this.writeOwner(owner);
            this.discordPid = process.pid;
            this.state = relaunch ? "restart_pending" : "active";
            this.startWatchdog();
            this.startDiagnostics("activation");
            if (relaunch) {
                if (!await this.requestRelaunch()) {
                    this.state = "active";
                    owner.restarting = false;
                    await this.writeOwner(owner);
                    return { success: false, state: this.state, error: "A VPN foi iniciada, mas não consegui reiniciar o Discord para aplicar a rota." };
                }
                return { success: true, state: "restart_pending", message: "VPN preparada; o Discord será reiniciado." };
            }
            return { success: true, state: "active", message: this.statusMessage() };
        } catch (error) {
            this.stopWatchdog();
            const currentInspection = windows.inspectWireSock(this.serviceConfigPath);
            if (started || (currentInspection.reliable && currentInspection.active)) {
                const cleanup = await windows.stopOwnedWireSock(this.serviceConfigPath, this.options.log);
                if (!cleanup.stopped) {
                    await this.removeProbe({ sweep: false });
                    this.state = "recovery_required";
                    this.setDiagnostic("wireguard", false, cleanup.error || "limpeza incompleta");
                    return { success: false, state: this.state, error: `A ativação falhou e a rede não foi restaurada: ${cleanup.error || "limpeza incompleta"}.` };
                }
                await this.removeProbe({ sweep: true });
            } else {
                await this.removeProbe({ sweep: true });
            }
            const message = errorMessage(error);
            if (owner && !await this.releaseOwnership(owner)) {
                this.state = "recovery_required";
                this.setDiagnostic("ownership", false, "não foi possível liberar o lock após falha de ativação");
                return { success: false, state: this.state, error: `${message} O lock da VPN ficou pendente e requer recuperação.` };
            }
            this.state = "inactive";
            this.diagnosticGeneration++;
            this.setDiagnostic("wireguard", false, message);
            this.options.log("error", "ativação VPN falhou", { erro: message });
            return { success: false, state: this.state, error: message };
        }
    }

    private async startLinuxInternal(relaunch: boolean): Promise<VpnOperationResult> {
        if (!isSupportedLinuxArchitecture(process.platform, process.arch)) {
            this.state = "dependency_missing";
            this.externalReason = "O transporte Linux do plugin exige arquitetura x64.";
            this.setDiagnostic("dependency", false, this.externalReason);
            return { success: false, state: this.state, error: this.externalReason };
        }

        const existing = this.readOwner();
        const existingInspection = linux.inspectLinuxNetworkSync(existing);
        if (!existingInspection.reliable) {
            this.state = "recovery_required";
            this.setDiagnostic("wireguard", false, existingInspection.reason || "estado do namespace Linux desconhecido");
            return { success: false, state: this.state, error: existingInspection.reason || undefined };
        }
        const ownerPointsToProtectedResource = Boolean(
            existing && (
                (existing.namespace && linux.isProtectedLinuxName(existing.namespace))
                || (existing.interfaceName && linux.isProtectedLinuxName(existing.interfaceName))
            ),
        );
        if (existingInspection.externalConflict && (!existing || ownerPointsToProtectedResource)) {
            this.state = "blocked_external";
            this.externalReason = existingInspection.reason || "interface ou namespace externo está ativo";
            this.setDiagnostic("ownership", false, this.externalReason);
            this.options.log("warn", "ativação Linux recusada para preservar túnel externo", { mode: "diagnostic-only" });
            return { success: false, state: this.state, error: this.externalReason };
        }
        if (existingInspection.active && existing?.namespace && existing.interfaceName) {
            if (linux.isProcessInNamespace(existing.namespace)) {
                this.generation = Math.max(this.generation, existing.generation);
                await this.adoptLinuxOwnership(existing);
                this.state = "active";
                this.discordPid = process.pid;
                this.diagnosticGeneration++;
                this.startWatchdog();
                this.startDiagnostics("adoption");
                return { success: true, state: "active", message: this.statusMessage() };
            }
            if (this.isLiveForeignOwner(existing)) {
                this.state = "blocked_external";
                this.externalReason = "outra instância do GoLiveBypass ainda controla o namespace Linux";
                this.setDiagnostic("ownership", false, this.externalReason);
                return { success: false, state: this.state, error: this.externalReason };
            }
        }

        this.state = "preparing";
        this.externalReason = null;
        this.generation++;
        this.diagnosticGeneration++;
        let owner: VpnOwnerRecord | null = null;
        let started = false;
        try {
            const dependencies = await linux.linuxDependencyStatus(false);
            if (!dependencies.ok) {
                const detail = dependencies.error || dependencies.missing.join(", ") || "dependência Linux ausente";
                this.state = "dependency_missing";
                this.externalReason = detail;
                this.setDiagnostic("dependency", false, detail);
                return { success: false, state: this.state, error: detail };
            }

            this.state = "authorizing";
            const authorization = await linux.requestLinuxAuthorization();
            if (!authorization.authorized) {
                const code = authorization.code === "CANCELLED"
                    ? "AUTHORIZATION_CANCELLED"
                    : authorization.code === "TIMEOUT"
                        ? "AUTHORIZATION_TIMEOUT"
                        : "AUTHORIZATION_FAILED";
                const detail = authorization.error || "Não foi possível obter autorização administrativa via polkit.";
                this.state = "inactive";
                this.diagnosticGeneration++;
                this.setDiagnostic("dependency", false, detail);
                this.options.log("warn", "autorização administrativa Linux recusada", { code });
                return { success: false, state: this.state, code, error: detail };
            }
            this.state = "preparing";

            if (existingInspection.active) {
                const cleanupTarget = existing?.namespace && existing.interfaceName
                    ? existing
                    : existingInspection.namespace?.startsWith("gl-ns-")
                        ? { namespace: existingInspection.namespace }
                        : null;
                if (!cleanupTarget) {
                    this.state = "recovery_required";
                    const detail = existingInspection.reason || "recurso Linux ativo sem owner seguro";
                    this.setDiagnostic("ownership", false, detail);
                    return { success: false, state: this.state, error: detail };
                }
                const cleanup = await linux.stopLinuxNetwork(cleanupTarget, { log: this.options.log });
                if (!cleanup.stopped) throw new Error(cleanup.error || "não foi possível remover a sessão Linux anterior");
                if (existing && !await this.releaseOwnership(existing)) throw new Error("não foi possível liberar o owner Linux anterior");
            } else if (existing && !await this.releaseOwnership(existing)) {
                throw new Error("não foi possível liberar o owner Linux anterior");
            }

            owner = await this.acquireLinuxOwnership();
            const settings = this.settings();
            if (settings.mode === "proton") {
                if (!settings.protonUsername) throw new Error("Faça login com sua conta Proton antes de ativar.");
                const selection = this.protonProfileSelection(settings);
                if (!fs.existsSync(this.profilePath) || !this.protonProfileMatches(settings.protonUsername, selection)) {
                    const generated = await proton.generateOptimalProtonConfig(this.dataDir, {
                        username: settings.protonUsername,
                        country: selection.country,
                        freeOnly: selection.freeOnly,
                        autoPing: selection.autoPing,
                        log: this.options.log,
                    });
                    if (!generated.success) throw new Error(generated.error || "Não foi possível gerar a configuração Proton.");
                    this.writeProtonProfileAccount(settings.protonUsername, selection);
                }
            } else {
                if (!settings.customConfigPath) throw new Error("Configure um arquivo WireGuard personalizado antes de ativar.");
                const imported = await this.importCustomConfig(settings.customConfigPath);
                if (!imported.success) throw new Error(imported.error);
            }

            const raw = fs.readFileSync(this.profilePath, "utf8");
            const validation = validateWireGuardConfig(raw);
            if (!validation.valid) throw new Error(validation.error);
            this.state = "starting";
            await linux.startLinuxNetwork(owner, raw, this.dataDir, {
                namespace: owner.namespace,
                interfaceName: owner.interfaceName,
                log: this.options.log,
            });
            started = true;
            owner.restarting = relaunch;
            await this.writeOwner(owner);
            this.discordPid = process.pid;
            this.state = relaunch ? "restart_pending" : "active";
            this.startWatchdog();
            this.startDiagnostics("activation");
            if (relaunch) {
                if (!await this.requestRelaunch()) {
                    const cleanup = await linux.stopLinuxNetwork(owner, { log: this.options.log });
                    if (!cleanup.stopped) this.state = "recovery_required";
                    else {
                        await this.releaseOwnership(owner);
                        this.state = "inactive";
                    }
                    return { success: false, state: this.state, error: "A VPN foi iniciada, mas não consegui relançar o Discord dentro do namespace Linux." };
                }
                return { success: true, state: "restart_pending", message: "VPN preparada; o Discord será relançado dentro do namespace Linux." };
            }
            return { success: true, state: "active", message: this.statusMessage() };
        } catch (error) {
            this.stopWatchdog();
            if (owner && (started || linux.inspectLinuxNetworkSync(owner).active)) {
                const cleanup = await linux.stopLinuxNetwork(owner, { log: this.options.log });
                if (!cleanup.stopped) {
                    this.state = "recovery_required";
                    this.setDiagnostic("wireguard", false, cleanup.error || "limpeza incompleta");
                    return { success: false, state: this.state, error: `A ativação falhou e a rede não foi restaurada: ${cleanup.error || "limpeza incompleta"}.` };
                }
            }
            const message = errorMessage(error);
            if (owner && !await this.releaseOwnership(owner)) {
                this.state = "recovery_required";
                this.setDiagnostic("ownership", false, "não foi possível liberar o owner Linux após falha de ativação");
                return { success: false, state: this.state, error: `${message} O owner ficou pendente e requer recuperação.` };
            }
            this.state = "inactive";
            this.diagnosticGeneration++;
            this.setDiagnostic("wireguard", false, message);
            this.options.log("error", "ativação VPN Linux falhou", { erro: message });
            return { success: false, state: this.state, error: message };
        }
    }

    private async stopInternal(relaunch: boolean): Promise<VpnOperationResult> {
        if (isLinux()) return this.stopLinuxInternal(relaunch);
        if (!isSupportedWindowsArchitecture(process.platform, process.arch)) return { success: false, state: "blocked_external", error: "A VPN do plugin nesta versão exige Windows x64." };
        this.stopWatchdog();
        this.diagnosticGeneration++;
        const inspection = windows.inspectWireSock(this.serviceConfigPath);
        if (isUnknownWireSockInspection(inspection)) {
            this.state = "recovery_required";
            this.externalReason = null;
            const error = unknownWireSockMessage(inspection);
            this.setDiagnostic("wireguard", false, error);
            this.options.log("warn", "restauração adiada porque o estado do WireSock é desconhecido", { mode: "diagnostic-only" });
            return { success: false, state: this.state, error };
        }
        const owner = this.readOwner();
        const needsInactiveCleanup = Boolean(owner)
            || this.state === "preparing"
            || this.state === "starting"
            || this.state === "stopping"
            || this.state === "restart_pending"
            || this.state === "recovery_required";
        if (!inspection.active && !needsInactiveCleanup) {
            await this.removeProbe({ staleOwner: owner, sweep: true });
            if (owner && !await this.releaseOwnership(owner)) {
                this.state = "recovery_required";
                this.setDiagnostic("ownership", false, "não foi possível liberar o lock durante a restauração");
                return { success: false, state: this.state, error: "A rede está inativa, mas o lock da VPN ficou pendente." };
            }
            this.state = "inactive";
            this.discordPid = null;
            return { success: true, state: this.state, message: this.statusMessage() };
        }
        if (inspection.reliable && inspection.active && !inspection.owned) {
            this.blockExternal(inspection.reason || "WireSock externo está ativo; não será interrompido.");
            return { success: false, state: this.state, error: this.externalReason || undefined };
        }
        this.state = "stopping";
        const cleanup = await windows.stopOwnedWireSock(this.serviceConfigPath, this.options.log);
        if (!cleanup.stopped) {
            await this.removeProbe({ sweep: false });
            this.state = "recovery_required";
            this.setDiagnostic("wireguard", false, cleanup.error || "limpeza incompleta");
            return { success: false, state: this.state, error: cleanup.error || "Não foi possível restaurar a rede." };
        }
        await this.removeProbe({ sweep: true });
        if (owner && !await this.releaseOwnership(owner)) {
            this.state = "recovery_required";
            this.setDiagnostic("ownership", false, "não foi possível liberar o lock durante a restauração");
            return { success: false, state: this.state, error: "A rede foi restaurada, mas o lock da VPN ficou pendente." };
        }
        this.discordPid = null;
        this.state = "inactive";
        this.externalReason = null;
        this.setDiagnostic("wireguard", true, "serviço WireSock próprio parado e rede restaurada");
        if (relaunch && !this.restarting) {
            if (!await this.requestRelaunch())
                return { success: false, state: this.state, error: "A rede foi restaurada, mas não consegui reiniciar o Discord." };
            return { success: true, state: "restart_pending", message: "Rede restaurada; o Discord será reiniciado." };
        }
        return { success: true, state: this.state, message: this.statusMessage() };
    }

    private async stopLinuxInternal(relaunch: boolean): Promise<VpnOperationResult> {
        this.stopWatchdog();
        this.diagnosticGeneration++;
        const owner = this.readOwner();
        const inspection = linux.inspectLinuxNetworkSync(owner);
        if (!inspection.reliable) {
            this.state = "recovery_required";
            this.setDiagnostic("wireguard", false, inspection.reason || "não foi possível confirmar o namespace Linux");
            return { success: false, state: this.state, error: inspection.reason || undefined };
        }
        const ownerPointsToProtectedResource = Boolean(
            owner && (
                (owner.namespace && linux.isProtectedLinuxName(owner.namespace))
                || (owner.interfaceName && linux.isProtectedLinuxName(owner.interfaceName))
            ),
        );
        if (inspection.externalConflict && (!owner || ownerPointsToProtectedResource)) {
            this.state = "blocked_external";
            this.externalReason = inspection.reason || "interface ou namespace externo está ativo";
            this.setDiagnostic("ownership", false, this.externalReason);
            return { success: false, state: this.state, error: this.externalReason };
        }
        if (owner && this.isLiveForeignOwner(owner)) {
            this.state = "blocked_external";
            this.externalReason = "outra instância do GoLiveBypass ainda controla o namespace Linux";
            this.setDiagnostic("ownership", false, this.externalReason);
            return { success: false, state: this.state, error: this.externalReason };
        }

        const cleanupTarget = owner
            || (inspection.namespace?.startsWith("gl-ns-") ? { namespace: inspection.namespace } : null);
        if (!cleanupTarget && inspection.active) {
            this.state = "recovery_required";
            const detail = inspection.reason || "recurso Linux ativo sem owner seguro";
            this.setDiagnostic("ownership", false, detail);
            return { success: false, state: this.state, error: detail };
        }
        if (!cleanupTarget && this.state === "inactive") {
            this.discordPid = null;
            return { success: true, state: this.state, message: this.statusMessage() };
        }

        this.state = "stopping";
        if (cleanupTarget) {
            const cleanup = await linux.stopLinuxNetwork(cleanupTarget, { log: this.options.log });
            if (!cleanup.stopped) {
                this.state = "recovery_required";
                this.setDiagnostic("wireguard", false, cleanup.error || "limpeza incompleta do namespace Linux");
                return { success: false, state: this.state, error: cleanup.error || "Não foi possível restaurar a rede Linux." };
            }
            if (owner && !await this.releaseOwnership(owner)) {
                this.state = "recovery_required";
                this.setDiagnostic("ownership", false, "não foi possível liberar o owner Linux durante a restauração");
                return { success: false, state: this.state, error: "A rede foi restaurada, mas o owner Linux ficou pendente." };
            }
        }
        this.discordPid = null;
        this.state = "inactive";
        this.externalReason = null;
        this.setDiagnostic("wireguard", true, "namespace WireGuard próprio removido e rede restaurada");
        if (relaunch && !this.restarting) {
            if (!await this.requestRelaunch())
                return { success: false, state: this.state, error: "A rede foi restaurada, mas não consegui relançar o Discord fora do namespace Linux." };
            return { success: true, state: "restart_pending", message: "Rede restaurada; o Discord será relançado fora do namespace Linux." };
        }
        return { success: true, state: this.state, message: this.statusMessage() };
    }

    private async restartLinuxInternal(): Promise<VpnOperationResult> {
        const owner = this.readOwner();
        const inspection = linux.inspectLinuxNetworkSync(owner);
        if (!inspection.reliable) {
            this.state = "recovery_required";
            this.setDiagnostic("wireguard", false, inspection.reason || "não foi possível confirmar o namespace Linux");
            return { success: false, state: this.state, error: inspection.reason || undefined };
        }
        const ownerPointsToProtectedResource = Boolean(
            owner && (
                (owner.namespace && linux.isProtectedLinuxName(owner.namespace))
                || (owner.interfaceName && linux.isProtectedLinuxName(owner.interfaceName))
            ),
        );
        if (inspection.externalConflict && (!owner || ownerPointsToProtectedResource)) {
            this.state = "blocked_external";
            this.externalReason = inspection.reason || "interface ou namespace externo está ativo";
            this.setDiagnostic("ownership", false, this.externalReason);
            return { success: false, state: this.state, error: this.externalReason };
        }
        if (owner?.namespace && owner.interfaceName && inspection.active && inspection.owned) {
            if (owner.pid !== process.pid && this.isLiveForeignOwner(owner)) {
                this.state = "blocked_external";
                this.externalReason = "outra instância do GoLiveBypass ainda controla o namespace Linux";
                this.setDiagnostic("ownership", false, this.externalReason);
                return { success: false, state: this.state, error: this.externalReason };
            }
            const currentOwner = owner.pid === process.pid ? owner : await this.adoptLinuxOwnership(owner);
            currentOwner.restarting = true;
            await this.writeOwner(currentOwner);
            this.state = "restart_pending";
            if (!await this.requestRelaunch(currentOwner.namespace)) {
                currentOwner.restarting = false;
                await this.writeOwner(currentOwner).catch(() => {});
                this.state = "active";
                return { success: false, state: this.state, error: "Não consegui relançar o Discord dentro do namespace Linux." };
            }
            return { success: true, state: "restart_pending", message: "O Discord será relançado mantendo a rota WireGuard Linux." };
        }
        if (!await this.requestRelaunch(null))
            return { success: false, state: this.state, error: "Não consegui relançar o Discord." };
        return { success: true, state: "restart_pending", message: "O Discord será relançado para aplicar a atualização." };
    }
    private async restartInternal(): Promise<VpnOperationResult> {
        if (isLinux()) return this.restartLinuxInternal();
        const cleanup = await this.stopInternal(false);
        if (!cleanup.success && this.state !== "blocked_external") return cleanup;
        if (!cleanup.success) {
            this.options.log("info", "reinício explícito preservou o WireSock externo; o plugin não é proprietário do túnel");
        }
        if (!await this.requestRelaunch())
            return { success: false, state: this.state, error: "A rede foi restaurada, mas não consegui reiniciar o Discord." };
        return { success: true, state: "restart_pending", message: "A rede foi restaurada; o Discord será reiniciado para aplicar a atualização." };
    }

    private discordAllowedApps(): string[] {
        const executable = path.resolve(process.execPath);
        const appDir = path.dirname(executable);
        const installRoot = path.dirname(appDir);
        const updater = path.join(installRoot, "Update.exe");
        const values = [executable];
        if (fs.existsSync(updater)) values.push(path.resolve(updater));
        return values;
    }

    private prepareRouteProbe(): string | undefined {
        try {
            const source = proton.findProtonConfgenExe();
            const target = windows.routeProbeExecutablePath(this.dataDir);
            windows.copyRouteProbe(source, target);
            this.probePath = target;
            return target;
        } catch (error) {
            this.options.log("warn", "helper de diagnóstico não foi incluído em AllowedApps", { erro: errorMessage(error) });
            return undefined;
        }
    }

    private trackRouteProbe(flight: Promise<void>): void {
        this.routeProbeFlights.add(flight);
        void flight.then(
            () => this.routeProbeFlights.delete(flight),
            () => this.routeProbeFlights.delete(flight),
        );
    }

    private async waitForRouteProbes(): Promise<void> {
        await Promise.allSettled([...this.routeProbeFlights]);
    }

    private reportProbeCleanup(stage: string, result: windows.RouteProbeCleanupResult): void {
        if (result.removed > 0) {
            this.options.log("info", "probes temporários de diagnóstico removidos", { stage, removidos: result.removed });
        }
        if (result.busy > 0 || result.invalid > 0) {
            this.options.log("warn", "cleanup de probes temporários incompleto", {
                stage,
                ocupados: result.busy,
                inválidos: result.invalid,
                recentes: result.recent,
            });
        }
    }

    private async cleanupStaleProbes(protectedPaths: readonly string[] = []): Promise<void> {
        await this.waitForRouteProbes();
        const result = await windows.cleanupRouteProbes(this.dataDir, protectedPaths);
        this.reportProbeCleanup("stale", result);
    }

    private async removeProbe(options: { staleOwner?: VpnOwnerRecord | null; sweep?: boolean } = {}): Promise<void> {
        await this.waitForRouteProbes();
        const localToken = this.ownershipToken;
        const current = this.readOwner();
        const candidates = new Set<string>();
        const canRemoveLocal = !current || sameOwnership(localToken, current);
        if (this.probePath && canRemoveLocal) candidates.add(this.probePath);
        if (current && sameOwnership(localToken, current) && current.probePath) candidates.add(current.probePath);
        const { staleOwner } = options;
        if (options.sweep && staleOwner?.probePath && (!current || sameOwnership(staleOwner, current)))
            candidates.add(staleOwner.probePath);

        for (const candidate of candidates) {
            if (!windows.isManagedRouteProbePath(this.dataDir, candidate)) continue;
            const removal = await windows.removeRouteProbe(this.dataDir, candidate);
            if (removal === "busy") this.options.log("warn", "probe temporário ainda está ocupado", { stage: "known" });
        }

        // Never sweep while another ownership token is visible. This keeps an
        // old Discord instance from deleting a probe created by its successor.
        const after = this.readOwner();
        const canSweep = options.sweep && (!after || sameOwnership(localToken, after) || sameOwnership(staleOwner, after));
        if (canSweep) {
            const protectedPaths = after?.probePath ? [after.probePath] : [];
            const result = await windows.cleanupRouteProbes(this.dataDir, protectedPaths);
            this.reportProbeCleanup("all", result);
        }
        this.probePath = undefined;
    }

    private startDiagnostics(stage: string): void {
        const { diagnosticGeneration } = this;
        const vpnGeneration = this.generation;
        const isCurrent = () => this.diagnosticGeneration === diagnosticGeneration
            && this.generation === vpnGeneration
            && (this.state === "active" || this.state === "restart_pending");
        if (isLinux()) {
            const owner = this.readOwner();
            const inspection = linux.inspectLinuxNetworkSync(owner);
            if (!isCurrent()) return;
            if (!inspection.reliable) {
                this.setDiagnostic("wireguard", false, `${stage}: ${inspection.reason || "estado do namespace Linux desconhecido"}`);
                this.options.log("warn", "diagnóstico Linux não conseguiu confirmar o namespace", { stage, mode: "diagnostic-only" });
                return;
            }
            const ok = inspection.active && inspection.owned;
            this.setDiagnostic("wireguard", ok, `${stage}: ${ok ? "namespace e interface WireGuard confirmados" : inspection.reason || "namespace ou interface WireGuard ausente"}`);
            if (!ok) this.options.log("warn", "diagnóstico Linux observou estado incompleto", { stage, mode: "diagnostic-only" });
            return;
        }

        void windows.diagnoseWindowsNetwork(this.options.log).then(result => {
            if (!isCurrent()) return;
            this.setDiagnostic("network", result.ok, `${stage}: ${result.detail}`);
        }).catch(error => {
            if (isCurrent()) this.setDiagnostic("network", false, error);
        });

        const owner = this.readOwner();
        const probePath = owner?.probePath;
        if (!probePath || !fs.existsSync(probePath)) return;
        const flight = windows.runRouteProbe(probePath).then(result => {
            if (!isCurrent()) return;
            this.setDiagnostic("route", Boolean(result?.success), safeDiagnosticDetail(JSON.stringify(result || { error: "resposta vazia" }), 500));
            this.options.log(result?.success ? "info" : "warn", "probe de rota do Discord concluído", { stage, result: safeDiagnosticDetail(JSON.stringify(result || {}), 500), mode: "log-only" });
        }).catch(error => {
            if (!isCurrent()) return;
            this.setDiagnostic("route", false, error);
            this.options.log("warn", "probe de rota do Discord falhou", { stage, erro: errorMessage(error), mode: "log-only" });
        });
        this.trackRouteProbe(flight);
    }

    private async checkLinuxWatchdog(): Promise<void> {
        if (this.watchdogChecking || this.state !== "active") return;
        this.watchdogChecking = true;
        const { diagnosticGeneration } = this;
        const vpnGeneration = this.generation;
        const isCurrent = () => this.diagnosticGeneration === diagnosticGeneration
            && this.generation === vpnGeneration
            && this.state === "active";
        try {
            const owner = this.readOwner();
            const inspection = linux.inspectLinuxNetworkSync(owner);
            if (!isCurrent()) return;
            if (!inspection.reliable) {
                this.setDiagnostic("wireguard", false, inspection.reason || "estado do namespace Linux desconhecido");
                this.options.log("warn", "watchdog Linux não conseguiu confirmar a VPN", { mode: "diagnostic-only" });
                return;
            }
            const ok = inspection.active && inspection.owned;
            this.setDiagnostic("wireguard", ok, ok ? "namespace WireGuard próprio confirmado" : inspection.reason || "namespace WireGuard ausente");
            if (!ok) this.options.log("warn", "watchdog Linux observou perda ou troca do túnel", { mode: "diagnostic-only" });
            if (ok) this.startDiagnostics("watchdog");
        } finally {
            this.watchdogChecking = false;
        }
    }

    private async checkWatchdog(): Promise<void> {
        if (isLinux()) {
            await this.checkLinuxWatchdog();
            return;
        }
        if (this.watchdogChecking || this.state !== "active") return;
        this.watchdogChecking = true;
        const { diagnosticGeneration } = this;
        const vpnGeneration = this.generation;
        const isCurrent = () => this.diagnosticGeneration === diagnosticGeneration
            && this.generation === vpnGeneration
            && this.state === "active";
        try {
            const inspection = windows.inspectWireSock(this.serviceConfigPath);
            if (!inspection.reliable) {
                if (isCurrent()) this.setDiagnostic("wireguard", false, inspection.reason || "Estado do WireSock desconhecido.");
                this.options.log("warn", "watchdog não conseguiu confirmar o estado do WireSock", { mode: "diagnostic-only" });
                return;
            }
            if (!inspection.active) {
                // WMI/sc.exe can briefly return an empty snapshot while the
                // service is still alive. Confirm across several samples for
                // evidence, but keep this probe diagnostic-only.
                let confirmation = inspection;
                for (let attempt = 0; attempt < 5 && confirmation.reliable && !confirmation.active; attempt++) {
                    await new Promise<void>(resolve => setTimeout(resolve, 1_000));
                    if (!isCurrent()) return;
                    confirmation = windows.inspectWireSock(this.serviceConfigPath);
                }
                if (!confirmation.reliable) {
                    if (isCurrent()) this.setDiagnostic("wireguard", false, confirmation.reason || "Estado do WireSock desconhecido.");
                    this.options.log("warn", "watchdog não confirmou ausência do WireSock porque a leitura ficou desconhecida", { mode: "diagnostic-only" });
                    return;
                }
                if (!confirmation.active) {
                    this.diagnosticGeneration++;
                    this.state = "inactive";
                    this.discordPid = null;
                    this.externalReason = null;
                    this.stopWatchdog();
                    this.setDiagnostic("wireguard", false, "serviço WireSock próprio desapareceu");
                    this.options.log("warn", "watchdog não confirmou o WireSock próprio", {
                        mode: "diagnostic-only",
                        services: confirmation.services,
                        processIds: confirmation.processIds,
                    });
                    return;
                }
                if (!confirmation.owned) {
                    this.blockExternal(confirmation.reason || "ownership do WireSock mudou");
                    return;
                }
                this.options.log("warn", "watchdog ignorou leitura transitória do WireSock", { mode: "diagnostic-only" });
                this.startDiagnostics("watchdog");
                return;
            }
            if (!inspection.owned) {
                this.blockExternal(inspection.reason || "ownership do WireSock mudou");
                return;
            }
            this.startDiagnostics("watchdog");
        } finally {
            this.watchdogChecking = false;
        }
    }

    private startWatchdog(): void {
        if (this.watchdog || (!isWindows() && !isLinux())) return;
        this.watchdog = setInterval(() => {
            void this.checkWatchdog();
        }, WATCHDOG_MS);
        this.watchdog.unref?.();
    }

    private stopWatchdog(): void {
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
    }

    private isLiveForeignOwner(owner: VpnOwnerRecord | null): boolean {
        return Boolean(owner && owner.pid !== process.pid && !owner.restarting && processAlive(owner.pid));
    }

    private ownerMutexPath(): string {
        return `${this.ownerPath}${OWNER_MUTEX_SUFFIX}`;
    }

    private readOwnerMutexHolder(mutexPath: string): { pid: number; token: string; acquiredAt: number } | null {
        try {
            const value = JSON.parse(fs.readFileSync(path.join(mutexPath, OWNER_MUTEX_HOLDER_FILE), "utf8")) as Partial<{
                pid: number;
                token: string;
                acquiredAt: number;
            }>;
            const { pid } = value;
            const { token } = value;
            const { acquiredAt } = value;
            if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof token !== "string" || !token
                || typeof acquiredAt !== "number" || !Number.isFinite(acquiredAt)) return null;
            return { pid, token, acquiredAt };
        } catch {
            return null;
        }
    }

    private ownerMutexIsStale(mutexPath: string): boolean {
        const holder = this.readOwnerMutexHolder(mutexPath);
        if (!holder) return false;
        const alive = holder.pid === process.pid || processAlive(holder.pid);
        if (alive) return false;
        try {
            const age = Date.now() - Math.max(holder.acquiredAt, fs.statSync(mutexPath).mtimeMs);
            return age > OWNER_MUTEX_STALE_MS;
        } catch {
            return false;
        }
    }

    private reclaimStaleOwnerMutex(mutexPath: string): boolean {
        if (!this.ownerMutexIsStale(mutexPath)) return false;
        const quarantine = `${mutexPath}.stale.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
        try {
            // Renomear primeiro evita que a remoção de um reclaim concorrente
            // alcance um mutex novo criado imediatamente no caminho original.
            fs.renameSync(mutexPath, quarantine);
            fs.rmSync(quarantine, { recursive: true, force: true });
            return true;
        } catch {
            try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch { }
            return false;
        }
    }

    private async acquireOwnerMutex(): Promise<{ path: string; token: string }> {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const mutexPath = this.ownerMutexPath();
        const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        for (let attempt = 0; attempt < OWNER_MUTEX_MAX_ATTEMPTS; attempt++) {
            let created = false;
            try {
                fs.mkdirSync(mutexPath);
                created = true;
                const holder = { pid: process.pid, token, acquiredAt: Date.now() };
                fs.writeFileSync(path.join(mutexPath, OWNER_MUTEX_HOLDER_FILE), JSON.stringify(holder), { encoding: "utf8", flag: "wx", mode: 0o600 });
                return { path: mutexPath, token };
            } catch (error) {
                if (created) {
                    try { fs.rmSync(mutexPath, { recursive: true, force: true }); } catch { }
                    throw new Error(`Não foi possível preparar o mutex de ownership: ${errorMessage(error)}`);
                }
                const code = (error as { code?: unknown })?.code;
                if (code !== "EEXIST") throw new Error(`Não foi possível acessar o mutex de ownership: ${errorMessage(error)}`);
                if (this.reclaimStaleOwnerMutex(mutexPath)) continue;
                if (attempt + 1 >= OWNER_MUTEX_MAX_ATTEMPTS)
                    throw new Error("Outra operação de ownership da VPN está em andamento; tente novamente.");
                await new Promise<void>(resolve => setTimeout(resolve, OWNER_MUTEX_RETRY_MS));
            }
        }
        throw new Error("Não foi possível reservar o mutex de ownership da VPN.");
    }

    private releaseOwnerMutex(lease: { path: string; token: string }): void {
        const holder = this.readOwnerMutexHolder(lease.path);
        if (!holder || holder.token !== lease.token || holder.pid !== process.pid) {
            this.options.log("warn", "mutex de ownership não pertence mais a esta operação");
            return;
        }
        try {
            fs.rmSync(lease.path, { recursive: true, force: true });
        } catch (error) {
            this.options.log("warn", "não consegui liberar o mutex de ownership", { erro: errorMessage(error) });
        }
    }

    private async withOwnerMutex<T>(operation: () => Promise<T>): Promise<T> {
        const lease = await this.acquireOwnerMutex();
        try {
            return await operation();
        } finally {
            this.releaseOwnerMutex(lease);
        }
    }

    private async requestRelaunch(namespaceOverride?: string | null): Promise<boolean> {
        const owner = this.readOwner();
        const expected = owner ? ownershipToken(owner) : null;
        const targetNamespace = namespaceOverride === undefined ? owner?.namespace ?? null : namespaceOverride;
        try {
            if (owner) {
                owner.pid = process.pid;
                owner.restarting = true;
                await this.writeOwner(owner, expected);
            }
            this.restarting = true;
            if (isLinux()) {
                const { requestRelaunch } = this.options;
                if (!requestRelaunch) throw new Error("o bridge nativo não forneceu relaunch Linux");
                if (!await requestRelaunch(targetNamespace)) throw new Error("o bridge nativo recusou o relaunch Linux");
            } else {
                app.relaunch();
                app.exit(0);
            }
            return true;
        } catch (error) {
            this.restarting = false;
            if (owner) {
                owner.restarting = false;
                try { await this.writeOwner(owner, ownershipToken(owner)); } catch (restoreError) {
                    this.options.log("error", "não consegui restaurar o marcador de reinício da VPN", { erro: errorMessage(restoreError) });
                }
            }
            this.options.log("error", "não consegui solicitar reinício do Discord", { erro: errorMessage(error) });
            return false;
        }
    }

    private async claimActiveOwnership(previous: VpnOwnerRecord | null, inspection: windows.WireSockInspection): Promise<VpnOwnerRecord> {
        if (this.isLiveForeignOwner(previous)) throw new Error("Outra instância do GoLiveBypass já controla a VPN.");
        return this.adoptOwnership(previous, inspection);
    }

    private async acquireLinuxOwnership(): Promise<VpnOwnerRecord> {
        return this.withOwnerMutex(async () => {
            const existing = this.readOwner();
            if (this.isLiveForeignOwner(existing)) throw new Error("Outra instância do GoLiveBypass já controla a VPN.");
            if (!existing && fs.existsSync(this.ownerPath)) this.quarantineInvalidOwnerUnlocked();
            const suffix = `${process.pid.toString(36)}${this.generation.toString(36)}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
            const namespace = `glb-${suffix}`.slice(0, 31);
            const interfaceName = `glbwg${suffix}`.slice(0, 15);
            if (!linux.isValidLinuxName(namespace, 31) || !linux.isValidLinuxName(interfaceName, 15))
                throw new Error("não foi possível criar nomes seguros para o namespace Linux");
            const owner: VpnOwnerRecord = {
                kind: VPN_OWNER_KIND,
                pid: process.pid,
                generation: this.generation,
                profilePath: this.profilePath,
                configPath: this.serviceConfigPath,
                namespace,
                interfaceName,
                createdAt: Date.now(),
            };
            this.writeOwnerUnlocked(owner);
            this.probePath = undefined;
            this.ownershipToken = ownershipToken(owner);
            return owner;
        });
    }

    private async adoptLinuxOwnership(previous: VpnOwnerRecord): Promise<VpnOwnerRecord> {
        if (!previous.namespace || !previous.interfaceName) throw new Error("owner Linux sem namespace ou interface");
        return this.withOwnerMutex(async () => {
            const current = this.readOwner();
            if (this.isLiveForeignOwner(current)) throw new Error("Outra instância do GoLiveBypass já controla a VPN.");
            const source = current ?? previous;
            if (!source.namespace || !source.interfaceName) throw new Error("owner Linux sem namespace ou interface");
            const adopted = {
                ...source,
                pid: process.pid,
                profilePath: this.profilePath,
                configPath: this.serviceConfigPath,
                restarting: false,
            };
            this.writeOwnerUnlocked(adopted);
            this.ownershipToken = ownershipToken(adopted);
            return adopted;
        });
    }

    private async acquireOwnership(): Promise<VpnOwnerRecord> {
        return this.withOwnerMutex(async () => {
            const existing = this.readOwner();
            const ownerFileExists = fs.existsSync(this.ownerPath);
            const inspection = windows.inspectWireSock(this.serviceConfigPath);
            if (isUnknownWireSockInspection(inspection)) throw new Error(unknownWireSockMessage(inspection));
            if (inspection.reliable && inspection.active && !inspection.owned) throw new Error(inspection.reason || "WireSock externo está ativo.");
            if (this.isLiveForeignOwner(existing)) throw new Error("Outra instância do GoLiveBypass já controla a VPN.");
            if (existing?.pid === process.pid) {
                this.probePath = existing.probePath;
                this.ownershipToken = ownershipToken(existing);
                return existing;
            }
            if (inspection.active && inspection.owned) {
                if (!existing && ownerFileExists) throw new Error("O lock da VPN está inválido; a sessão ativa foi preservada para recuperação manual.");
                const source = existing ?? {
                    kind: VPN_OWNER_KIND,
                    pid: process.pid,
                    generation: this.generation,
                    profilePath: this.profilePath,
                    configPath: this.serviceConfigPath,
                    createdAt: Date.now(),
                } satisfies VpnOwnerRecord;
                this.generation = Math.max(this.generation, source.generation);
                const adopted = { ...source, pid: process.pid, profilePath: this.profilePath, configPath: this.serviceConfigPath, restarting: false };
                this.writeOwnerUnlocked(adopted);
                this.probePath = adopted.probePath;
                this.ownershipToken = ownershipToken(adopted);
                return adopted;
            }
            if (!existing && ownerFileExists) this.quarantineInvalidOwnerUnlocked();
            const owner: VpnOwnerRecord = {
                kind: VPN_OWNER_KIND,
                pid: process.pid,
                generation: this.generation,
                profilePath: this.profilePath,
                configPath: this.serviceConfigPath,
                createdAt: Date.now(),
            };
            this.writeOwnerUnlocked(owner);
            this.probePath = undefined;
            this.ownershipToken = ownershipToken(owner);
            return owner;
        });
    }

    private async adoptOwnership(previous: VpnOwnerRecord | null, inspection: windows.WireSockInspection): Promise<VpnOwnerRecord> {
        if (isUnknownWireSockInspection(inspection)) throw new Error(unknownWireSockMessage(inspection));
        return this.withOwnerMutex(async () => {
            const current = this.readOwner();
            if (this.isLiveForeignOwner(current)) throw new Error("Outra instância do GoLiveBypass já controla a VPN.");
            if (!current && fs.existsSync(this.ownerPath))
                throw new Error("O lock da VPN está inválido; a sessão ativa foi preservada para recuperação manual.");
            const source: VpnOwnerRecord = current ?? previous ?? {
                kind: VPN_OWNER_KIND,
                pid: process.pid,
                generation: this.generation,
                profilePath: this.profilePath,
                configPath: this.serviceConfigPath,
                createdAt: Date.now(),
            } satisfies VpnOwnerRecord;
            this.generation = Math.max(this.generation, source.generation);
            const adopted = { ...source, pid: process.pid, configPath: this.serviceConfigPath, profilePath: this.profilePath, restarting: false };
            this.writeOwnerUnlocked(adopted);
            this.probePath = adopted.probePath;
            this.ownershipToken = ownershipToken(adopted);
            this.options.log("info", "ownership do WireSock confirmado", { services: inspection.services, pids: inspection.processIds });
            return adopted;
        });
    }

    private readOwner(): VpnOwnerRecord | null {
        try {
            const value = JSON.parse(fs.readFileSync(this.ownerPath, "utf8")) as Partial<VpnOwnerRecord>;
            const { pid } = value;
            const { generation } = value;
            const { profilePath } = value;
            const { configPath } = value;
            const { createdAt } = value;
            if (value.kind !== VPN_OWNER_KIND || typeof pid !== "number" || !Number.isInteger(pid) || typeof generation !== "number" || !Number.isInteger(generation)) return null;
            if (typeof profilePath !== "string" || typeof configPath !== "string" || typeof createdAt !== "number") return null;
            if (path.resolve(profilePath) !== this.profilePath || path.resolve(configPath) !== this.serviceConfigPath) return null;
            return {
                kind: VPN_OWNER_KIND,
                pid,
                generation,
                profilePath: this.profilePath,
                configPath: this.serviceConfigPath,
                probePath: isWindows() && typeof value.probePath === "string" && windows.isManagedRouteProbePath(this.dataDir, value.probePath)
                    ? value.probePath
                    : undefined,
                namespace: typeof value.namespace === "string" && linux.isValidLinuxName(value.namespace, 31)
                    ? value.namespace
                    : undefined,
                interfaceName: typeof value.interfaceName === "string" && linux.isValidLinuxName(value.interfaceName, 15)
                    ? value.interfaceName
                    : undefined,
                restarting: value.restarting === true,
                createdAt,
            };
        } catch { return null; }
    }

    private writeOwnerUnlocked(owner: VpnOwnerRecord): void {
        fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
        if (process.platform === "linux") fs.chmodSync(this.dataDir, 0o700);
        const temporary = `${this.ownerPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        try {
            fs.writeFileSync(temporary, JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
            if (process.platform === "linux") fs.chmodSync(temporary, 0o600);
            fs.renameSync(temporary, this.ownerPath);
            if (process.platform === "linux") fs.chmodSync(this.ownerPath, 0o600);
        } catch (error) {
            try { fs.rmSync(temporary, { force: true }); } catch { }
            throw error;
        }
    }

    private async writeOwner(owner: VpnOwnerRecord, expected: OwnershipToken | null = this.ownershipToken): Promise<void> {
        await this.withOwnerMutex(async () => {
            if (expected) {
                const current = this.readOwner();
                if (!current || !sameOwnership(expected, current)) throw new Error("ownership da VPN mudou durante a operação");
            }
            this.writeOwnerUnlocked(owner);
            this.ownershipToken = ownershipToken(owner);
        });
    }

    private quarantineInvalidOwnerUnlocked(): void {
        if (!fs.existsSync(this.ownerPath)) return;
        const quarantine = `${this.ownerPath}.invalid.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.bak`;
        fs.renameSync(this.ownerPath, quarantine);
        this.options.log("warn", "lock inválido da VPN movido para recuperação", { arquivo: path.basename(quarantine) });
    }

    private async releaseOwnership(owner: VpnOwnerRecord): Promise<boolean> {
        try {
            return await this.withOwnerMutex(async () => {
                const current = this.readOwner();
                if (!current) {
                    if (fs.existsSync(this.ownerPath)) return false;
                    if (sameOwnership(this.ownershipToken, owner)) this.ownershipToken = null;
                    return true;
                }
                if (!sameOwnership(current, owner)) return false;
                fs.rmSync(this.ownerPath, { force: true });
                const removed = !fs.existsSync(this.ownerPath);
                if (removed && sameOwnership(this.ownershipToken, owner)) this.ownershipToken = null;
                return removed;
            });
        } catch (error) {
            this.options.log("warn", "não consegui remover lock da VPN", { erro: errorMessage(error) });
            return false;
        }
    }

    private writeProfileAtomically(raw: string): void {
        fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
        if (process.platform === "linux") fs.chmodSync(this.dataDir, 0o700);
        const temporary = `${this.profilePath}.${process.pid}.${Date.now()}.tmp`;
        let fd: number | undefined;
        try {
            fd = fs.openSync(temporary, "wx", 0o600);
            fs.writeFileSync(fd, raw, "utf8");
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            fs.renameSync(temporary, this.profilePath);
            if (process.platform === "linux") fs.chmodSync(this.profilePath, 0o600);
        } catch (error) {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch { }
            }
            try { fs.rmSync(temporary, { force: true }); } catch { }
            throw error;
        }
    }

    private protonProfileSelection(settings: VpnSettings): ProtonProfileSelection {
        return {
            country: normalizeCountry(settings.protonCountry),
            freeOnly: settings.protonFreeOnly,
            autoPing: settings.protonAutoPing,
        };
    }

    private protonProfileMatches(username: string, selection: ProtonProfileSelection): boolean {
        if (!fs.existsSync(this.profilePath) || !fs.existsSync(this.profileAccountPath)) return false;
        try {
            const value = JSON.parse(fs.readFileSync(this.profileAccountPath, "utf8")) as {
                schema?: unknown;
                username?: unknown;
                country?: unknown;
                freeOnly?: unknown;
                autoPing?: unknown;
            };
            return value.schema === VPN_SCHEMA_VERSION
                && typeof value.username === "string"
                && protonUsernamesMatch(value.username, username)
                && value.country === selection.country
                && value.freeOnly === selection.freeOnly
                && value.autoPing === selection.autoPing;
        } catch {
            return false;
        }
    }

    private writeProtonProfileAccount(username: string, selection: ProtonProfileSelection): void {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const temporary = `${this.profileAccountPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({
            schema: VPN_SCHEMA_VERSION,
            username: normalizeUsername(username),
            country: selection.country,
            freeOnly: selection.freeOnly,
            autoPing: selection.autoPing,
        }), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temporary, this.profileAccountPath);
    }

    private clearProtonProfileAccount(): void {
        fs.rmSync(this.profileAccountPath, { force: true });
    }

    private clearProtonArtifacts(): void {
        for (const target of [this.profilePath, this.serviceConfigPath, this.profileAccountPath])
            fs.rmSync(target, { force: true });
        this.probePath = undefined;
    }

    private async migrateGuiState(): Promise<void> {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const markerPath = path.join(this.dataDir, MIGRATION_FILE);
        const copies = [PROFILE_FILE, "proton-session.json"];
        const imported: string[] = [];
        for (const file of copies) {
            const source = path.join(this.options.guiDataDir, file);
            const target = path.join(this.dataDir, file);
            if (fs.existsSync(source) && !fs.existsSync(target)) {
                const temporary = `${target}.${process.pid}.${Date.now()}.migration.tmp`;
                try {
                    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
                    const raw = fs.readFileSync(temporary, "utf8");
                    if (file === PROFILE_FILE) {
                        const validation = windows.validateWireGuardProfile(raw);
                        if (!validation.valid) throw new Error(validation.error || "perfil WireGuard inválido");
                    } else {
                        const session = JSON.parse(raw) as unknown;
                        if (session === null || typeof session !== "object" || Array.isArray(session))
                            throw new Error("sessão Proton inválida");
                    }
                    fs.renameSync(temporary, target);
                    imported.push(file);
                    this.options.log("info", "estado compatível da GUI importado", { arquivo: file });
                } catch (error) {
                    this.options.log("warn", "não consegui importar estado da GUI", { arquivo: file, erro: errorMessage(error) });
                    try { fs.rmSync(temporary, { force: true }); } catch { }
                }
            }
        }
        if (!fs.existsSync(markerPath) || imported.length > 0) {
            const temporary = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify({ schema: VPN_SCHEMA_VERSION, completedAt: Date.now(), source: "gui-compatible-profile-only", imported }), "utf8");
            fs.renameSync(temporary, markerPath);
        }
    }
}

export function defaultPluginVpnDataDir(): string {
    if (process.platform === "linux") {
        const configured = process.env.XDG_DATA_HOME?.trim();
        const base = configured && path.isAbsolute(configured)
            ? configured
            : path.join(osFallbackHome(), ".local", "share");
        return path.join(base, "GoLiveBypass", "plugin-vpn");
    }
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || osFallbackHome();
    return path.join(base, "GoLiveBypass", "plugin-vpn");
}

function osFallbackHome(): string {
    return process.env.USERPROFILE || process.env.HOME || ".";
}
