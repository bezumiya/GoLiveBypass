import fs from "fs";
import path from "path";
import { app } from "electron";

import * as proton from "./vpn-proton";
import * as windows from "./vpn-windows";
import {
    VPN_OWNER_KIND,
    VPN_SCHEMA_VERSION,
    isSupportedWindowsArchitecture,
    normalizeVpnSettings,
    safeDiagnosticDetail,
    type VpnDiagnostic,
    type VpnOwnerRecord,
    type VpnSettings,
    type VpnState,
    type VpnStatus,
    type VpnOperationResult,
} from "./vpn-types";

export type ControllerLog = windows.WireSockLogger;

export interface PluginVpnControllerOptions {
    dataDir: string;
    guiDataDir: string;
    readSettings: () => unknown;
    isEnabled: () => boolean;
    log: ControllerLog;
}

export interface ProtonLoginPayload {
    username: string;
    password?: string;
    twoFactorCode?: string;
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
const SERVICE_CONFIG_FILE = "wiresock-discord.conf";
const WATCHDOG_MS = 15_000;

function errorMessage(error: unknown): string {
    return safeDiagnosticDetail(error, 600);
}

function isWindows(): boolean {
    return process.platform === "win32";
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
    return value.trim().slice(0, 320);
}

export class PluginVpnController {
    private readonly options: PluginVpnControllerOptions;
    private readonly dataDir: string;
    private readonly profilePath: string;
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
    private optimization: { id: string; controller: AbortController } | null = null;

    public constructor(options: PluginVpnControllerOptions) {
        this.options = options;
        this.dataDir = path.resolve(options.dataDir);
        this.profilePath = path.join(this.dataDir, PROFILE_FILE);
        this.serviceConfigPath = path.join(this.dataDir, SERVICE_CONFIG_FILE);
        this.ownerPath = path.join(this.dataDir, OWNER_FILE);
    }

    public get paths() {
        return { dataDir: this.dataDir, profilePath: this.profilePath, serviceConfigPath: this.serviceConfigPath, ownerPath: this.ownerPath };
    }

    public isRelaunching(): boolean {
        return this.restarting;
    }

    public hasCleanupWork(): boolean {
        const inspection = windows.inspectWireSock(this.serviceConfigPath);
        if (inspection.active) return inspection.owned;
        if (this.state === "blocked_external") return false;
        if (this.state === "inactive") return this.readOwner() !== null;
        return true;
    }

    public async initialize(): Promise<void> {
        if (this.initialized || !isWindows()) return;
        this.initialized = true;
        try {
            await this.migrateGuiState();
            const owner = this.readOwner();
            const inspection = windows.inspectWireSock(this.serviceConfigPath);
            if (!inspection.active) {
                if (owner) this.releaseOwnership(owner);
                this.state = "inactive";
                return;
            }
            if (!inspection.owned) {
                this.blockExternal(inspection.reason || "WireSock externo já está ativo.");
                return;
            }
            if (!this.options.isEnabled()) {
                this.options.log("warn", "WireSock próprio encontrado com o plugin desativado; restaurando a rede");
                await this.stopInternal(false);
                return;
            }
            this.generation = Math.max(this.generation, owner?.generation ?? 0);
            this.adoptOwnership(owner, inspection);
            this.state = "active";
            this.discordPid = process.pid;
            this.startWatchdog();
            this.startDiagnostics("adoption");
            this.options.log("info", "sessão WireSock própria adotada após inicialização", { generation: this.generation });
        } catch (error) {
            this.state = "recovery_required";
            this.setDiagnostic("ownership", false, errorMessage(error));
            this.options.log("error", "falha ao recuperar sessão VPN no boot", { erro: errorMessage(error) });
        }
    }

    public getStatus(): VpnStatus {
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
        if (this.state === "active" && inspection.active && !inspection.owned) {
            this.state = "blocked_external";
            this.externalReason = inspection.reason;
            this.stopWatchdog();
        }
        const active = this.state === "active" && inspection.active && inspection.owned;
        return {
            state: this.state,
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
            message: this.statusMessage(),
        };
    }

