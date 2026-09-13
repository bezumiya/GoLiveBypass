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

export interface ProtonRouteDiscoveryOptions {
    requestId?: string;
    country?: string;
    freeOnly?: boolean;
    autoPing?: boolean;
    onProgress?: (progress: proton.ProtonOptimizationProgress & { requestId: string; measurementId: string }) => void;
}

/**
 * Projeção pública de uma rota catalogada. `status` descreve apenas a medição
 * de ping: "testing" aguarda a sonda, "success" tem ping válido e "failed"
 * ficou sem ping utilizável.
 */
export interface ProtonRouteCatalogView {
    server: string;
    country: string;
    city: string;
    tier: string;
    load: number;
    score: number;
    pingMs?: number;
    status: "testing" | "success" | "failed";
}

export interface ProtonRouteDiscoveryResult {
    success: boolean;
    measurementId?: string;
    routes?: ProtonRouteCatalogView[];
    error?: string;
    cancelled?: boolean;
}

export interface ProtonRouteSelectionOptions {
    measurementId: string;
    server: string;
}

export interface ProtonRouteSelectionResult {
    success: boolean;
    server?: string;
    country?: string;
    city?: string;
    tier?: string;
    load?: number;
    score?: number;
    pingMs?: number;
    state?: VpnState;
    deferred?: boolean;
    cancelled?: boolean;
    message?: string;
    error?: string;
}

export interface ProtonRouteDiscoveryStatus {
    active: boolean;
    requestId: string | null;
    measurementId: string | null;
    phase: proton.ProtonOptimizationProgress["phase"] | null;
    routes: ProtonRouteCatalogView[];
    total: number;
    measured: number;
    error?: string;
    updatedAt: number | null;
    expiresAt: number | null;
}

/** Detalhe preservado da ponte de CAPTCHA: recusa e cancelamento não são a mesma coisa. */
export type ProtonCaptchaSolution =
    | { ok: true; token: string }
    | { ok: false; code: "CAPTCHA_INVALID" | "CAPTCHA_CANCELLED"; message?: string };

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
// A medição de rotas é efêmera: vale enquanto a descoberta emite eventos e por
// esta janela depois do último evento (mesmo TTL da GUI).
const PROTON_ROUTE_MEASUREMENT_TTL_MS = 10 * 60_000;
const PROTON_PING_MAX_MS = 999;
const MAX_PROTON_ROUTE_SERVER_LENGTH = 200;
const MAX_PROTON_ROUTE_COUNTRY_LENGTH = 32;
const MAX_PROTON_ROUTE_CITY_LENGTH = 200;
const MAX_PROTON_ROUTE_TIER_LENGTH = 80;
/** Nome de servidor Proton: texto visível, sem espaços nem controles. */
const CATALOG_SERVER_RE = /^[^\s\u0000-\u001f\u007f]+$/;

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

function isValidProtonPing(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value < PROTON_PING_MAX_MS;
}

type RawProtonRouteMetadata = {
    server?: unknown;
    country?: unknown;
    city?: unknown;
    tier?: unknown;
    load?: unknown;
    score?: unknown;
    pingMs?: unknown;
};

interface ProtonRouteMetadata {
    server: string;
    country?: string;
    city?: string;
    tier?: string;
    load?: number;
    score?: number;
}

/**
 * Metadados públicos normalizados de um evento de catálogo. Campo ausente fica
 * de fora do resultado: o evento progressivo pode trazer só o ping e a
 * candidata preserva o que já foi catalogado. Valor presente e inválido
 * descarta o evento inteiro. Endpoint, arquivo de configuração, chave e sessão
 * nunca atravessam esta fronteira.
 */
function protonRouteMetadata(raw: RawProtonRouteMetadata): ProtonRouteMetadata | null {
    const server = typeof raw.server === "string" ? raw.server.trim() : "";
    if (!server || server.length > MAX_PROTON_ROUTE_SERVER_LENGTH || !CATALOG_SERVER_RE.test(server)) return null;
    const metadata: ProtonRouteMetadata = { server };
    if (raw.country !== undefined) {
        const country = typeof raw.country === "string" ? raw.country.trim() : "";
        if (!country || country.length > MAX_PROTON_ROUTE_COUNTRY_LENGTH) return null;
        metadata.country = country;
    }
    if (raw.city !== undefined) {
        const city = typeof raw.city === "string" ? raw.city.trim() : "";
        if (city.length > MAX_PROTON_ROUTE_CITY_LENGTH) return null;
        metadata.city = city;
    }
    if (raw.tier !== undefined) {
        const tier = typeof raw.tier === "string" ? raw.tier.trim() : "";
        if (!tier || tier.length > MAX_PROTON_ROUTE_TIER_LENGTH) return null;
        metadata.tier = tier;
    }
    if (raw.load !== undefined) {
        const load = Number(raw.load);
        if (!Number.isFinite(load) || load < 0 || load > 100) return null;
        metadata.load = load;
    }
    if (raw.score !== undefined) {
        const score = Number(raw.score);
        if (!Number.isFinite(score) || score < 0) return null;
        metadata.score = score;
    }
    return metadata;
}

interface ProtonRouteCandidate {
    entry: proton.ProtonRouteCatalogEntry;
    status: ProtonRouteCatalogView["status"];
}