    public enable(): Promise<VpnOperationResult> {
        return this.serial(() => this.startInternal(true));
    }

    public shutdown(relaunch = true): Promise<VpnOperationResult> {
        return this.serial(() => this.stopInternal(relaunch));
    }

    public restoreNetwork(): Promise<VpnOperationResult> {
        return this.serial(() => this.stopInternal(false));
    }

    public async importCustomConfig(sourcePath: string): Promise<{ success: boolean; error?: string; path?: string }> {
        try {
            if (!isWindows()) throw new Error("A VPN do plugin nesta versão exige Windows x64.");
            const source = path.resolve(sourcePath.trim());
            if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("Arquivo WireGuard não encontrado.");
            const raw = fs.readFileSync(source, "utf8");
            const validation = windows.validateWireGuardProfile(raw);
            if (!validation.valid) throw new Error(validation.error);
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
            const validation = windows.validateWireGuardProfile(fs.readFileSync(target, "utf8"));
            if (!validation.valid) throw new Error(validation.error);
            return { success: true, path: target };
        } catch (error) {
            return { success: false, error: errorMessage(error) };
        }
    }

    public async loginProton(payload: ProtonLoginPayload, solveCaptcha: (url: string) => Promise<string | null>): Promise<proton.ProtonLoginResult> {
        const username = normalizeUsername(payload.username);
        let result = await proton.loginProton(this.dataDir, username, payload.password, payload.twoFactorCode, undefined, this.options.log);
        for (let attempt = 0; attempt < 3 && (result.code === "CAPTCHA_REQUIRED" || result.code === "CAPTCHA_INVALID"); attempt++) {
            if (!result.captchaUrl) break;
            const token = await solveCaptcha(result.captchaUrl);
            if (!token) return { success: false, code: "CAPTCHA_CANCELLED", message: "A verificação Proton foi cancelada.", retryable: true };
            result = await proton.loginProton(this.dataDir, username, payload.password, payload.twoFactorCode, token, this.options.log);
        }
        return result;
    }

    public checkProtonSession(username: string) {
        return proton.checkProtonSession(this.dataDir, normalizeUsername(username));
    }

    public getProtonPlan(username: string) {
        return proton.getProtonPlan(this.dataDir, normalizeUsername(username), this.options.log);
    }

    public logoutProton(): boolean {
        return proton.removeProtonSession(this.dataDir);
    }

    public async optimizeProton(options: ProtonOptimizationOptions): Promise<proton.ProtonOptimizationResult & { cancelled?: boolean; deferred?: boolean }> {
        return this.serial(async () => {
            if (!isWindows() || process.arch !== "x64") return { success: false, error: "A VPN do plugin nesta versão exige Windows x64." };
            const settings = this.settings();
            const username = normalizeUsername(settings.protonUsername);
            if (!username) return { success: false, error: "Faça login com sua conta Proton antes de otimizar a rota." };
            if (this.optimization) return { success: false, error: "Já existe uma otimização Proton em andamento." };

            const wasActive = this.getStatus().active;
            if (this.state === "blocked_external") return { success: false, error: this.externalReason || "WireSock externo está ativo." };
            if (wasActive) {
                const stopped = await this.stopInternal(false);
                if (!stopped.success) return { success: false, error: stopped.error || "Não foi possível pausar a VPN para otimizar a rota." };
            }

            const restorePreviousRoute = async (): Promise<string | null> => {
                if (!wasActive) return null;
                const restored = await this.startInternal(true);
                return restored.success ? null : restored.error || "Não foi possível reativar a rota WireGuard anterior.";
            };

            const id = options.requestId || `proton-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const controller = new AbortController();
            this.optimization = { id, controller };
            try {
                let result: proton.ProtonOptimizationResult;
                try {
                    result = await proton.generateOptimalProtonConfig(this.dataDir, {
                        username,
                        country: options.country ?? settings.protonCountry,
                        freeOnly: options.freeOnly ?? settings.protonFreeOnly,
                        autoPing: options.autoPing ?? settings.protonAutoPing,
                        speedTest: options.speedTest === true,
                        signal: controller.signal,
                        onProgress: progress => options.onProgress?.({ ...progress, requestId: id }),
                        log: this.options.log,
                    });
                } catch (error) {
                    const restoreError = await restorePreviousRoute();
                    if (restoreError) this.options.log("error", "otimização falhou e a rota anterior não voltou", { erro: restoreError });
                    throw error;
                }
                if (controller.signal.aborted) {
                    const restoreError = await restorePreviousRoute();
                    return { success: false, cancelled: true, error: restoreError || "Otimização Proton cancelada." };
                }
                if (result.success && wasActive) {
                    const restartError = await restorePreviousRoute();
                    if (restartError) return { ...result, success: false, error: restartError };
                } else if (!result.success && wasActive) {
                    const restoreError = await restorePreviousRoute();
                    if (restoreError) return { ...result, error: `${result.error || "A otimização falhou."} ${restoreError}` };
                }
                return result;
            } finally {
                this.optimization = null;
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
            case "preparing": return "Preparando perfil e WireSock";
            case "starting": return "Iniciando túnel WireGuard";
            case "restart_pending": return "VPN preparada; reiniciando Discord";
            case "stopping": return "Restaurando rede normal";
            case "blocked_external": return this.externalReason || "WireSock externo está ativo";
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
        this.setDiagnostic("ownership", false, this.externalReason);
        this.stopWatchdog();
        this.options.log("warn", "VPN recusada para preservar WireSock externo", { motivo: this.externalReason });
    }

    private async startInternal(relaunch: boolean): Promise<VpnOperationResult> {
        if (!isSupportedWindowsArchitecture(process.platform, process.arch)) {
            this.state = "blocked_external";
            this.externalReason = "A VPN do plugin nesta versão está disponível somente no Windows x64.";
            return { success: false, state: this.state, error: this.externalReason };
        }
        const existing = windows.inspectWireSock(this.serviceConfigPath);
        if (existing.active && existing.owned) {
            if (this.state !== "active") {
                const owner = this.readOwner();
                this.generation = Math.max(this.generation, owner?.generation ?? 0);
                this.adoptOwnership(owner, existing);
                this.state = "active";
                this.discordPid = process.pid;
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
        let owner: VpnOwnerRecord | null = null;
        let started = false;
        try {
            await this.migrateGuiState();
            const settings = this.settings();
            if (settings.mode === "proton") {
                if (!settings.protonUsername) throw new Error("Faça login com sua conta Proton antes de ativar.");
                if (!fs.existsSync(this.profilePath)) {
                    const generated = await proton.generateOptimalProtonConfig(this.dataDir, {
                        username: settings.protonUsername,
                        country: settings.protonCountry,
                        freeOnly: settings.protonFreeOnly,
                        autoPing: settings.protonAutoPing,
                        log: this.options.log,
                    });
                    if (!generated.success) throw new Error(generated.error || "Não foi possível gerar a configuração Proton.");
                }
            } else if (settings.customConfigPath) {
                const imported = await this.importCustomConfig(settings.customConfigPath);
                if (!imported.success) throw new Error(imported.error);
            }
            const raw = fs.readFileSync(this.profilePath, "utf8");
            const validation = windows.validateWireGuardProfile(raw);
            if (!validation.valid) throw new Error(validation.error);

            owner = this.acquireOwnership();
            const apps = this.discordAllowedApps();
            const probe = this.prepareRouteProbe();
            if (probe) apps.push(probe);
            owner.probePath = probe;
            this.writeOwner(owner);
            this.state = "starting";
            const startedResult = await windows.startWireSockService(this.serviceConfigPath, raw, apps, this.options.log);
            started = true;
            owner.configPath = startedResult.configPath;
            owner.restarting = relaunch;
            this.writeOwner(owner);
            this.discordPid = process.pid;
            this.state = relaunch ? "restart_pending" : "active";
            this.startWatchdog();
            this.startDiagnostics("activation");
            if (relaunch) {
                if (!this.requestRelaunch()) {
                    this.state = "active";
                    owner.restarting = false;
                    this.writeOwner(owner);
                    return { success: false, state: this.state, error: "A VPN foi iniciada, mas não consegui reiniciar o Discord para aplicar a rota." };
                }
                return { success: true, state: "restart_pending", message: "VPN preparada; o Discord será reiniciado." };
            }
            return { success: true, state: "active", message: this.statusMessage() };
        } catch (error) {
            this.stopWatchdog();
            if (started || windows.inspectWireSock(this.serviceConfigPath).active) {
                const cleanup = await windows.stopOwnedWireSock(this.serviceConfigPath, this.options.log);
                if (!cleanup.stopped) {
                    this.state = "recovery_required";
                    this.setDiagnostic("wireguard", false, cleanup.error || "limpeza incompleta");
                    return { success: false, state: this.state, error: `A ativação falhou e a rede não foi restaurada: ${cleanup.error || "limpeza incompleta"}.` };
                }
            }
            if (owner) this.releaseOwnership(owner);
            this.removeProbe();
            this.state = "inactive";
            const message = errorMessage(error);
            this.setDiagnostic("wireguard", false, message);
            this.options.log("error", "ativação VPN falhou", { erro: message });
            return { success: false, state: this.state, error: message };
        }
    }

    private async stopInternal(relaunch: boolean): Promise<VpnOperationResult> {
        if (!isSupportedWindowsArchitecture(process.platform, process.arch)) return { success: false, state: "blocked_external", error: "A VPN do plugin nesta versão exige Windows x64." };
        this.stopWatchdog();
        const inspection = windows.inspectWireSock(this.serviceConfigPath);
        const owner = this.readOwner();
        const needsInactiveCleanup = Boolean(owner)
            || this.state === "preparing"
            || this.state === "starting"
            || this.state === "stopping"
            || this.state === "restart_pending"
            || this.state === "recovery_required";
        if (!inspection.active && !needsInactiveCleanup) {
            if (owner) this.releaseOwnership(owner);
            this.removeProbe();
            this.state = "inactive";
            this.discordPid = null;
            return { success: true, state: this.state, message: this.statusMessage() };
        }
        if (inspection.active && !inspection.owned) {
            this.blockExternal(inspection.reason || "WireSock externo está ativo; não será interrompido.");
            return { success: false, state: this.state, error: this.externalReason || undefined };
        }
        this.state = "stopping";
        const cleanup = await windows.stopOwnedWireSock(this.serviceConfigPath, this.options.log);
        if (!cleanup.stopped) {
            this.state = "recovery_required";
            this.setDiagnostic("wireguard", false, cleanup.error || "limpeza incompleta");
            return { success: false, state: this.state, error: cleanup.error || "Não foi possível restaurar a rede." };
        }
        this.removeProbe();
        if (owner) this.releaseOwnership(owner);
        this.discordPid = null;
        this.state = "inactive";
        this.externalReason = null;
        this.setDiagnostic("wireguard", true, "serviço WireSock próprio parado e rede restaurada");
        if (relaunch && !this.restarting) {
            if (!this.requestRelaunch())
                return { success: false, state: this.state, error: "A rede foi restaurada, mas não consegui reiniciar o Discord." };
            return { success: true, state: "restart_pending", message: "Rede restaurada; o Discord será reiniciado." };
        }
        return { success: true, state: this.state, message: this.statusMessage() };
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
            return target;
        } catch (error) {
            this.options.log("warn", "helper de diagnóstico não foi incluído em AllowedApps", { erro: errorMessage(error) });
            return undefined;
        }
    }

    private removeProbe(): void {
        if (this.probePath) windows.removeRouteProbe(this.probePath);
        const owner = this.readOwner();
        if (owner?.probePath) windows.removeRouteProbe(owner.probePath);
        this.probePath = undefined;
    }

    private startDiagnostics(stage: string): void {
        void windows.diagnoseWindowsNetwork(this.options.log).then(result => {
            this.setDiagnostic("network", result.ok, `${stage}: ${result.detail}`);
        }).catch(error => this.setDiagnostic("network", false, error));

        const owner = this.readOwner();
        const probePath = owner?.probePath;
        if (!probePath || !fs.existsSync(probePath)) return;
        void windows.runRouteProbe(probePath).then(result => {
            this.setDiagnostic("route", Boolean(result?.success), safeDiagnosticDetail(JSON.stringify(result || { error: "resposta vazia" }), 500));
            this.options.log(result?.success ? "info" : "warn", "probe de rota do Discord concluído", { stage, result: safeDiagnosticDetail(JSON.stringify(result || {}), 500), mode: "log-only" });
        }).catch(error => {
            this.setDiagnostic("route", false, error);
            this.options.log("warn", "probe de rota do Discord falhou", { stage, erro: errorMessage(error), mode: "log-only" });
        });
    }

    private async checkWatchdog(): Promise<void> {
        if (this.watchdogChecking || this.state !== "active") return;
        this.watchdogChecking = true;
        try {
            const inspection = windows.inspectWireSock(this.serviceConfigPath);
            if (!inspection.active) {
                // WMI/sc.exe can briefly return an empty snapshot while the
                // service is still alive. Confirm across several samples for
                // evidence, but keep this probe diagnostic-only.
                let confirmation = inspection;
                for (let attempt = 0; attempt < 5 && !confirmation.active; attempt++) {
                    await new Promise<void>(resolve => setTimeout(resolve, 1_000));
                    if (this.state !== "active") return;
                    confirmation = windows.inspectWireSock(this.serviceConfigPath);
                }
                if (!confirmation.active) {
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
        if (this.watchdog || !isWindows()) return;
        this.watchdog = setInterval(() => {
            void this.checkWatchdog();
        }, WATCHDOG_MS);
        this.watchdog.unref?.();
    }

    private stopWatchdog(): void {
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
    }

    private requestRelaunch(): boolean {
        const owner = this.readOwner();
        if (owner) {
            owner.pid = process.pid;
            owner.restarting = true;
            this.writeOwner(owner);
        }
        this.restarting = true;
        try {
            app.relaunch();
            app.exit(0);
            return true;
        } catch (error) {
            this.restarting = false;
            if (owner) {
                owner.restarting = false;
                this.writeOwner(owner);
            }
            this.options.log("error", "não consegui solicitar reinício do Discord", { erro: errorMessage(error) });
            return false;
        }
    }

    private acquireOwnership(): VpnOwnerRecord {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const existing = this.readOwner();
        const inspection = windows.inspectWireSock(this.serviceConfigPath);
        if (inspection.active && !inspection.owned) throw new Error(inspection.reason || "WireSock externo está ativo.");
        if (existing?.pid === process.pid) {
            this.probePath = existing.probePath;
            return existing;
        }
        if (existing && existing.pid !== process.pid) {
            if (existing.restarting && inspection.active && inspection.owned) {
                this.generation = Math.max(this.generation, existing.generation);
                this.probePath = existing.probePath;
                return { ...existing, pid: process.pid, restarting: false };
            }
            if (processAlive(existing.pid)) throw new Error("Outra instância do GoLiveBypass já controla a VPN.");
            if (inspection.active && inspection.owned) {
                this.generation = Math.max(this.generation, existing.generation);
                this.probePath = existing.probePath;
                return { ...existing, pid: process.pid, restarting: false };
            }
            this.releaseOwnership(existing);
        }
        const owner: VpnOwnerRecord = {
            kind: VPN_OWNER_KIND,
            pid: process.pid,
            generation: this.generation,
            profilePath: this.profilePath,
            configPath: this.serviceConfigPath,
            createdAt: Date.now(),
        };
        try {
            const descriptor = fs.openSync(this.ownerPath, "wx");
            fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8");
            fs.closeSync(descriptor);
        } catch (error) {
            const current = this.readOwner();
            if (current && processAlive(current.pid)) throw new Error("Outra instância do GoLiveBypass já controla a VPN.");
            throw new Error(`Não foi possível reservar ownership da VPN: ${errorMessage(error)}`);
        }
        this.probePath = undefined;
        return owner;
    }

    private adoptOwnership(previous: VpnOwnerRecord | null, inspection: windows.WireSockInspection): void {
        const source: VpnOwnerRecord = previous ?? {
            kind: VPN_OWNER_KIND,
            pid: process.pid,
            generation: this.generation,
            profilePath: this.profilePath,
            configPath: this.serviceConfigPath,
            createdAt: Date.now(),
        } satisfies VpnOwnerRecord;
        this.probePath = source.probePath;
        this.writeOwner({ ...source, pid: process.pid, configPath: this.serviceConfigPath, profilePath: this.profilePath, restarting: false });
        this.options.log("info", "ownership do WireSock confirmado", { services: inspection.services, pids: inspection.processIds });
    }

    private readOwner(): VpnOwnerRecord | null {
        try {
            const value = JSON.parse(fs.readFileSync(this.ownerPath, "utf8")) as Partial<VpnOwnerRecord>;
            const pid = value.pid;
            const generation = value.generation;
            const profilePath = value.profilePath;
            const configPath = value.configPath;
            const createdAt = value.createdAt;
            if (value.kind !== VPN_OWNER_KIND || typeof pid !== "number" || !Number.isInteger(pid) || typeof generation !== "number" || !Number.isInteger(generation)) return null;
            if (typeof profilePath !== "string" || typeof configPath !== "string" || typeof createdAt !== "number") return null;
            if (path.resolve(profilePath) !== this.profilePath || path.resolve(configPath) !== this.serviceConfigPath) return null;
            return {
                kind: VPN_OWNER_KIND,
                pid,
                generation,
                profilePath: this.profilePath,
                configPath: this.serviceConfigPath,
                probePath: typeof value.probePath === "string" ? value.probePath : undefined,
                restarting: value.restarting === true,
                createdAt,
            };
        } catch { return null; }
    }

    private writeOwner(owner: VpnOwnerRecord): void {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const temporary = `${this.ownerPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(owner), "utf8");
        fs.renameSync(temporary, this.ownerPath);
    }

    private releaseOwnership(owner: VpnOwnerRecord): void {
        const current = this.readOwner();
        if (!current || current.kind !== owner.kind || current.configPath !== owner.configPath) return;
        try { fs.rmSync(this.ownerPath, { force: true }); } catch (error) { this.options.log("warn", "não consegui remover lock da VPN", { erro: errorMessage(error) }); }
    }

    private writeProfileAtomically(raw: string): void {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const temporary = `${this.profilePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, raw, "utf8");
        fs.renameSync(temporary, this.profilePath);
    }

    private async migrateGuiState(): Promise<void> {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const markerPath = path.join(this.dataDir, MIGRATION_FILE);
        if (fs.existsSync(markerPath)) return;
        const copies = [PROFILE_FILE, "proton-session.json"];
        for (const file of copies) {
            const source = path.join(this.options.guiDataDir, file);
            const target = path.join(this.dataDir, file);
            if (fs.existsSync(source) && !fs.existsSync(target)) {
                try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); this.options.log("info", "estado compatível da GUI importado", { arquivo: file }); }
                catch (error) { this.options.log("warn", "não consegui importar estado da GUI", { arquivo: file, erro: errorMessage(error) }); }
            }
        }
        const temporary = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ schema: VPN_SCHEMA_VERSION, completedAt: Date.now(), source: "gui-compatible-profile-only" }), "utf8");
        fs.renameSync(temporary, markerPath);
    }
}

export function defaultPluginVpnDataDir(): string {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || osFallbackHome();
    return path.join(base, "GoLiveBypass", "plugin-vpn");
}

function osFallbackHome(): string {
    return process.env.USERPROFILE || process.env.HOME || ".";
}