interface ProtonRouteMeasurement {
    measurementId: string;
    requestId: string;
    /** Identidade da operação que criou a medição; geração sozinha não distingue donos. */
    owner: symbol;
    generation: number;
    username: string;
    country: string;
    freeOnly: boolean;
    autoPing: boolean;
    controller: AbortController;
    active: boolean;
    phase: proton.ProtonOptimizationProgress["phase"];
    error?: string;
    routes: Map<string, ProtonRouteCandidate>;
    updatedAt: number;
    expiresAt: number;
}

/** Cópia em memória do perfil Proton anterior: nunca vai para log nem para disco paralelo. */
interface ProtonProfileBackup {
    profile: string;
    account: string | null;
}

export class PluginVpnController {
    private readonly options: PluginVpnControllerOptions;
    private readonly dataDir: string;
    private readonly profilePath: string;
    private readonly profileAccountPath: string;
    private readonly serviceConfigPath: string;
    private readonly guiConfigPath: string;
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
    private routeMeasurement: ProtonRouteMeasurement | null = null;
    private routeMeasurementGeneration = 0;
    private routeSelection: { id: string; controller: AbortController } | null = null;
    private routeProbeFlights = new Set<Promise<void>>();
    private ownershipToken: OwnershipToken | null = null;
    private diagnosticGeneration = 0;

    public constructor(options: PluginVpnControllerOptions) {
        this.options = options;
        this.dataDir = path.resolve(options.dataDir);
        this.profilePath = path.join(this.dataDir, PROFILE_FILE);
        this.profileAccountPath = path.join(this.dataDir, PROFILE_ACCOUNT_FILE);
        this.serviceConfigPath = path.join(this.dataDir, SERVICE_CONFIG_FILE);
        this.guiConfigPath = path.join(this.options.guiDataDir, SERVICE_CONFIG_FILE);
        this.ownerPath = path.join(this.dataDir, OWNER_FILE);
    }

    public get paths() {
        return { dataDir: this.dataDir, profilePath: this.profilePath, serviceConfigPath: this.serviceConfigPath, ownerPath: this.ownerPath };
    }

    /** Inspeção Windows com as duas configs conhecidas do GoLiveBypass (plugin e GUI). */
    private inspectWindows(): windows.WireSockInspection {
        return windows.inspectWireSock(this.serviceConfigPath, this.guiConfigPath);
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
        const inspection = this.inspectWindows();
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
            const inspection = this.inspectWindows();
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
        const inspection = this.inspectWindows();
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
        // Durante uma operação em andamento (ativação explícita com retomada, parada,
        // relaunch) o poll do renderer não pode flipar o estado para blocked_external:
        // a inspeção ainda vê a instância gerenciada que esta operação vai encerrar.
        const operationInProgress = this.state === "preparing"
            || this.state === "starting"
            || this.state === "stopping"
            || this.state === "restart_pending";
        if (inspection.reliable && inspection.active && !inspection.owned && !operationInProgress) {
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
            managedConflict: inspection.reliable && inspection.active && !inspection.owned
                && (inspection.origin === "gui" || inspection.origin === "managed"),
            externalReason: this.externalReason,
            lastDiagnostic: this.lastDiagnostic,
            message: reportedState === "inactive" ? "VPN inativa" : this.statusMessage(),
        };
    }

    public enable(): Promise<VpnOperationResult> {
        this.automaticBootSuppressed = false;
        return this.serial(() => this.startInternal(true));
    }

    // Ativação automática do boot (processo principal e renderer). Não é a ativação do usuário:
    // só adota um túnel já ativo e NUNCA relança o Discord nem limpa a suspensão de autostart.
    //
    // Por que não subir o túnel aqui: sem o relaunch o Discord ficaria fora do filtro por
    // aplicativo e o usuário acharia que estava protegido sem estar (o README promete o
    // reinício na ativação). E por que não relançar: repetir o relaunch a cada boot transforma
    // um relaunch não confirmado em ciclo infinito -- cada processo novo relançava o Discord,
    // nascia outro, e a VPN ficava parando/começando a cada ~30s (relato: o Discord não
    // fechava nem reabria, só saía pelo gerenciador de tarefas). O caminho explícito continua
    // em `enable()`, chamado pelo botão do painel.
    public enableAutomatic(): Promise<VpnOperationResult> {
        if (this.automaticBootSuppressed) {
            this.options.log("warn", "ativação automática suspensa após relaunch não confirmado");
            return Promise.resolve({
                success: false,
                suppressed: true,
                state: this.state,
                error: "A ativação automática está suspensa porque o último relaunch não confirmou a VPN. Ative pelo painel.",
            });
        }
        return this.serial(() => this.adoptActiveTunnelAtBoot());
    }

    private async adoptActiveTunnelAtBoot(): Promise<VpnOperationResult> {
        const owner = this.readOwner();
        const inspection = isLinux() ? linux.inspectLinuxNetworkSync(owner) : this.inspectWindows();
        if (!inspection.reliable) {
            this.options.log("warn", "ativação automática não confirmou o estado da VPN; ativação explícita segue disponível", { mode: "diagnostic-only" });
            return { success: false, suppressed: true, state: this.state, error: "Não foi possível confirmar o estado da VPN no boot." };
        }
        if (!inspection.active || !inspection.owned) {
            this.options.log("info", "VPN não foi ativada automaticamente porque o túnel não está ativo; ative pelo painel");
            return {
                success: false,
                suppressed: true,
                state: this.state,
                error: "A VPN não está ativa. Ative pelo painel do GoLiveBypass para aplicar a rota.",
            };
        }
        return this.startInternal(false);
    }

    public shutdown(relaunch = true): Promise<VpnOperationResult> {
        this.cancelProtonLogin();
        this.optimization?.controller.abort();
        this.cancelProtonRouteDiscovery();
        this.cancelProtonRouteSelection();
        return this.serial(() => this.stopInternal(relaunch));
    }

    public restoreNetwork(): Promise<VpnOperationResult> {
        this.cancelProtonLogin();
        this.optimization?.controller.abort();
        this.cancelProtonRouteDiscovery();
        this.cancelProtonRouteSelection();
        return this.serial(() => this.stopInternal(isLinux()));
    }

    public restartDiscord(): Promise<VpnOperationResult> {
        this.cancelProtonLogin();
        this.optimization?.controller.abort();
        this.cancelProtonRouteDiscovery();
        this.cancelProtonRouteSelection();
        return this.serial(() => this.restartInternal());
    }

    public importCustomConfig(sourcePath: string): Promise<{ success: boolean; error?: string; path?: string }> {
        return this.serial(async () => {
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
        });
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

    public loginProton(payload: ProtonLoginPayload, solveCaptcha: (url: string, signal: AbortSignal) => Promise<ProtonCaptchaSolution>): Promise<proton.ProtonLoginResult> {
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
                    const captcha = await solveCaptcha(result.captchaUrl, operation.controller.signal);
                    if (!isCurrent()) return cancelledLoginResult();
                    // Recusa e cancelamento da verificação são causas diferentes: a
                    // primeira pede nova tentativa, a segunda é decisão do usuário.
                    if (!captcha.ok) {
                        const message = captcha.message || (captcha.code === "CAPTCHA_CANCELLED"
                            ? "A verificação Proton foi cancelada."
                            : "A verificação expirou ou foi recusada. Tente novamente.");
                        return { success: false, code: captcha.code, message, error: message, retryable: true };
                    }
                    result = await proton.loginProton(this.dataDir, username, payload.password, payload.twoFactorCode, captcha.token, this.options.log);
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
                // A medição de rotas pertence a uma conta: outra conta a invalida.
                if (result.success && result.username && this.routeMeasurement
                    && !protonUsernamesMatch(this.routeMeasurement.username, result.username))
                    this.invalidateRouteMeasurement();
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
        this.cancelProtonRouteSelection();
        return this.serial(async () => {
            const owner = this.readOwner();
            if (isLinux()) {
                const inspection = linux.inspectLinuxNetworkSync(owner);
                if (!inspection.reliable)
                    return { success: false, error: inspection.reason || "Não foi possível confirmar o namespace Linux." };
                if (inspection.active || owner || this.state !== "inactive")
                    return { success: false, error: "Restaure a rede antes de sair da conta Proton." };
            } else {
                const inspection = this.inspectWindows();
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
                // Sem conta não há catálogo válido: medição e seleção pendente somem juntas.
                this.invalidateRouteMeasurement();
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
        if (this.routeSelection) return { success: false, error: "Já existe uma seleção de rota Proton em andamento." };
        if (this.routeMeasurement?.active) return { success: false, error: "Cancele a descoberta de rotas Proton antes de otimizar." };

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

    // ------------------------------------------------------------------ catálogo manual de rotas

    /**
     * Catálogo efêmero de rotas para a conta e os filtros atuais. Não pede
     * certificado, não cria chave nem perfil, não abre túnel e não altera a rota
     * selecionada: só mede e devolve metadados públicos.
     */
    public discoverProtonRoutes(options: ProtonRouteDiscoveryOptions = {}): Promise<ProtonRouteDiscoveryResult> {
        if (!isSupportedVpnArchitecture(process.platform, process.arch))
            return Promise.resolve({ success: false, error: "A VPN do plugin exige Windows x64 ou Linux x64." });
        if (this.optimization)
            return Promise.resolve({ success: false, error: "Já existe uma otimização Proton em andamento." });
        if (this.routeSelection)
            return Promise.resolve({ success: false, error: "Já existe uma seleção de rota Proton em andamento." });
        if (this.protonLogin)
            return Promise.resolve({ success: false, error: "Termine o login Proton antes de escolher uma rota." });
        if (this.routeMeasurement?.active)
            return Promise.resolve({ success: false, error: "Já existe uma descoberta de rotas Proton em andamento." });

        const requestId = normalizeLoginRequestId(options.requestId);
        const controller = new AbortController();
        const now = Date.now();
        const measurement: ProtonRouteMeasurement = {
            measurementId: randomUUID().replaceAll("-", ""),
            requestId,
            // Dono da medição: a identidade do objeto em `this.routeMeasurement`
            // mais a geração decidem se um evento ou seleção ainda vale.
            owner: Symbol("proton-route-measurement"),
            generation: ++this.routeMeasurementGeneration,
            username: "",
            country: "",
            freeOnly: true,
            autoPing: true,
            controller,
            active: true,
            phase: "preparing",
            routes: new Map(),
            updatedAt: now,
            expiresAt: now + PROTON_ROUTE_MEASUREMENT_TTL_MS,
        };
        // Uma descoberta nova invalida a anterior: eventos e seleções do
        // identificador antigo são ignorados ou recusados daqui em diante.
        this.routeMeasurement?.controller.abort();
        this.routeMeasurement = measurement;

        return this.serial(async () => {
            const isCurrent = () => this.routeMeasurement?.owner === measurement.owner && !controller.signal.aborted;
            try {
                const settings = this.settings();
                const username = normalizeUsername(settings.protonUsername);
                if (!username) {
                    const error = "Faça login com sua conta Proton antes de escolher uma rota.";
                    this.finishRouteMeasurement(measurement, "failed", error);
                    return { success: false, measurementId: measurement.measurementId, error };
                }
                measurement.username = username;
                measurement.country = normalizeCountry(options.country ?? settings.protonCountry);
                measurement.freeOnly = options.freeOnly ?? settings.protonFreeOnly;
                measurement.autoPing = options.autoPing ?? settings.protonAutoPing;
                if (!isCurrent()) return this.cancelledRouteDiscovery(measurement);

                const catalog = await proton.generateProtonRouteCatalog(this.dataDir, {
                    username,
                    country: measurement.country,
                    freeOnly: measurement.freeOnly,
                    autoPing: measurement.autoPing,
                    signal: controller.signal,
                    onProgress: progress => {
                        this.recordRouteProgress(measurement, progress);
                        options.onProgress?.({ ...progress, requestId, measurementId: measurement.measurementId });
                    },
                    log: this.options.log,
                });
                for (const route of catalog.routes ?? []) this.recordRouteMetadata(measurement, route);
                if (!isCurrent()) return this.cancelledRouteDiscovery(measurement);

                if (!catalog.success || measurement.routes.size === 0) {
                    const error = catalog.error || "Nenhuma rota Proton compatível foi encontrada para esta conta e os filtros atuais.";
                    this.finishRouteMeasurement(measurement, "failed", error);
                    return {
                        success: false,
                        measurementId: measurement.measurementId,
                        routes: this.routeCatalogViews(measurement),
                        error,
                    };
                }
                this.finishRouteMeasurement(measurement, "completed");
                return {
                    success: true,
                    measurementId: measurement.measurementId,
                    routes: this.routeCatalogViews(measurement),
                };
            } catch (error) {
                if (!isCurrent()) return this.cancelledRouteDiscovery(measurement);
                const detail = errorMessage(error);
                this.finishRouteMeasurement(measurement, "failed", detail);
                this.options.log("error", "descoberta de rotas Proton falhou", { erro: detail });
                return { success: false, measurementId: measurement.measurementId, routes: this.routeCatalogViews(measurement), error: detail };
            }
        });
    }

    /**
     * Cancela apenas a descoberta correspondente. Fica fora da fila serial pelo
     * mesmo motivo do login: o helper pode estar bloqueado medindo pings e a
     * fila não teria como interrompê-lo.
     */
    public cancelProtonRouteDiscovery(requestId?: string): boolean {
        const measurement = this.routeMeasurement;
        if (!measurement || !measurement.active) return false;
        if (typeof requestId === "string" && requestId.trim() && measurement.requestId !== requestId.trim()) return false;
        measurement.controller.abort();
        return true;
    }

    public getRouteDiscoveryStatus(): ProtonRouteDiscoveryStatus {
        this.sweepRouteMeasurement();
        const measurement = this.routeMeasurement;
        if (!measurement) {
            return {
                active: false,
                requestId: null,
                measurementId: null,
                phase: null,
                routes: [],
                total: 0,
                measured: 0,
                updatedAt: null,
                expiresAt: null,
            };
        }
        const routes = this.routeCatalogViews(measurement);
        return {
            active: measurement.active,
            requestId: measurement.requestId,
            measurementId: measurement.measurementId,
            phase: measurement.phase,
            routes,
            total: routes.length,
            measured: routes.filter(route => route.pingMs !== undefined).length,
            error: measurement.error,
            updatedAt: measurement.updatedAt,
            expiresAt: measurement.expiresAt,
        };
    }

    /**
     * Aplica uma rota escolhida manualmente. A medição precisa pertencer a esta
     * conta e aos filtros atuais; o helper só promove o perfil após o
     * `-manual-probe` completo, e o perfil anterior é restaurado se a aplicação
     * falhar.
     */
    public selectProtonRoute(options: ProtonRouteSelectionOptions): Promise<ProtonRouteSelectionResult> {
        if (!isSupportedVpnArchitecture(process.platform, process.arch))
            return Promise.resolve({ success: false, error: "A VPN do plugin exige Windows x64 ou Linux x64." });
        if (this.optimization) return Promise.resolve({ success: false, error: "Já existe uma otimização Proton em andamento." });
        if (this.routeSelection) return Promise.resolve({ success: false, error: "Já existe uma seleção de rota Proton em andamento." });
        if (this.protonLogin) return Promise.resolve({ success: false, error: "Termine o login Proton antes de aplicar uma rota." });

        const measurementId = typeof options.measurementId === "string" ? options.measurementId.trim() : "";
        const server = typeof options.server === "string" ? options.server.trim() : "";
        if (!measurementId || measurementId.length > 128 || !server || !CATALOG_SERVER_RE.test(server)
            || server.length > MAX_PROTON_ROUTE_SERVER_LENGTH)
            return Promise.resolve({ success: false, error: "A identificação da medição ou da rota é inválida." });

        this.sweepRouteMeasurement();
        const measurement = this.routeMeasurement;
        if (!measurement || measurement.generation !== this.routeMeasurementGeneration)
            return Promise.resolve({ success: false, error: "A medição de rotas expirou. Faça uma nova descoberta." });
        if (measurement.measurementId !== measurementId)
            return Promise.resolve({ success: false, error: "Esta medição de rotas não é mais a atual. Faça uma nova descoberta." });
        if (measurement.expiresAt <= Date.now())
            return Promise.resolve({ success: false, error: "A medição de rotas expirou. Faça uma nova descoberta." });
        if (measurement.active)
            return Promise.resolve({ success: false, error: "A descoberta de rotas ainda está em andamento. Aguarde para escolher uma rota." });

        const candidate = measurement.routes.get(server);
        if (!candidate)
            return Promise.resolve({ success: false, error: "A rota escolhida não pertence à medição atual. Faça uma nova descoberta." });
        if (!isValidProtonPing(candidate.entry.pingMs))
            return Promise.resolve({ success: false, error: "A rota escolhida está sem ping válido e não pode ser aplicada. Faça uma nova descoberta." });

        const settings = this.settings();
        const username = normalizeUsername(settings.protonUsername);
        if (!username || !protonUsernamesMatch(measurement.username, username))
            return Promise.resolve({ success: false, error: "A conta Proton mudou desde a medição. Faça uma nova descoberta." });
        const selection = this.protonProfileSelection(settings);
        if (selection.country !== measurement.country || selection.freeOnly !== measurement.freeOnly || selection.autoPing !== measurement.autoPing)
            return Promise.resolve({ success: false, error: "As preferências Proton mudaram desde a medição. Faça uma nova descoberta." });

        const operation = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, controller: new AbortController() };
        this.routeSelection = operation;
        return this.serial(async () => {
            const isCurrent = () => this.routeSelection === operation && !operation.controller.signal.aborted;
            const status = this.getStatus();
            const wasActive = status.active;
            let backup: ProtonProfileBackup | null = null;
            let profilePromoted = false;
            try {
                if (!isCurrent()) return { success: false, cancelled: true, error: "A seleção de rota Proton foi cancelada." };
                if (status.state === "blocked_external" || this.state === "blocked_external")
                    return { success: false, error: status.externalReason || this.externalReason || "Túnel externo está ativo." };
                if (isLinux() && wasActive)
                    return { success: false, error: "Restaure a rede antes de validar outra rota Proton no Linux." };
                if (isLinux() && status.requiresRelaunch)
                    return { success: false, error: "Reinicie o Discord para entrar no namespace Linux antes de escolher a rota." };

                // O probe manual do helper não pode disputar o serviço WireSock com a
                // rota ativa; no Linux este processo não volta ao namespace original,
                // então a rota atual é mantida até a troca.
                if (wasActive && !isLinux()) {
                    const stopped = await this.stopInternal(false);
                    if (!stopped.success)
                        return { success: false, error: stopped.error || "Não foi possível pausar a VPN para aplicar a rota escolhida." };
                }
                if (!isCurrent()) {
                    const restoreError = await this.rollbackRouteSelection(backup, wasActive, profilePromoted);
                    return { success: false, cancelled: true, error: restoreError || "A seleção de rota Proton foi cancelada." };
                }

                backup = this.readProtonProfileBackup();
                const generated = await proton.generateManualProtonConfig(this.dataDir, {
                    username,
                    server,
                    country: measurement.country,
                    freeOnly: measurement.freeOnly,
                    signal: operation.controller.signal,
                    log: this.options.log,
                });
                profilePromoted = generated.success;
                if (!isCurrent()) {
                    const restoreError = await this.rollbackRouteSelection(backup, wasActive, profilePromoted);
                    return { success: false, cancelled: true, error: restoreError || "A seleção de rota Proton foi cancelada." };
                }
                if (!generated.success) {
                    const error = generated.error || "Não foi possível validar a rota Proton escolhida.";
                    const restoreError = await this.rollbackRouteSelection(backup, wasActive, profilePromoted);
                    return { success: false, error: restoreError ? `${error} ${restoreError}` : error };
                }
                // O helper já promoveu o perfil por staging; confirmamos que o servidor
                // promovido é exatamente o escolhido e que o perfil final é válido.
                if (generated.server !== server || !isValidProtonPing(generated.pingMs))
                    throw new Error("A validação retornou uma rota diferente da escolhida.");
                const promoted = fs.existsSync(this.profilePath) ? fs.readFileSync(this.profilePath, "utf8") : "";
                const validation = validateWireGuardConfig(promoted);
                if (!validation.valid) throw new Error(validation.error);

                this.writeProtonProfileAccount(username, {
                    country: measurement.country,
                    freeOnly: measurement.freeOnly,
                    autoPing: measurement.autoPing,
                });
                const applied = this.publicRouteSelection(generated, server);
                if (!wasActive) {
                    return { ...applied, state: this.state, message: "Rota Proton preparada; ela será usada na próxima ativação." };
                }
                if (isLinux()) {
                    const stopped = await this.stopInternal(true);
                    if (!stopped.success) {
                        const error = stopped.error || "A rota foi validada, mas não consegui relançar o Discord fora do namespace Linux.";
                        const restoreError = await this.rollbackRouteSelection(backup, wasActive, profilePromoted);
                        return { success: false, error: restoreError ? `${error} ${restoreError}` : error };
                    }
                    return { ...applied, deferred: true, state: this.state, message: "Rota Proton preparada; o Discord será relançado para aplicar a nova configuração." };
                }
                const restarted = await this.startInternal(true);
                if (!restarted.success) {
                    const error = restarted.error || "A rota foi validada, mas não consegui reiniciar o Discord para aplicar a nova configuração.";
                    const restoreError = await this.rollbackRouteSelection(backup, wasActive, profilePromoted);
                    return { success: false, error: restoreError ? `${error} ${restoreError}` : error };
                }
                return {
                    ...applied,
                    deferred: restarted.state === "restart_pending",
                    state: restarted.state,
                    message: restarted.message || "Rota Proton aplicada.",
                };
            } catch (error) {
                const cancelled = error instanceof Error && error.name === "AbortError";
                const detail = cancelled ? "A seleção de rota Proton foi cancelada." : errorMessage(error);
                const restoreError = await this.rollbackRouteSelection(backup, wasActive, profilePromoted);
                if (!cancelled) this.options.log("error", "seleção manual de rota Proton falhou", { erro: detail });
                return { success: false, ...(cancelled ? { cancelled: true } : {}), error: restoreError ? `${detail} ${restoreError}` : detail };
            } finally {
                if (this.routeSelection === operation) this.routeSelection = null;
            }
        });
    }

    /** Interrompe o helper de seleção fora da fila serial, como login e descoberta. */
    public cancelProtonRouteSelection(): boolean {
        const operation = this.routeSelection;
        if (!operation) return false;
        operation.controller.abort();
        return true;
    }

    private cancelledRouteDiscovery(measurement: ProtonRouteMeasurement): ProtonRouteDiscoveryResult {
        this.finishRouteMeasurement(measurement, "cancelled", "A descoberta de rotas Proton foi cancelada.");
        return {
            success: false,
            cancelled: true,
            measurementId: measurement.measurementId,
            routes: this.routeCatalogViews(measurement),
            error: measurement.error,
        };
    }

    private finishRouteMeasurement(
        measurement: ProtonRouteMeasurement,
        phase: "completed" | "failed" | "cancelled",
        error?: string,
    ): void {
        measurement.active = false;
        measurement.phase = phase;
        measurement.error = error;
        measurement.updatedAt = Date.now();
        measurement.expiresAt = measurement.updatedAt + PROTON_ROUTE_MEASUREMENT_TTL_MS;
        // Nada mais será medido: candidata sem ping válido fica indisponível.
        for (const candidate of measurement.routes.values())
            if (candidate.status === "testing") candidate.status = "failed";
    }

    private recordRouteProgress(measurement: ProtonRouteMeasurement, progress: proton.ProtonOptimizationProgress): void {
        if (this.routeMeasurement?.owner !== measurement.owner || measurement.generation !== this.routeMeasurementGeneration) return;
        const now = Date.now();
        measurement.updatedAt = now;
        measurement.expiresAt = now + PROTON_ROUTE_MEASUREMENT_TTL_MS;
        measurement.phase = progress.phase;
        if (progress.phase === "catalog") {
            this.recordRouteMetadata(measurement, progress, progress.status);
            return;
        }
        const server = typeof progress.server === "string" ? progress.server.trim() : "";
        const candidate = server ? measurement.routes.get(server) : undefined;
        if (!candidate) return;
        if (isValidProtonPing(progress.pingMs)) {
            candidate.entry.pingMs = progress.pingMs;
            candidate.status = "success";
            return;
        }
        // Ping aprovado sem valor utilizável é contraditório, e uma sonda com falha
        // explícita tira a candidata da lista de selecionáveis.
        if (progress.status === "failed" || (progress.phase === "ping" && progress.status === "success")) {
            candidate.status = "failed";
            delete candidate.entry.pingMs;
        }
    }

    private recordRouteMetadata(
        measurement: ProtonRouteMeasurement,
        raw: RawProtonRouteMetadata,
        statusHint?: proton.ProtonOptimizationProgress["status"],
    ): void {
        if (this.routeMeasurement?.owner !== measurement.owner || measurement.generation !== this.routeMeasurementGeneration) return;
        const metadata = protonRouteMetadata(raw);
        if (!metadata) return;
        const pingMs = isValidProtonPing(raw.pingMs) ? raw.pingMs : undefined;
        const pingDiscarded = raw.pingMs !== undefined && pingMs === undefined;
        const current = measurement.routes.get(metadata.server);
        if (!current) {
            // Sem país, tier, carga e score não há o que catalogar: um evento de
            // ping para servidor ainda desconhecido não cria candidata.
            if (metadata.country === undefined || metadata.tier === undefined
                || metadata.load === undefined || metadata.score === undefined) return;
            measurement.routes.set(metadata.server, {
                entry: {
                    server: metadata.server,
                    country: metadata.country,
                    city: metadata.city ?? "",
                    tier: metadata.tier,
                    load: metadata.load,
                    score: metadata.score,
                    ...(pingMs === undefined ? {} : { pingMs }),
                },
                status: pingMs !== undefined ? "success" : statusHint === "failed" ? "failed" : "testing",
            });
            return;
        }
        // Metadados já catalogados nunca são apagados por um evento parcial.
        const previousPing = pingMs ?? current.entry.pingMs;
        current.entry = {
            server: metadata.server,
            country: metadata.country ?? current.entry.country,
            city: metadata.city ?? current.entry.city,
            tier: metadata.tier ?? current.entry.tier,
            load: metadata.load ?? current.entry.load,
            score: metadata.score ?? current.entry.score,
            ...(previousPing === undefined ? {} : { pingMs: previousPing }),
        };
        if (pingMs !== undefined) {
            current.status = "success";
            return;
        }
        if (statusHint === "failed" || pingDiscarded) {
            current.status = "failed";
            delete current.entry.pingMs;
        }
    }

    private routeCatalogViews(measurement: ProtonRouteMeasurement): ProtonRouteCatalogView[] {
        return [...measurement.routes.values()].map(candidate => ({
            ...candidate.entry,
            status: candidate.status,
        }));
    }

    private publicRouteSelection(generated: proton.ProtonManualRouteResult, server: string): ProtonRouteSelectionResult {
        const metadata = protonRouteMetadata(generated);
        return {
            success: true,
            server,
            country: metadata?.country,
            city: metadata?.city,
            tier: metadata?.tier,
            load: metadata?.load,
            score: metadata?.score,
            pingMs: isValidProtonPing(generated.pingMs) ? generated.pingMs : undefined,
        };
    }

    private readProtonProfileBackup(): ProtonProfileBackup | null {
        if (!fs.existsSync(this.profilePath)) return null;
        const profile = fs.readFileSync(this.profilePath, "utf8");
        const account = fs.existsSync(this.profileAccountPath)
            ? fs.readFileSync(this.profileAccountPath, "utf8")
            : null;
        return { profile, account };
    }

    private restoreProtonProfileBackup(backup: ProtonProfileBackup): void {
        this.writeProfileAtomically(backup.profile);
        if (backup.account === null) {
            this.clearProtonProfileAccount();
            return;
        }
        fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
        const temporary = `${this.profileAccountPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, backup.account, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temporary, this.profileAccountPath);
    }

    /** Devolve o erro de rollback, se houver; nunca lança por cima da falha original. */
    private async rollbackRouteSelection(
        backup: ProtonProfileBackup | null,
        wasActive: boolean,
        profilePromoted: boolean,
    ): Promise<string | null> {
        let failure: string | null = null;
        if (backup) {
            try {
                this.restoreProtonProfileBackup(backup);
            } catch (error) {
                failure = `O perfil anterior não foi restaurado: ${errorMessage(error)}`;
                this.options.log("error", "não consegui restaurar o perfil Proton anterior", { erro: errorMessage(error) });
            }
        } else if (profilePromoted) {
            try {
                fs.rmSync(this.profilePath, { force: true });
                this.clearProtonProfileAccount();
            } catch (error) {
                failure = `O perfil novo não foi removido: ${errorMessage(error)}`;
                this.options.log("error", "não consegui remover o perfil Proton novo após falha", { erro: errorMessage(error) });
            }
        }
        if (wasActive && !isLinux()) {
            const restored = await this.startInternal(false);
            if (!restored.success) {
                const detail = restored.error || "não foi possível reativar a rota WireGuard anterior";
                failure = failure ? `${failure} ${detail}` : detail;
                this.options.log("error", "rota anterior não voltou após falha da seleção manual", { erro: detail });
            }
        }
        return failure;
    }

    private sweepRouteMeasurement(): void {
        const measurement = this.routeMeasurement;
        if (!measurement || measurement.active) return;
        if (measurement.expiresAt > Date.now()) return;
        this.routeMeasurement = null;
    }

    private invalidateRouteMeasurement(): void {
        const measurement = this.routeMeasurement;
        this.routeMeasurement = null;
        this.routeMeasurementGeneration++;
        measurement?.controller.abort();
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
        const existing = this.inspectWindows();
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
            // Diferente do modo automático (adota o boot em enableAutomatic), um pedido
            // explícito precisa deixar ESTE Discord dentro da rota: as conexões abertas
            // antes de o filtro por aplicativo existir continuam fora do túnel, e o
            // onboarding concluído promete ativação + reinício. Sem o relaunch o clique
            // "ativava" em silêncio e nada mudava no cliente.
            if (relaunch && !this.restarting) {
                if (!await this.requestRelaunch())
                    return { success: false, state: this.state, error: "A VPN já estava ativa, mas não consegui reiniciar o Discord para aplicar a rota." };
                return { success: true, state: "restart_pending", message: "VPN já estava ativa; o Discord será reiniciado para aplicar a rota." };
            }
            return { success: true, state: "active", message: this.statusMessage() };
        }
        // Conflito gerenciado (GUI/pool do GoLiveBypass) não é VPN externa: somente a
        // ativação explícita (`relaunch`) pode retomá-lo. Boot, restauração interna,
        // watchdog e status continuam sem encerrar processos.
        const managedConflict = relaunch && existing.active && !existing.owned
            && (existing.origin === "gui" || existing.origin === "managed");
        if (existing.active && !existing.owned && !managedConflict) {
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
            let startedResult: windows.WireSockStartResult | null = null;
            for (let attempt = 0; attempt < 2 && startedResult === null; attempt++) {
                if (managedConflict || attempt > 0) {
                    const takeover = await windows.stopManagedWireSock(this.serviceConfigPath, this.guiConfigPath, this.options.log);
                    if (!takeover.stopped) throw new Error(takeover.error || "A retomada da instância GoLiveBypass falhou.");
                }
                try {
                    startedResult = await windows.startWireSockService(this.serviceConfigPath, raw, apps, this.options.log);
                } catch (startError) {
                    // Uma instância gerenciada pode reaparecer entre o preflight e a
                    // instalação do serviço (a GUI reativa sozinha). Um único retry com
                    // nova retomada; nada de loop.
                    const reinspect = this.inspectWindows();
                    const managedAgain = reinspect.reliable && reinspect.active && !reinspect.owned
                        && (reinspect.origin === "gui" || reinspect.origin === "managed");
                    if (attempt === 0 && managedAgain) {
                        this.options.log("warn", "instância gerenciada reapareceu durante a ativação; retomando de novo", { mode: "diagnostic-only" });
                        continue;
                    }
                    throw startError;
                }
            }
            if (!startedResult) throw new Error("Não foi possível iniciar o serviço WireSock após a retomada.");
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
            const currentInspection = this.inspectWindows();
            // Só derruba o túnel que ESTA tentativa criou. Quando o erro é o conflito com
            // outra instância viva (claimActiveOwnership recusa o lock alheio), o WireSock
            // ativo é dela: derrubá-lo aqui destruía uma VPN que estava funcionando e ainda
            // alimentava o ciclo de reinício -- o boot seguinte via a rede caída, reativava
            // com relaunch e o Discord reiniciava de novo.
            const ownsCurrentTunnel = sameOwnership(this.ownershipToken, this.readOwner());
            if (started || (currentInspection.reliable && currentInspection.active && currentInspection.owned && ownsCurrentTunnel)) {
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
        const inspection = this.inspectWindows();
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
                // Mesmo caso do caminho com a rede ativa: o lock pode ter passado para a
                // instancia nova do relaunch, e isso nao e falha nossa.
                if (this.ownershipTakenOver(owner)) {
                    this.options.log("info", "lock da VPN assumido por outra instância; nada a liberar");
                } else {
                    this.state = "recovery_required";
                    this.setDiagnostic("ownership", false, "não foi possível liberar o lock durante a restauração");
                    return { success: false, state: this.state, error: "A rede está inativa, mas o lock da VPN ficou pendente." };
                }
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
            // "Nao consegui liberar o lock" e "o lock passou para outra instancia" sao coisas
            // diferentes: no relaunch o processo novo sobe e adota o lock enquanto este ainda
            // esta saindo. Tratar isso como falha marcava recovery_required e abortava o
            // fechamento -- a origem do processo zumbi sem interface. Apagar o lock da outra
            // instancia seria pior: quem manda no tunel agora e ela.
            if (this.ownershipTakenOver(owner)) {
                this.options.log("info", "lock da VPN assumido por outra instância; nada a liberar");
            } else {
                this.state = "recovery_required";
                this.setDiagnostic("ownership", false, "não foi possível liberar o lock durante a restauração");
                return { success: false, state: this.state, error: "A rede foi restaurada, mas o lock da VPN ficou pendente." };
            }
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
                // O relaunch Linux tambem deixa a instancia nova assumir o owner enquanto esta
                // sai (o bridge pede o relaunch externo e grava o owner antes do exit).
                if (this.ownershipTakenOver(owner)) {
                    this.options.log("info", "owner Linux assumido por outra instância; nada a liberar");
                } else {
                    this.state = "recovery_required";
                    this.setDiagnostic("ownership", false, "não foi possível liberar o owner Linux durante a restauração");
                    return { success: false, state: this.state, error: "A rede foi restaurada, mas o owner Linux ficou pendente." };
                }
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
            const inspection = this.inspectWindows();
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
                    confirmation = this.inspectWindows();
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
            const inspection = this.inspectWindows();
            if (isUnknownWireSockInspection(inspection)) throw new Error(unknownWireSockMessage(inspection));
            // Conflito gerenciado (GUI/pool do GoLiveBypass) não bloqueia a reserva do lock:
            // a retomada acontece depois, no start, já sob posse desta instância. WireSock
            // externo ou leitura desconhecida continuam recusados aqui.
            const managedConflict = inspection.reliable && inspection.active && !inspection.owned
                && (inspection.origin === "gui" || inspection.origin === "managed");
            if (inspection.reliable && inspection.active && !inspection.owned && !managedConflict)
                throw new Error(inspection.reason || "WireSock externo está ativo.");
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

    // Verdadeiro quando o lock deixou de ser nosso porque OUTRA instancia o assumiu. Acontece
    // de verdade no relaunch: o processo novo sobe, adota o WireSock e grava o proprio pid
    // enquanto o antigo ainda esta no before-quit. Nao ha o que liberar -- quem manda no tunel
    // agora e a outra instancia, e apagar o lock dela seria pior.
    private ownershipTakenOver(owner: VpnOwnerRecord): boolean {
        const current = this.readOwner();
        return current !== null && !sameOwnership(current, owner);
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
