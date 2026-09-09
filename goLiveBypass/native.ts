/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
    appendFileSync,
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "fs";
import { execFileSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import { request } from "https";
import { basename, dirname, join, resolve } from "path";
import { tmpdir } from "os";

import {
    choosePluginRelease,
    comparePluginVersions,
    normalizePluginVersion,
    type PluginReleaseCandidate,
    type PluginUpdateChannel,
} from "./update-channel";
import { isCompatiblePluginManifest, releaseAssetUrl, securePluginUpdateUrl } from "./update-security";
import { defaultPluginVpnDataDir, PluginVpnController, type ProtonLoginPayload, type ProtonOptimizationOptions } from "./vpn-controller";
import * as proton from "./vpn-proton";
import { safeDiagnosticDetail } from "./vpn-types";

const PLUGIN_VERSION = "2.0.0-beta.1";
const PLUGIN_ASSET = "goLiveBypass-vencord.zip";
const PLUGIN_CHECKSUM_ASSET = `${PLUGIN_ASSET}.sha256`;
const GITHUB_RELEASES_URL = "https://api.github.com/repos/bezumiya/GoLiveBypass/releases?per_page=20";
const PLUGIN_UPDATE_TIMEOUT_MS = 30_000;
const UNKNOWN_PLUGIN_VERSION = "unknown";
const PLUGIN_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const PLUGIN_UPDATE_INITIAL_DELAY_MS = 8_000;
const PLUGIN_API_MAX_BYTES = 2 * 1024 * 1024;
const PLUGIN_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
const PLUGIN_MAX_REDIRECTS = 4;
const USERPLUGIN_DIR = "goLiveBypass";
const UPDATE_STAGING_DIR = ".golivebypass-update-staging";
const REQUIRED_PLUGIN_FILES = [
    "index.tsx",
    "native.ts",
    "update-channel.ts",
    "update-security.ts",
    "stability.ts",
    "vpn-controller.ts",
    "vpn-proton.ts",
    "vpn-types.ts",
    "vpn-windows.ts",
    "manifest.json",
    "bin/win32-x64/proton-confgen.exe",
] as const;
const USERPLUGIN_BUILD_TIMEOUT_MS = 120_000;
const PENDING_UPDATE_FILE = "plugin-update-pending.json";
const UPDATE_LOCK_FILE = "plugin-update.lock";
const BACKUP_DIR = ".golivebypass-update-backups";
const SAFE_BACKUP_NAME = /^goLiveBypass-[0-9]{10,}$/;
const SAFE_DISPLACED_NAME = /^goLiveBypass-pending-[0-9]{10,}$/;
const MAX_LOG_LINES = 400;
const MAX_LOG_BYTES = 256 * 1024;
const CAPTCHA_IPC_CHANNEL = "golive-plugin-proton-captcha-response";
const CAPTCHA_TIMEOUT_MS = 120_000;
const SOURCE_DIGEST_PATTERN = /^[a-f0-9]{64}$/i;

const VPN_DATA_DIR = defaultPluginVpnDataDir();
const GUI_DATA_DIR = dirname(VPN_DATA_DIR);
const LOG_FILE = join(VPN_DATA_DIR, "plugin-vpn.log");

const history: string[] = [];
let quitting = false;

type PluginUpdatePolicy = { enabled: boolean; channel: PluginUpdateChannel };
type PendingPluginUpdatePhase = "preparing" | "prepared" | "rolling-back";
type PendingPluginUpdate = {
    version: string;
    channel: PluginUpdateChannel;
    prerelease: boolean;
    digest: string;
    // Marcadores anteriores a esta prova continuam legíveis para diagnóstico,
    // mas nunca são usados para confirmar ou descartar uma árvore preparada.
    sourceDigest?: string;
    // "preparing" é um journal de intenção: permite recuperar o checkout se o
    // processo morrer durante a troca. Ausência significa o formato preparado
    // usado antes do journal persistente.
    phase: PendingPluginUpdatePhase;
    displacedName?: string;
    backupName: string;
    createdAt: number;
};

type TrustedPendingPluginUpdate = PendingPluginUpdate & { sourceDigest: string };

type PendingUpdateInspection = {
    pending: PendingPluginUpdate | null;
    trusted: TrustedPendingPluginUpdate | null;
    error: string | null;
};

type PluginUpdateCheckResult = {
    ok: true;
    current: string;
    channel: PluginUpdateChannel;
    latest: string;
    available: boolean;
    pending: boolean;
    pendingChannel?: PluginUpdateChannel;
} | {
    ok: false;
    current: string;
    channel: PluginUpdateChannel;
    latest?: string;
    available: false;
    pending: boolean;
    pendingChannel?: PluginUpdateChannel;
    error: string;
};

type PluginUpdateResult = {
    ok: true;
    updated: boolean;
    current: string;
    latest: string;
    channel: PluginUpdateChannel;
    pending: boolean;
    pendingChannel?: PluginUpdateChannel;
    reloadRequired: boolean;
} | {
    ok: false;
    updated: false;
    current: string;
    channel: PluginUpdateChannel;
    pending: boolean;
    pendingChannel?: PluginUpdateChannel;
    error: string;
};

type PluginUpdateFlight<T> = {
    policyKey: string;
    revision: number;
    controller: AbortController;
    promise: Promise<T>;
};

type PluginUpdateLock = {
    fd: number;
    token: string;
    depth: number;
};

let pluginUpdatePolicy: PluginUpdatePolicy = { enabled: true, channel: "stable" };
let pluginUpdateInitialTimer: ReturnType<typeof setTimeout> | undefined;
let pluginUpdatePeriodicTimer: ReturnType<typeof setInterval> | undefined;
let pluginUpdateCheckFlight: PluginUpdateFlight<PluginUpdateCheckResult> | null = null;
let pluginUpdateFlight: PluginUpdateFlight<PluginUpdateResult> | null = null;
let pluginUpdatePolicyRevision = 0;
let pluginUpdateLastCheckedAt: number | null = null;
let pluginUpdateLastError: string | null = null;
let pluginUpdateLock: PluginUpdateLock | null = null;
// A versão no manifest representa a fonte no checkout. Durante o preparo ela
// muda antes de um reload, portanto guardamos a versão que este processo
// carregou para não confundir "preparado" com "em execução". Se a fonte não
// puder ser validada, o estado é explicitamente desconhecido.
let pluginRuntimeVersion = UNKNOWN_PLUGIN_VERSION;

type PluginSettingsRecord = Record<string, unknown>;

type PluginOptimizationStatus = {
    active: boolean;
    requestId: string | null;
    phase: proton.ProtonOptimizationProgress["phase"] | null;
    total: number;
    tested: number;
    succeeded: number;
    server?: string;
    pingMs?: number;
    downloadMbps?: number;
    uploadMbps?: number;
    error?: string;
    updatedAt: number | null;
};

let pluginOptimizationStatus: PluginOptimizationStatus = {
    active: false,
    requestId: null,
    phase: null,
    total: 0,
    tested: 0,
    succeeded: 0,
    updatedAt: null,
};

function pluginSettings(): PluginSettingsRecord {
    const root = RendererSettings.plain as { plugins?: unknown };
    const plugins = root.plugins;
    if (plugins === null || typeof plugins !== "object") return {};
    const value = (plugins as Record<string, unknown>).GoLiveBypass;
    return value !== null && typeof value === "object" ? value as PluginSettingsRecord : {};
}

function pluginEnabled(): boolean {
    return pluginSettings().enabled === true;
}

function controllerSettings(): PluginSettingsRecord {
    const stored = pluginSettings();
    return {
        mode: stored.vpnMode === "custom" ? "custom" : "proton",
        customConfigPath: typeof stored.customConfigPath === "string" ? stored.customConfigPath : "",
        protonUsername: typeof stored.protonUsername === "string" ? stored.protonUsername : "",
        protonCountry: typeof stored.protonCountry === "string" ? stored.protonCountry : "",
        protonFreeOnly: stored.protonFreeOnly !== false,
        protonAutoPing: stored.protonAutoPing !== false,
    };
}

function describeData(data: Record<string, unknown> | undefined): string {
    if (!data) return "";
    return Object.entries(data)
        .map(([key, value]) => {
            let printed: string;
            try { printed = typeof value === "string" ? value : JSON.stringify(value) ?? String(value); } catch { printed = String(value); }
            return `${key}=${safeDiagnosticDetail(printed, 500)}`;
        })
        .join(" ");
}

function log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
    const detail = describeData(data);
    const line = `${new Date().toISOString().slice(11, 23)} [${level}] ${safeDiagnosticDetail(message, 1500)}${detail ? ` | ${detail}` : ""}`;
    history.push(line);
    while (history.length > MAX_LOG_LINES) history.shift();

    try {
        mkdirSync(VPN_DATA_DIR, { recursive: true });
        if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES)
            writeFileSync(LOG_FILE, readFileSync(LOG_FILE, "utf8").slice(-Math.floor(MAX_LOG_BYTES / 2)), "utf8");
        appendFileSync(LOG_FILE, `${line}\n`, "utf8");
    } catch (error) {
        // Diagnóstico nunca pode impedir o Discord de continuar abrindo.
        if (history.length < MAX_LOG_LINES)
            history.push(`${new Date().toISOString().slice(11, 23)} [warn] não consegui gravar o log: ${safeDiagnosticDetail(error)}`);
    }
}

const controller = new PluginVpnController({
    dataDir: VPN_DATA_DIR,
    guiDataDir: GUI_DATA_DIR,
    readSettings: controllerSettings,
    isEnabled: pluginEnabled,
    log,
});

export function logFromRenderer(_: IpcMainInvokeEvent, message: unknown): void {
    if (typeof message === "string" && message.trim()) log("info", message.slice(0, 2000));
}

function setStoredUsername(username: string): void {
    try {
        const plugins = RendererSettings.store.plugins as Record<string, PluginSettingsRecord>;
        const stored = plugins.GoLiveBypass;
        if (stored) stored.protonUsername = username;
    } catch (error) {
        log("warn", "não consegui atualizar o usuário Proton nas configurações", { erro: error });
    }
}

function cleanLoginPayload(value: unknown): ProtonLoginPayload {
    if (value === null || typeof value !== "object") throw new Error("Informe os dados de login Proton.");
    const raw = value as Record<string, unknown>;
    const username = typeof raw.username === "string" ? raw.username.trim().slice(0, 320) : "";
    const password = typeof raw.password === "string" ? raw.password.slice(0, 2048) : undefined;
    const twoFactorCode = typeof raw.twoFactorCode === "string" ? raw.twoFactorCode.trim().slice(0, 64) : undefined;
    const requestId = typeof raw.requestId === "string" ? raw.requestId.trim().slice(0, 120) : undefined;
    if (!username) throw new Error("Informe o usuário Proton.");
    if (!password) throw new Error("Informe a senha Proton.");
    return { username, password, twoFactorCode, requestId };
}

function cleanOptimizationOptions(value: unknown): ProtonOptimizationOptions {
    const raw = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    const country = typeof raw.country === "string" ? raw.country.trim().slice(0, 128) : undefined;
    const requestId = typeof raw.requestId === "string" ? raw.requestId.trim().slice(0, 120) : undefined;
    return {
        country,
        freeOnly: typeof raw.freeOnly === "boolean" ? raw.freeOnly : undefined,
        autoPing: raw.autoPing !== false,
        speedTest: raw.speedTest === true,
        requestId,
    };
}

function writeCaptchaPreload(): string {
    const target = join(VPN_DATA_DIR, "captcha-preload.cjs");
    const source = `"use strict";\nconst { ipcRenderer } = require("electron");\nconst accepted = new Set(["pm_captcha", "proton_captcha"]);\nwindow.addEventListener("message", event => {\n  const data = event.data;\n  if (!data || !accepted.has(data.type) || typeof data.token !== "string" || data.token.length > 16384) return;\n  ipcRenderer.send(${JSON.stringify(CAPTCHA_IPC_CHANNEL)}, { type: data.type, token: data.token });\n});\n`;
    mkdirSync(VPN_DATA_DIR, { recursive: true });
    try {
        if (readFileSync(target, "utf8") !== source) writeFileSync(target, source, { encoding: "utf8", mode: 0o600 });
    } catch {
        writeFileSync(target, source, { encoding: "utf8", mode: 0o600 });
    }
    return target;
}

function allowedCaptchaNavigation(rawUrl: string, challenge: { origin: string }): boolean {
    try {
        const parsed = new URL(rawUrl);
        return parsed.protocol === "https:"
            && parsed.origin === challenge.origin
            && parsed.pathname === "/core/v4/captcha";
    } catch {
        return false;
    }
}

type CaptchaResult =
    | { ok: true; token: string }
    | { ok: false; code: "CAPTCHA_CANCELLED" | "CAPTCHA_INVALID"; message: string };

function solveCaptcha(rawUrl: string, parent: BrowserWindow | null, signal?: AbortSignal): Promise<CaptchaResult> {
    if (signal?.aborted) return Promise.resolve({ ok: false, code: "CAPTCHA_CANCELLED", message: "Verificação cancelada. Nenhuma credencial foi alterada." });
    const challenge = proton.parseCaptchaUrl(rawUrl);
    if (!challenge) return Promise.resolve({ ok: false, code: "CAPTCHA_INVALID", message: "O Proton forneceu um endereço de CAPTCHA inválido." });

    let preload: string;
    try { preload = writeCaptchaPreload(); }
    catch { return Promise.resolve({ ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível preparar a captura do CAPTCHA." }); }

    return new Promise(resolve => {
        let settled = false;
        let invalidMessages = 0;
        const captchaWindow = new BrowserWindow({
            width: 520,
            height: 700,
            minWidth: 420,
            minHeight: 560,
            parent: parent && !parent.isDestroyed() ? parent : undefined,
            modal: Boolean(parent && !parent.isDestroyed()),
            show: false,
            autoHideMenuBar: true,
            title: "Verificação de segurança Proton",
            backgroundColor: "#17171c",
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                devTools: false,
                safeDialogs: true,
                spellcheck: false,
                preload,
                partition: `golive-plugin-captcha-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            },
        });
        const captchaSession = captchaWindow.webContents.session;
        const preventDownload = (event: Electron.Event) => event.preventDefault();
        const onCaptchaResponse = (event: IpcMainEvent, message: { type?: unknown; token?: unknown }) => {
            if (settled || event.sender !== captchaWindow.webContents) return;
            if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return;
            if (!allowedCaptchaNavigation(event.senderFrame.url, challenge)) return;
            if (message?.type !== "pm_captcha" && message?.type !== "proton_captcha") return;
            if (proton.validateCaptchaResponse(message.token, challenge.challenge)) {
                finish({ ok: true, token: message.token });
                return;
            }
            invalidMessages++;
            if (invalidMessages >= 10)
                finish({ ok: false, code: "CAPTCHA_INVALID", message: "O CAPTCHA retornou uma resposta inválida. Tente novamente." });
        };
        const finish = (result: CaptchaResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            ipcMain.removeListener(CAPTCHA_IPC_CHANNEL, onCaptchaResponse);
            signal?.removeEventListener("abort", onAbort);
            captchaSession.removeListener("will-download", preventDownload);
            resolve(result);
            if (!captchaWindow.isDestroyed()) captchaWindow.destroy();
        };
        const onAbort = () => finish({ ok: false, code: "CAPTCHA_CANCELLED", message: "Verificação cancelada. Nenhuma credencial foi alterada." });
        const timeout = setTimeout(() => finish({ ok: false, code: "CAPTCHA_INVALID", message: "A verificação expirou. Inicie o login novamente." }), CAPTCHA_TIMEOUT_MS);
        timeout.unref?.();

        captchaSession.on("will-download", preventDownload);
        captchaSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
        captchaWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        captchaWindow.webContents.on("will-attach-webview", event => event.preventDefault());
        const guardNavigation = (event: Electron.Event, targetUrl: string) => {
            if (!allowedCaptchaNavigation(targetUrl, challenge)) event.preventDefault();
        };
        captchaWindow.webContents.on("will-navigate", guardNavigation);
        captchaWindow.webContents.on("will-redirect", guardNavigation);
        captchaWindow.webContents.on("did-fail-load", (_event, errorCode, _description, _validatedUrl, isMainFrame) => {
            if (isMainFrame && errorCode !== -3)
                finish({ ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível carregar o CAPTCHA oficial da Proton." });
        });
        captchaWindow.webContents.on("preload-error", (_event, preloadPath) => {
            if (preloadPath === preload)
                finish({ ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível preparar a captura do CAPTCHA." });
        });
        captchaWindow.once("ready-to-show", () => { if (!settled) captchaWindow.show(); });
        captchaWindow.once("close", () => {
            if (!settled) finish({ ok: false, code: "CAPTCHA_CANCELLED", message: "Verificação cancelada. Nenhuma credencial foi alterada." });
        });
        captchaWindow.once("closed", () => {
            if (!settled) finish({ ok: false, code: "CAPTCHA_CANCELLED", message: "Verificação cancelada. Nenhuma credencial foi alterada." });
        });
        ipcMain.on(CAPTCHA_IPC_CHANNEL, onCaptchaResponse);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        void captchaWindow.loadURL(challenge.url).catch(() => {
            finish({ ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível abrir o CAPTCHA oficial da Proton." });
        });
    });
}

export function enable(_: IpcMainInvokeEvent) {
    return controller.enable();
}

export function shutdown(_: IpcMainInvokeEvent) {
    // Desativar/recarregar o userplugin não deve reiniciar o Discord no meio de
    // uma chamada. O caminho explícito restartDiscord() continua responsável
    // pelo relaunch quando a pessoa confirma uma atualização preparada.
    controller.cancelProtonLogin();
    return controller.shutdown(false);
}

export function restoreNetwork(_: IpcMainInvokeEvent) {
    return controller.restoreNetwork();
}

export function restartDiscord(_: IpcMainInvokeEvent) {
    return controller.restartDiscord();
}

export function getVpnStatus(_: IpcMainInvokeEvent) {
    return controller.getStatus();
}

export function getProtonOptimizationStatus(_: IpcMainInvokeEvent): PluginOptimizationStatus {
    return { ...pluginOptimizationStatus };
}

export function getLog(_: IpcMainInvokeEvent): string {
    return history.join("\n");
}

export function getPluginVpnPaths(_: IpcMainInvokeEvent) {
    return { ...controller.paths, logPath: LOG_FILE };
}

export function importWireGuardConfig(_: IpcMainInvokeEvent, sourcePath: unknown) {
    return typeof sourcePath === "string"
        ? controller.importCustomConfig(sourcePath)
        : Promise.resolve({ success: false as const, error: "Informe o caminho de um arquivo WireGuard." });
}

export function testWireGuardConfig(_: IpcMainInvokeEvent, sourcePath?: unknown) {
    return controller.testConfig(typeof sourcePath === "string" ? sourcePath : undefined);
}

export function getProtonSettings(_: IpcMainInvokeEvent) {
    const settings = controllerSettings();
    return {
        mode: settings.mode,
        customConfigPath: settings.customConfigPath,
        protonUsername: settings.protonUsername,
        protonCountry: settings.protonCountry,
        protonFreeOnly: settings.protonFreeOnly,
        protonAutoPing: settings.protonAutoPing,
        sessionUsername: proton.savedSessionUsername(VPN_DATA_DIR),
    };
}

export async function loginProton(event: IpcMainInvokeEvent, value: unknown) {
    try {
        const payload = cleanLoginPayload(value);
        const parent = BrowserWindow.fromWebContents(event.sender);
        const result = await controller.loginProton(payload, (url, signal) => solveCaptcha(url, parent, signal).then(captcha => captcha.ok ? captcha.token : null));
        if (result.success && result.username) setStoredUsername(result.username);
        return result;
    } catch (error) {
        return { success: false as const, code: "CONFIGURATION_ERROR" as const, retryable: false, message: safeDiagnosticDetail(error, 500), error: safeDiagnosticDetail(error, 500) };
    }
}

export function cancelProtonLogin(_: IpcMainInvokeEvent, requestId?: unknown) {
    return { cancelled: controller.cancelProtonLogin(typeof requestId === "string" ? requestId : undefined) };
}

export function checkProtonSession(_: IpcMainInvokeEvent, username?: unknown) {
    const value = typeof username === "string" && username.trim() ? username : String(controllerSettings().protonUsername || "");
    return controller.checkProtonSession(value).catch(() => ({
        valid: false,
        code: "UNKNOWN" as const,
        error: "Não foi possível verificar a sessão Proton.",
    }));
}

export function getProtonPlan(_: IpcMainInvokeEvent, username?: unknown) {
    const value = typeof username === "string" && username.trim() ? username : String(controllerSettings().protonUsername || "");
    return controller.getProtonPlan(value);
}

export async function logoutProton(_: IpcMainInvokeEvent) {
    const result = await controller.logoutProton();
    if (result.success) setStoredUsername("");
    return result;
}

export function optimizeProtonRoute(event: IpcMainInvokeEvent, value: unknown) {
    const options = cleanOptimizationOptions(value);
    if (pluginOptimizationStatus.active) {
        return Promise.resolve({ success: false as const, error: "Já existe uma otimização Proton em andamento." });
    }
    const requestId = options.requestId || `plugin-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    options.requestId = requestId;
    pluginOptimizationStatus = {
        active: true,
        requestId,
        phase: "preparing",
        total: 0,
        tested: 0,
        succeeded: 0,
        updatedAt: Date.now(),
    };
    options.onProgress = progress => {
        pluginOptimizationStatus = {
            ...pluginOptimizationStatus,
            active: true,
            requestId: progress.requestId,
            phase: progress.phase,
            total: progress.total,
            tested: progress.tested,
            succeeded: progress.succeeded,
            server: progress.server,
            pingMs: progress.pingMs,
            downloadMbps: progress.downloadMbps,
            uploadMbps: progress.uploadMbps,
            error: undefined,
            updatedAt: Date.now(),
        };
        if (!event.sender.isDestroyed()) event.sender.send("golive-vpn-proton-progress", progress);
    };
    return controller.optimizeProton(options).then(result => {
        pluginOptimizationStatus = {
            ...pluginOptimizationStatus,
            active: false,
            requestId,
            phase: result.success ? "completed" : result.cancelled ? "cancelled" : "failed",
            server: result.server,
            pingMs: result.pingMs,
            downloadMbps: result.downloadMbps,
            uploadMbps: result.uploadMbps,
            error: result.error,
            updatedAt: Date.now(),
        };
        return result;
    }, error => {
        pluginOptimizationStatus = {
            ...pluginOptimizationStatus,
            active: false,
            requestId,
            phase: "failed",
            error: safeDiagnosticDetail(error, 500),
            updatedAt: Date.now(),
        };
        throw error;
    });
}

export function cancelProtonOptimization(_: IpcMainInvokeEvent, requestId: unknown) {
    return { cancelled: typeof requestId === "string" && controller.cancelOptimization(requestId) };
}

// ------------------------------------------------------------------ atualização do userplugin

type PluginUpdateDownloadOptions = {
    signal?: AbortSignal;
    deadlineAt?: number;
};

function downloadBytes(url: string, maxBytes: number, redirects = 0, baseUrl?: string, options: PluginUpdateDownloadOptions = {}): Promise<Buffer> {
    const safeUrl = securePluginUpdateUrl(url, baseUrl);
    const deadlineAt = options.deadlineAt ?? Date.now() + PLUGIN_UPDATE_TIMEOUT_MS;
    if (options.signal?.aborted) return Promise.reject(new Error("download do update cancelado"));
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return Promise.reject(new Error("update request timed out"));

    return new Promise((resolveBytes, reject) => {
        let settled = false;
        let delegated = false;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        let req: ReturnType<typeof request> | undefined;

        const cleanup = () => {
            if (deadlineTimer) clearTimeout(deadlineTimer);
            options.signal?.removeEventListener("abort", onAbort);
        };
        const resolveOnce = (value: Buffer) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolveBytes(value);
        };
        const rejectOnce = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const abortRequest = (message: string) => {
            const error = new Error(message);
            req?.destroy(error);
            rejectOnce(error);
        };
        const onAbort = () => abortRequest("download do update cancelado");

        deadlineTimer = setTimeout(() => abortRequest("update request timed out"), remaining);
        deadlineTimer.unref?.();
        options.signal?.addEventListener("abort", onAbort, { once: true });

        try {
            req = request(safeUrl, { headers: { "User-Agent": "GoLiveBypass-updater/1.0" } }, response => {
                if (options.signal?.aborted) {
                    response.resume();
                    onAbort();
                    return;
                }
                if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    response.resume();
                    if (redirects >= PLUGIN_MAX_REDIRECTS) { rejectOnce(new Error("redirecionamentos demais no update")); return; }
                    delegated = true;
                    cleanup();
                    try {
                        void downloadBytes(response.headers.location, maxBytes, redirects + 1, safeUrl, { ...options, deadlineAt })
                            .then(resolveOnce, rejectOnce);
                    } catch (error) {
                        rejectOnce(error);
                    }
                    return;
                }
                if (response.statusCode !== 200) { response.resume(); rejectOnce(new Error(`HTTP ${response.statusCode ?? 0}`)); return; }
                const contentLength = Number(response.headers["content-length"] ?? "");
                if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                    response.resume();
                    rejectOnce(new Error("resposta do update grande demais"));
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                let tooLarge = false;
                response.on("data", (chunk: Buffer) => {
                    if (settled || tooLarge) return;
                    size += chunk.length;
                    if (size > maxBytes) {
                        tooLarge = true;
                        const error = new Error("resposta do update grande demais");
                        rejectOnce(error);
                        response.destroy(error);
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on("end", () => { if (!tooLarge) resolveOnce(Buffer.concat(chunks)); });
                response.on("error", rejectOnce);
            });
            const requestTimeout = Math.min(PLUGIN_UPDATE_TIMEOUT_MS, remaining);
            req.setTimeout(requestTimeout, () => abortRequest("update request timed out"));
            req.on("error", error => { if (!delegated) rejectOnce(error); });
            req.end();
        } catch (error) {
            rejectOnce(error);
        }
    });
}

function downloadText(url: string, maxBytes = PLUGIN_API_MAX_BYTES, redirects = 0, baseUrl?: string, options: PluginUpdateDownloadOptions = {}): Promise<string> {
    return downloadBytes(url, maxBytes, redirects, baseUrl, options).then(value => value.toString("utf8"));
}

function compareUpdateVersion(local: string, remote: string): number {
    return comparePluginVersions(local, remote);
}

function isKnownPluginVersion(value: string): boolean {
    return value !== UNKNOWN_PLUGIN_VERSION && normalizePluginVersion(value) !== null;
}

function requireKnownPluginVersion(value: string): void {
    if (!isKnownPluginVersion(value)) throw new Error("versão instalada do plugin desconhecida; atualização segura indisponível");
}

function pendingUpdatePath(): string {
    return join(VPN_DATA_DIR, PENDING_UPDATE_FILE);
}

function updateLockPath(): string {
    return join(VPN_DATA_DIR, UPDATE_LOCK_FILE);
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ESRCH") return false;
        if (process.platform !== "win32") return true;
        try {
            const listing = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 3_000,
                windowsHide: true,
            });
            return new RegExp(`\\b${pid}\\b`).test(listing);
        } catch {
            // Falha ao consultar o processo deve manter o lock: liberar em
            // dúvida é pior que exigir uma nova tentativa depois.
            return true;
        }
    }
}

function readUpdateLockOwner(path: string): { pid: number; token: string; startedAt: number } | null {
    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        const pid = raw.pid;
        const token = raw.token;
        const startedAt = raw.startedAt;
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || typeof token !== "string" || !token
            || typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
        return { pid, token, startedAt };
    } catch {
        return null;
    }
}

function acquirePluginUpdateLock(): PluginUpdateLock {
    if (pluginUpdateLock) {
        pluginUpdateLock.depth++;
        return pluginUpdateLock;
    }

    mkdirSync(VPN_DATA_DIR, { recursive: true });
    const path = updateLockPath();
    for (let attempt = 0; attempt < 2; attempt++) {
        let fd: number | undefined;
        let created = false;
        try {
            fd = openSync(path, "wx", 0o600);
            created = true;
            const lock: PluginUpdateLock = { fd, token: randomUUID(), depth: 1 };
            writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token: lock.token, startedAt: Date.now() })}\n`, "utf8");
            // O lock é consultado por outro processo. Garanta que o owner foi
            // escrito antes de liberar o descritor, especialmente no Windows.
            // fsync não é exigido para a correção do swap, apenas para evitar um
            // arquivo de lock vazio após uma queda de energia.
            try { fsyncSync(fd); } catch { /* alguns volumes não suportam fsync */ }
            closeSync(fd);
            fd = undefined;
            pluginUpdateLock = lock;
            return lock;
        } catch (error) {
            if (fd !== undefined) {
                try { closeSync(fd); } catch { /* best effort */ }
            }
            if (created) {
                try { rmSync(path, { force: true }); } catch { /* best effort */ }
            }
            if ((error as { code?: string }).code !== "EEXIST" || attempt === 1) throw error;

            const owner = readUpdateLockOwner(path);
            if (owner && isProcessAlive(owner.pid))
                throw new Error(`já existe uma atualização do plugin em outro processo (pid ${owner.pid})`);

            // Se o primeiro processo ainda está entre open("wx") e writeFile,
            // não remova o lock recém-criado. Uma segunda tentativa manual pode
            // recuperar um arquivo vazio antigo depois que o processo morreu.
            try {
                const age = Date.now() - statSync(path).mtimeMs;
                if (!owner && age < 2_000) throw new Error("outro processo está reservando o lock do updater");
            } catch (statError) {
                if ((statError as { code?: string }).code === "ENOENT") continue;
                if ((statError as Error).message === "outro processo está reservando o lock do updater") throw statError;
            }
            rmSync(path, { force: true });
        }
    }
    throw new Error("não consegui reservar o lock do updater");
}

function releasePluginUpdateLock(lock: PluginUpdateLock | null | undefined): void {
    if (!lock || pluginUpdateLock !== lock) return;
    lock.depth--;
    if (lock.depth > 0) return;
    pluginUpdateLock = null;

    let ownsFile = false;
    const owner = readUpdateLockOwner(updateLockPath());
    ownsFile = owner?.pid === process.pid && owner.token === lock.token;
    try { closeSync(lock.fd); } catch { /* o descritor pode já estar fechado */ }
    if (ownsFile) {
        try { rmSync(updateLockPath(), { force: true }); }
        catch (error) { log("warn", "não consegui liberar o lock do updater", { erro: error }); }
    }
}

function quarantineLegacyPendingUpdate(pending: PendingPluginUpdate): void {
    const source = pendingUpdatePath();
    const prefix = `${PENDING_UPDATE_FILE}.legacy-${Date.now()}-${process.pid}`;
    for (let attempt = 0; attempt < 8; attempt++) {
        const destination = join(VPN_DATA_DIR, `${prefix}-${attempt}.json`);
        if (existsSync(destination)) continue;
        try {
            // Preserve the old marker for diagnosis, but remove it from the
            // active slot atomically so a new preparation can proceed.
            renameSync(source, destination);
            log("warn", "marcador legado do updater movido para quarentena; nova preparação liberada", {
                versão: pending.version,
                canal: pending.channel,
                arquivo: basename(destination),
            });
            return;
        } catch (error) {
            // Another renderer call may have quarantined the marker first.
            if (!existsSync(source)) return;
            if (attempt === 7)
                throw new Error(`não consegui mover o marcador legado para quarentena: ${safeDiagnosticDetail(error, 300)}`);
        }
    }
    throw new Error("não consegui reservar um nome seguro para quarentenar o marcador legado");
}

function policyFrom(value: unknown, fallback = pluginUpdatePolicy): PluginUpdatePolicy {
    const raw = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    const channelValue = raw.channel ?? raw.updateChannel;
    const channel: PluginUpdateChannel = channelValue === "beta" ? "beta" : channelValue === "stable" ? "stable" : fallback.channel;
    const enabled = typeof raw.enabled === "boolean"
        ? raw.enabled
        : typeof raw.autoUpdate === "boolean" ? raw.autoUpdate : fallback.enabled;
    return { enabled, channel };
}

function updatePolicyKey(policy: PluginUpdatePolicy): string {
    return `${policy.channel}:${policy.enabled ? "enabled" : "disabled"}`;
}

function setPluginUpdateLastError(policy: PluginUpdatePolicy, revision: number, error: string | null): void {
    // Uma consulta antiga pode concluir depois de uma troca de canal (ou de uma
    // troca rápida de volta). Ela não pode pintar o status do canal atual.
    if (revision !== pluginUpdatePolicyRevision || updatePolicyKey(pluginUpdatePolicy) !== updatePolicyKey(policy)) return;
    pluginUpdateLastError = error;
}

function assertCurrentPluginUpdatePolicy(policy: PluginUpdatePolicy, revision: number): void {
    if (revision !== pluginUpdatePolicyRevision || updatePolicyKey(pluginUpdatePolicy) !== updatePolicyKey(policy))
        throw new Error("a política do updater mudou durante o download; atualização cancelada com segurança");
}

function clearPluginUpdateTimers(): void {
    if (pluginUpdateInitialTimer) clearTimeout(pluginUpdateInitialTimer);
    if (pluginUpdatePeriodicTimer) clearInterval(pluginUpdatePeriodicTimer);
    pluginUpdateInitialTimer = undefined;
    pluginUpdatePeriodicTimer = undefined;
}

function validPendingUpdate(value: unknown): PendingPluginUpdate | null {
    if (value === null || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    const version = typeof raw.version === "string" ? normalizePluginVersion(raw.version) : null;
    const channel = raw.channel === "beta" || raw.channel === "stable" ? raw.channel : null;
    const digest = typeof raw.digest === "string" && SOURCE_DIGEST_PATTERN.test(raw.digest) ? raw.digest.toLowerCase() : null;
    const sourceDigest = raw.sourceDigest === undefined
        ? undefined
        : typeof raw.sourceDigest === "string" && SOURCE_DIGEST_PATTERN.test(raw.sourceDigest) ? raw.sourceDigest.toLowerCase() : null;
    const phase = raw.phase === undefined
        ? "prepared" as const
        : raw.phase === "preparing" || raw.phase === "prepared" || raw.phase === "rolling-back" ? raw.phase : null;
    const displacedName = raw.displacedName === undefined
        ? undefined
        : typeof raw.displacedName === "string" && SAFE_DISPLACED_NAME.test(raw.displacedName) ? raw.displacedName : null;
    const backupName = typeof raw.backupName === "string" && SAFE_BACKUP_NAME.test(raw.backupName) ? raw.backupName : null;
    if (!version || !channel || !digest || sourceDigest === null || !phase || displacedName === null || !backupName || typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return null;
    return {
        version,
        channel,
        prerelease: raw.prerelease === true,
        digest,
        sourceDigest,
        phase,
        displacedName,
        backupName,
        createdAt: raw.createdAt,
    };
}

function readPendingUpdate(): PendingPluginUpdate | null {
    if (!existsSync(pendingUpdatePath())) return null;
    try {
        const pending = validPendingUpdate(JSON.parse(readFileSync(pendingUpdatePath(), "utf8")));
        if (pending) {
            if (!pending.sourceDigest) {
                log("warn", "marcador de update pendente legado sem digest da fonte; nova preparação será exigida", { versão: pending.version, canal: pending.channel });
            }
            return pending;
        }
    } catch (error) {
        log("warn", "marcador de update pendente inválido", { erro: error });
    }
    rmSync(pendingUpdatePath(), { force: true });
    return null;
}

function writePendingUpdate(pending: TrustedPendingPluginUpdate): void {
    mkdirSync(VPN_DATA_DIR, { recursive: true });
    const temporary = join(VPN_DATA_DIR, `${PENDING_UPDATE_FILE}.tmp-${process.pid}-${randomUUID()}`);
    writeFileSync(temporary, `${JSON.stringify(pending)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, pendingUpdatePath());
}

function safeBackupPath(projectRoot: string, backupName: string): string {
    if (!SAFE_BACKUP_NAME.test(backupName) || basename(backupName) !== backupName)
        throw new Error("backup do update inválido");
    const backupRoot = resolve(projectRoot, BACKUP_DIR);
    const backupPath = resolve(backupRoot, backupName);
    if (!backupPath.startsWith(`${backupRoot}${process.platform === "win32" ? "\\" : "/"}`))
        throw new Error("backup do update fora da pasta reservada");
    return backupPath;
}

function safeDisplacedPath(projectRoot: string, displacedName: string): string {
    if (!SAFE_DISPLACED_NAME.test(displacedName) || basename(displacedName) !== displacedName)
        throw new Error("nome temporário do rollback inválido");
    const backupRoot = resolve(projectRoot, BACKUP_DIR);
    const displacedPath = resolve(backupRoot, displacedName);
    if (!displacedPath.startsWith(`${backupRoot}${process.platform === "win32" ? "\\" : "/"}`))
        throw new Error("rollback fora da pasta reservada");
    return displacedPath;
}

function clearPendingUpdate(pending: PendingPluginUpdate, projectRoot?: string): void {
    if (projectRoot) {
        try { rmSync(safeBackupPath(projectRoot, pending.backupName), { recursive: true, force: true }); }
        catch (error) { log("warn", "não consegui remover backup pendente", { erro: error }); }
    }
    rmSync(pendingUpdatePath(), { force: true });
}

function recoverInterruptedPluginUpdate(): void {
    const pending = readPendingUpdate();
    if (!pending || pending.phase === "prepared") return;

    const { projectRoot, target } = userpluginSource(true);
    const backup = safeBackupPath(projectRoot, pending.backupName);
    const hasTarget = existsSync(target);
    const hasBackup = existsSync(backup);

    if (pending.phase === "rolling-back") {
        const displaced = pending.displacedName ? safeDisplacedPath(projectRoot, pending.displacedName) : null;
        if (hasBackup) {
            // O rollback de beta também tem journal. O backup estável vence
            // qualquer árvore que tenha ficado no target após uma queda.
            if (hasTarget) rmSync(target, { recursive: true, force: true });
            renameSync(backup, target);
            rebuildUserplugin(projectRoot);
            if (displaced) rmSync(displaced, { recursive: true, force: true });
            rmSync(pendingUpdatePath(), { force: true });
            log("warn", "rollback interrompido recuperado para a versão estável", { versão: pending.version });
            return;
        }

        if (hasTarget) {
            const installedVersion = readInstalledPluginVersion(target);
            if (installedVersion !== pending.version) {
                if (displaced) rmSync(displaced, { recursive: true, force: true });
                rmSync(pendingUpdatePath(), { force: true });
                log("warn", "rollback já havia restaurado a versão estável; journal descartado", { versão: pending.version });
                return;
            }
        } else if (displaced && existsSync(displaced)) {
            // Sem o backup estável, ao menos preserve uma árvore válida em vez
            // de deixar o checkout vazio. O journal permanece para diagnóstico.
            renameSync(displaced, target);
            rebuildUserplugin(projectRoot);
        }
        throw new Error("rollback interrompido sem backup estável recuperável");
    }

    if (hasBackup) {
        // O journal só entra em "prepared" depois da árvore nova validada e do
        // build concluído. Enquanto está em "preparing", o backup é a fonte
        // autoritativa, mesmo que uma árvore nova tenha chegado a ser criada.
        if (hasTarget) rmSync(target, { recursive: true, force: true });
        renameSync(backup, target);
        rebuildUserplugin(projectRoot);
        rmSync(pendingUpdatePath(), { force: true });
        log("warn", "update interrompido recuperado para a versão anterior", { versão: pending.version, canal: pending.channel });
        return;
    }

    if (!hasTarget) throw new Error("update interrompido sem fonte instalada nem backup recuperável");

    // Se o processo morreu antes do primeiro rename, o target ainda é o
    // checkout anterior e não há backup. Nesse caso basta remover a intenção.
    // Se o target já for a árvore nova e o backup tiver desaparecido, preserve o
    // marcador para diagnóstico em vez de declarar o update confirmado.
    if (pending.sourceDigest && hashPluginSourceTree(target) === pending.sourceDigest)
        throw new Error("update interrompido deixou a árvore nova sem backup; recuperação manual necessária");
    readInstalledPluginVersion(target);
    rmSync(pendingUpdatePath(), { force: true });
    log("warn", "intenção de update interrompida descartada antes da troca", { versão: pending.version, canal: pending.channel });
}

function readManifest(target: string): { name?: unknown; version?: unknown; updater?: unknown } {
    const manifestPath = join(target, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("manifest do plugin ausente");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown; updater?: unknown };
    if (!isCompatiblePluginManifest(manifest, PLUGIN_ASSET)) throw new Error("manifest do plugin não pertence ao updater oficial");
    return manifest;
}

function reconcileReachedPendingUpdate(currentVersion = currentPluginVersion(), inspection = inspectPendingUpdate()): PendingPluginUpdate | null {
    if (inspection.error || !inspection.trusted) return null;
    const pending = inspection.trusted;
    // O target no checkout já é trocado durante o preparo. Só a versão que este
    // processo carregou prova que houve reload; ler apenas o manifest do target
    // apagaria o marcador enquanto o Discord ainda executa o código antigo.
    if (!isKnownPluginVersion(pluginRuntimeVersion) || !isKnownPluginVersion(currentVersion)) return pending;
    if (compareUpdateVersion(pluginRuntimeVersion, pending.version) < 0) return pending;
    if (compareUpdateVersion(currentVersion, pending.version) >= 0) {
        try { clearPendingUpdate(pending, userpluginSource().projectRoot); }
        catch { clearPendingUpdate(pending); }
        return null;
    }
    return pending;
}

function discardPendingBetaForStable(currentVersion = currentPluginVersion(), inspection = inspectPendingUpdate()): void {
    if (inspection.error) throw new Error(inspection.error);
    const pending = inspection.trusted;
    if (!pending || pending.channel !== "beta") return;
    if (isKnownPluginVersion(pluginRuntimeVersion) && isKnownPluginVersion(currentVersion)
        && compareUpdateVersion(pluginRuntimeVersion, pending.version) >= 0
        && compareUpdateVersion(currentVersion, pending.version) >= 0) {
        try { clearPendingUpdate(pending, userpluginSource().projectRoot); }
        catch { clearPendingUpdate(pending); }
        return;
    }

    const { projectRoot, target } = userpluginSource();
    const backup = safeBackupPath(projectRoot, pending.backupName);
    if (!existsSync(backup)) {
        throw new Error("backup do beta pendente não foi encontrado");
    }

    const currentManifest = readManifest(target);
    const installedManifestVersion = typeof currentManifest.version === "string" ? normalizePluginVersion(currentManifest.version) : null;
    if (installedManifestVersion !== pending.version) {
        log("warn", "ignorei rollback beta porque a fonte atual não corresponde ao marcador", { atual: installedManifestVersion ?? "inválida", pendente: pending.version });
        throw new Error("a fonte atual não corresponde ao marcador beta pendente");
    }

    const displacedName = `goLiveBypass-pending-${Date.now()}`;
    const displaced = safeDisplacedPath(projectRoot, displacedName);
    let stableMoved = false;
    writePendingUpdate({ ...pending, phase: "rolling-back", displacedName });
    renameSync(target, displaced);
    try {
        renameSync(backup, target);
        stableMoved = true;
        rebuildUserplugin(projectRoot);
    } catch (error) {
        try {
            // Se a recompilação falhar, devolva também o backup estável ao seu
            // nome original. Remover o target primeiro perdia a única cópia
            // desse estado e tornava uma nova troca de canal irrecuperável.
            if (stableMoved && existsSync(target) && !existsSync(backup)) renameSync(target, backup);
            if (!existsSync(target) && existsSync(displaced)) renameSync(displaced, target);
            if (!existsSync(target)) throw new Error("não consegui restaurar a fonte beta após falha do rollback");
            rebuildUserplugin(projectRoot);
        } catch (rollbackError) {
            log("error", "falha ao restaurar o build anterior", { erro: rollbackError });
        }
        throw error;
    }
    try { rmSync(displaced, { recursive: true, force: true }); }
    catch (error) { log("warn", "não consegui remover a cópia beta descartada", { erro: error }); }
    try { clearPendingUpdate(pending); }
    catch (error) { log("warn", "não consegui remover o marcador beta descartado", { erro: error }); }
    log("info", `update beta pendente descartado ao selecionar stable (${pending.version})`);
}

function releaseInfo(channel: PluginUpdateChannel, currentVersion: string, signal?: AbortSignal): Promise<PluginReleaseCandidate | null> {
    return downloadText(GITHUB_RELEASES_URL, PLUGIN_API_MAX_BYTES, 0, undefined, { signal }).then(raw => {
        const releases = JSON.parse(raw) as unknown;
        if (!Array.isArray(releases)) throw new Error("resposta de releases inválida");
        const candidates: PluginReleaseCandidate[] = [];
        for (const value of releases) {
            if (value === null || typeof value !== "object") continue;
            const release = value as Record<string, unknown>;
            if (release.draft === true || typeof release.tag_name !== "string") continue;
            const version = normalizePluginVersion(release.tag_name);
            if (!version) continue;
            const assets = Array.isArray(release.assets) ? release.assets : [];
            const zipAsset = assets.find(asset => asset !== null && typeof asset === "object" && (asset as Record<string, unknown>).name === PLUGIN_ASSET);
            const shaAsset = assets.find(asset => asset !== null && typeof asset === "object" && (asset as Record<string, unknown>).name === PLUGIN_CHECKSUM_ASSET);
            const zipUrl = releaseAssetUrl(zipAsset && (zipAsset as Record<string, unknown>).browser_download_url);
            const shaUrl = releaseAssetUrl(shaAsset && (shaAsset as Record<string, unknown>).browser_download_url);
            if (!zipUrl || !shaUrl) continue;
            const prerelease = release.prerelease === true;
            candidates.push({ tag: release.tag_name, version, zipUrl, shaUrl, prerelease });
        }
        if (candidates.length === 0 && channel === "stable") throw new Error("nenhum release estável disponível");
        return choosePluginRelease(candidates, currentVersion, channel);
    });
}

function validateArchiveEntries(archive: string, extracted: string): void {
    let listing: string;
    try {
        listing = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: PLUGIN_UPDATE_TIMEOUT_MS });
    } catch {
        listing = execFileSync("tar", ["-tf", archive], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: PLUGIN_UPDATE_TIMEOUT_MS });
    }
    const root = resolve(extracted);
    for (const entry of listing.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
        const normalized = entry.replaceAll("\\", "/");
        if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes(".."))
            throw new Error("archive do plugin contém caminho inseguro");
        const candidate = resolve(root, normalized);
        if (candidate !== root && !candidate.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`))
            throw new Error("archive do plugin escapa da pasta temporária");
    }
}

function validateExtractedTree(root: string): void {
    const resolvedRoot = realpathSync(root);
    const pending = [root];
    while (pending.length > 0) {
        const current = pending.pop()!;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const candidate = join(current, entry.name);
            if (entry.isSymbolicLink()) throw new Error("archive do plugin contém link simbólico");
            const resolved = realpathSync(candidate);
            if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${process.platform === "win32" ? "\\" : "/"}`))
                throw new Error("archive do plugin escapa da pasta temporária");
            if (entry.isDirectory()) pending.push(candidate);
        }
    }
}

function validatePluginSourceTree(root: string): void {
    let rootStats: ReturnType<typeof lstatSync>;
    try { rootStats = lstatSync(root); }
    catch { throw new Error("fonte do plugin ausente"); }
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("fonte do plugin não é uma pasta regular");

    const pending = [root];
    while (pending.length > 0) {
        const current = pending.pop()!;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const candidate = join(current, entry.name);
            if (entry.isSymbolicLink()) throw new Error("fonte do plugin contém link simbólico");
            if (entry.isDirectory()) {
                pending.push(candidate);
                continue;
            }
            if (!entry.isFile()) throw new Error("fonte do plugin contém entrada especial");
        }
    }

    for (const relative of REQUIRED_PLUGIN_FILES) {
        const candidate = join(root, relative);
        let stats: ReturnType<typeof lstatSync>;
        try { stats = lstatSync(candidate); }
        catch { throw new Error(`archive do plugin não contém ${relative}`); }
        if (stats.isSymbolicLink() || !stats.isFile() || stats.size <= 0) throw new Error(`archive do plugin contém ${relative} inválido`);
    }
}

function hashPluginSourceTree(root: string): string {
    validatePluginSourceTree(root);
    const digest = createHash("sha256");
    const visit = (current: string, prefix: string): void => {
        const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => {
            if (left.name === right.name) return 0;
            return left.name < right.name ? -1 : 1;
        });
        for (const entry of entries) {
            const candidate = join(current, entry.name);
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) throw new Error("fonte do plugin contém link simbólico");
            if (entry.isDirectory()) {
                digest.update(`directory:${relative}\0`);
                visit(candidate, relative);
                continue;
            }
            if (!entry.isFile()) throw new Error("fonte do plugin contém entrada especial");
            const content = readFileSync(candidate);
            digest.update(`file:${relative}:${content.length}\0`);
            digest.update(content);
            digest.update("\0");
        }
    };
    visit(root, "");
    return digest.digest("hex");
}

function inspectPendingUpdate(): PendingUpdateInspection {
    const pending = readPendingUpdate();
    if (!pending) return { pending: null, trusted: null, error: null };

    if (pending.phase !== "prepared") {
        return {
            pending,
            trusted: null,
            error: "há um update interrompido aguardando recuperação do checkout",
        };
    }

    const sourceDigest = pending.sourceDigest;
    if (typeof sourceDigest !== "string") {
        try {
            quarantineLegacyPendingUpdate(pending);
            return { pending: null, trusted: null, error: null };
        } catch (error) {
            return {
                pending,
                trusted: null,
                error: `marcador de update pendente legado sem prova da árvore preparada; não consegui liberar nova preparação: ${safeDiagnosticDetail(error, 300)}`,
            };
        }
    }

    try {
        const { target } = userpluginSource();
        const actualDigest = hashPluginSourceTree(target);
        if (actualDigest !== sourceDigest) {
            return {
                pending,
                trusted: null,
                error: "digest da árvore preparada não confere com a fonte atual; nova preparação é necessária",
            };
        }
    } catch (error) {
        return {
            pending,
            trusted: null,
            error: `não consegui validar a árvore preparada${error ? `: ${safeDiagnosticDetail(error, 300)}` : ""}`,
        };
    }

    return { pending, trusted: { ...pending, sourceDigest }, error: null };
}

function trustedPendingResultState(): { pending: boolean; pendingChannel?: PluginUpdateChannel } {
    const inspection = inspectPendingUpdate();
    return { pending: Boolean(inspection.trusted), pendingChannel: inspection.trusted?.channel };
}

function cleanupExtractedWork(work: string): void {
    try { rmSync(work, { recursive: true, force: true }); }
    catch (error) { log("warn", "não consegui limpar os temporários do update", { erro: error }); }
}

function extractAndValidatePlugin(zip: Buffer, release: PluginReleaseCandidate, projectRoot?: string): { work: string; source: string; sourceDigest: string } {
    const parent = projectRoot ? join(projectRoot, UPDATE_STAGING_DIR) : tmpdir();
    if (projectRoot) mkdirSync(parent, { recursive: true });
    const work = mkdtempSync(join(parent, "golivebypass-update-"));
    const archive = join(work, PLUGIN_ASSET);
    const extracted = join(work, "extract");
    writeFileSync(archive, zip, { mode: 0o600 });
    mkdirSync(extracted);
    try {
        validateArchiveEntries(archive, extracted);
        try { execFileSync("unzip", ["-q", archive, "-d", extracted], { stdio: "ignore", timeout: PLUGIN_UPDATE_TIMEOUT_MS }); }
        catch { execFileSync("tar", ["-xf", archive, "-C", extracted], { stdio: "ignore", timeout: PLUGIN_UPDATE_TIMEOUT_MS }); }
        validateExtractedTree(extracted);
        const source = join(extracted, USERPLUGIN_DIR);
        const sourceResolved = resolve(source);
        const rootResolved = resolve(extracted);
        if (!sourceResolved.startsWith(`${rootResolved}${process.platform === "win32" ? "\\" : "/"}`))
            throw new Error("fonte extraída fora da pasta temporária");
        const manifest = readManifest(source);
        if (typeof manifest.version !== "string" || normalizePluginVersion(manifest.version) !== release.version)
            throw new Error("manifest do plugin não corresponde ao release");
        validatePluginSourceTree(source);
        return { work, source, sourceDigest: hashPluginSourceTree(source) };
    } catch (error) {
        cleanupExtractedWork(work);
        throw error;
    }
}

async function performPluginUpdateCheckLocked(policy: PluginUpdatePolicy, signal?: AbortSignal): Promise<PluginUpdateCheckResult> {
    if (policy.channel === "stable") discardPendingBetaForStable();
    const currentVersion = currentPluginVersion();
    requireKnownPluginVersion(currentVersion);
    const pendingInspection = inspectPendingUpdate();
    if (pendingInspection.error) throw new Error(pendingInspection.error);
    const pending = reconcileReachedPendingUpdate(currentVersion, pendingInspection);
    if (pending) {
        return {
            ok: true,
            current: pluginRuntimeVersion,
            channel: policy.channel,
            latest: pending.version,
            available: false,
            pending: true,
            pendingChannel: pending.channel,
        };
    }
    const release = await releaseInfo(policy.channel, currentVersion, signal);
    if (!release) return { ok: true, current: pluginRuntimeVersion, channel: policy.channel, latest: currentVersion, available: false, pending: false };
    return {
        ok: true,
        current: pluginRuntimeVersion,
        channel: policy.channel,
        latest: release.version,
        available: compareUpdateVersion(currentVersion, release.version) < 0,
        pending: false,
    };
}

async function performPluginUpdateCheck(policy: PluginUpdatePolicy, signal?: AbortSignal): Promise<PluginUpdateCheckResult> {
    const lock = acquirePluginUpdateLock();
    try {
        recoverInterruptedPluginUpdate();
        return await performPluginUpdateCheckLocked(policy, signal);
    } finally {
        releasePluginUpdateLock(lock);
    }
}

function runPluginUpdateCheck(policy: PluginUpdatePolicy): Promise<PluginUpdateCheckResult> {
    const policyKey = updatePolicyKey(policy);
    if (pluginUpdateCheckFlight?.policyKey === policyKey) return pluginUpdateCheckFlight.promise;
    const controller = new AbortController();
    const revision = pluginUpdatePolicyRevision;
    let trackedFlight!: PluginUpdateFlight<PluginUpdateCheckResult>;
    const flight = performPluginUpdateCheck(policy, controller.signal)
        .catch(error => {
            const pending = trustedPendingResultState();
            return {
                ok: false as const,
                current: pluginRuntimeVersion,
                channel: policy.channel,
                available: false as const,
                pending: pending.pending,
                pendingChannel: pending.pendingChannel,
                error: safeDiagnosticDetail(error, 500),
            };
        })
        .finally(() => {
            // A consulta pode terminar depois de uma troca de política. Nesse
            // caso ela é apenas o resultado de um voo cancelado/obsoleto e não
            // pode marcar o canal atual como consultado.
            if (revision === pluginUpdatePolicyRevision && policyKey === updatePolicyKey(pluginUpdatePolicy))
                pluginUpdateLastCheckedAt = Date.now();
            if (pluginUpdateCheckFlight === trackedFlight) pluginUpdateCheckFlight = null;
        });
    trackedFlight = { policyKey, revision, controller, promise: flight };
    pluginUpdateCheckFlight = trackedFlight;
    return flight;
}

async function performPluginUpdateLocked(policy: PluginUpdatePolicy, revision: number, controller: AbortController): Promise<PluginUpdateResult> {
    const signal = controller.signal;
    assertCurrentPluginUpdatePolicy(policy, revision);
    if (policy.channel === "stable") discardPendingBetaForStable();
    const sourceAtStart = userpluginSource();
    const currentVersion = readInstalledPluginVersion(sourceAtStart.target);
    const sourceDigestAtStart = hashPluginSourceTree(sourceAtStart.target);
    const pendingInspection = inspectPendingUpdate();
    if (pendingInspection.error) throw new Error(pendingInspection.error);
    const pending = reconcileReachedPendingUpdate(currentVersion, pendingInspection);
    if (pending)
        return {
            ok: true,
            updated: false,
            current: pluginRuntimeVersion,
            latest: pending.version,
            channel: policy.channel,
            pending: true,
            pendingChannel: pending.channel,
            reloadRequired: true,
        };

    const release = await releaseInfo(policy.channel, currentVersion, signal);
    if (!release) return { ok: true, updated: false, current: pluginRuntimeVersion, latest: currentVersion, channel: policy.channel, pending: false, reloadRequired: false };
    const downloadOptions = { signal, deadlineAt: Date.now() + PLUGIN_UPDATE_TIMEOUT_MS };
    let zip: Buffer;
    let checksumText: string;
    try {
        [zip, checksumText] = await Promise.all([
            downloadBytes(release.zipUrl, PLUGIN_ARCHIVE_MAX_BYTES, 0, undefined, downloadOptions),
            downloadText(release.shaUrl, PLUGIN_API_MAX_BYTES, 0, undefined, downloadOptions),
        ]);
    } catch (error) {
        controller.abort();
        throw error;
    }
    const expected = /^([a-f0-9]{64})\b/i.exec(checksumText)?.[1]?.toLowerCase();
    if (!expected) throw new Error("release sem SHA-256 válido");
    const digest = createHash("sha256").update(zip).digest("hex");
    if (digest !== expected) throw new Error("SHA-256 do plugin não confere");

    // O staging fica no mesmo volume do checkout para que a troca final use
    // rename atômico também em instalações Windows com TEMP em outro disco.
    const extracted = extractAndValidatePlugin(zip, release, sourceAtStart.projectRoot);
    try {
        assertCurrentPluginUpdatePolicy(policy, revision);
        const { projectRoot, target } = userpluginSource();
        const sourceAtCommit = { projectRoot, target };
        if (sourceAtCommit.projectRoot !== sourceAtStart.projectRoot || sourceAtCommit.target !== sourceAtStart.target)
            throw new Error("a origem local do plugin mudou durante o download");
        if (readInstalledPluginVersion(sourceAtCommit.target) !== currentVersion)
            throw new Error("a versão local do plugin mudou durante o download");
        if (hashPluginSourceTree(sourceAtCommit.target) !== sourceDigestAtStart)
            throw new Error("o conteúdo local do plugin mudou durante o download");
        const backupRoot = join(projectRoot, BACKUP_DIR);
        mkdirSync(backupRoot, { recursive: true });
        const backupName = `${USERPLUGIN_DIR}-${Date.now()}`;
        const backup = safeBackupPath(projectRoot, backupName);
        assertCurrentPluginUpdatePolicy(policy, revision);
        // Grave a intenção antes do primeiro rename. Se o processo morrer com
        // o target ausente, o próximo boot sabe que deve restaurar o backup em
        // vez de tratar o checkout como uma instalação inválida irrecuperável.
        writePendingUpdate({
            version: release.version,
            channel: policy.channel,
            prerelease: release.prerelease,
            digest,
            sourceDigest: extracted.sourceDigest,
            phase: "preparing",
            backupName,
            createdAt: Date.now(),
        });
        let oldTreeMoved = false;
        try {
            renameSync(target, backup);
            oldTreeMoved = true;
            assertCurrentPluginUpdatePolicy(policy, revision);
            renameSync(extracted.source, target);
            assertCurrentPluginUpdatePolicy(policy, revision);
            rebuildUserplugin(projectRoot);
            assertCurrentPluginUpdatePolicy(policy, revision);
            const preparedSourceDigest = hashPluginSourceTree(target);
            if (preparedSourceDigest !== extracted.sourceDigest)
                throw new Error("a árvore preparada mudou durante a recompilação");
            assertCurrentPluginUpdatePolicy(policy, revision);
            writePendingUpdate({
                version: release.version,
                channel: policy.channel,
                prerelease: release.prerelease,
                digest,
                sourceDigest: preparedSourceDigest,
                phase: "prepared",
                backupName,
                createdAt: Date.now(),
            });
        } catch (error) {
            if (!oldTreeMoved) {
                try { rmSync(pendingUpdatePath(), { force: true }); }
                catch (markerError) { log("warn", "não consegui remover intenção de update após falha inicial", { erro: markerError }); }
                throw error;
            }
            let rollbackSucceeded = false;
            try {
                if (existsSync(target)) rmSync(target, { recursive: true, force: true });
                if (existsSync(backup)) renameSync(backup, target);
                rebuildUserplugin(projectRoot);
                rollbackSucceeded = true;
            } catch (rollbackError) {
                log("error", "falha ao restaurar o build anterior", { erro: rollbackError });
            }
            if (rollbackSucceeded) {
                try { rmSync(pendingUpdatePath(), { force: true }); }
                catch (markerError) { log("warn", "não consegui remover journal de update revertido", { erro: markerError }); }
            }
            throw error;
        }
        log("info", `plugin preparado de ${currentVersion} para ${release.version}; reload necessário`);
        return {
            ok: true,
            updated: true,
            current: pluginRuntimeVersion,
            latest: release.version,
            channel: policy.channel,
            pending: true,
            pendingChannel: policy.channel,
            reloadRequired: true,
        };
    } finally {
        cleanupExtractedWork(extracted.work);
    }
}

async function performPluginUpdate(policy: PluginUpdatePolicy, revision: number, controller: AbortController): Promise<PluginUpdateResult> {
    const lock = acquirePluginUpdateLock();
    try {
        recoverInterruptedPluginUpdate();
        return await performPluginUpdateLocked(policy, revision, controller);
    } finally {
        releasePluginUpdateLock(lock);
    }
}

function runPluginUpdate(policy: PluginUpdatePolicy, revision = pluginUpdatePolicyRevision): Promise<PluginUpdateResult> {
    const policyKey = updatePolicyKey(policy);
    if (pluginUpdateFlight) {
        if (pluginUpdateFlight.policyKey === policyKey && pluginUpdateFlight.revision === revision) return pluginUpdateFlight.promise;
        return Promise.resolve({
            ok: false as const,
            updated: false as const,
            current: pluginRuntimeVersion,
            channel: policy.channel,
            ...trustedPendingResultState(),
            error: "já existe uma atualização do outro canal em andamento",
        });
    }
    const controller = new AbortController();
    let trackedFlight!: PluginUpdateFlight<PluginUpdateResult>;
    const flight = performPluginUpdate(policy, revision, controller)
        .catch(error => ({
            ok: false as const,
            updated: false as const,
            current: pluginRuntimeVersion,
            channel: policy.channel,
            ...trustedPendingResultState(),
            error: safeDiagnosticDetail(error, 500),
        }))
        .finally(() => {
            if (pluginUpdateFlight === trackedFlight) pluginUpdateFlight = null;
        });
    trackedFlight = { policyKey, revision, controller, promise: flight };
    pluginUpdateFlight = trackedFlight;
    return flight;
}

async function automaticPluginUpdate(policy: PluginUpdatePolicy): Promise<void> {
    if (!policy.enabled) return;
    const revision = pluginUpdatePolicyRevision;
    const check = await runPluginUpdateCheck(policy);
    if (!check.ok) {
        setPluginUpdateLastError(policy, revision, check.error);
        return;
    }
    setPluginUpdateLastError(policy, revision, null);
    if (check.available && !check.pending && pluginUpdatePolicy.enabled && pluginUpdatePolicy.channel === policy.channel) {
        const update = await runPluginUpdate(policy, revision);
        setPluginUpdateLastError(policy, revision, update.ok ? null : update.error);
    }
}

export function configurePluginUpdates(_: IpcMainInvokeEvent, value?: unknown): PluginUpdatePolicy {
    const next = policyFrom(value, { enabled: true, channel: "stable" });
    const changed = next.enabled !== pluginUpdatePolicy.enabled || next.channel !== pluginUpdatePolicy.channel;
    pluginUpdatePolicy = next;
    if (changed) {
        pluginUpdatePolicyRevision++;
        // Essas observações pertencem à política anterior. Limpe-as antes de
        // qualquer novo voo para que o painel não apresente um resultado
        // antigo como se já valesse para o canal recém-selecionado.
        pluginUpdateLastCheckedAt = null;
        pluginUpdateLastError = null;
        // A troca real de canal/habilitação cancela o download incompatível;
        // uma simples montagem do painel com a mesma política não deve abortar
        // um update automático que já esteja em andamento.
        pluginUpdateCheckFlight?.controller.abort();
        pluginUpdateCheckFlight = null;
        pluginUpdateFlight?.controller.abort();
        pluginUpdateFlight = null;
    }
    clearPluginUpdateTimers();
    if (changed && next.channel === "stable") {
        try {
            const lock = acquirePluginUpdateLock();
            try {
                recoverInterruptedPluginUpdate();
                discardPendingBetaForStable();
            } finally {
                releasePluginUpdateLock(lock);
            }
        }
        catch (error) {
            setPluginUpdateLastError(next, pluginUpdatePolicyRevision, safeDiagnosticDetail(error, 500));
            log("warn", "não consegui descartar o beta pendente ao selecionar stable", { erro: error });
        }
    }
    if (!next.enabled) return next;
    pluginUpdateInitialTimer = setTimeout(() => { void automaticPluginUpdate(pluginUpdatePolicy); }, PLUGIN_UPDATE_INITIAL_DELAY_MS);
    pluginUpdateInitialTimer.unref?.();
    pluginUpdatePeriodicTimer = setInterval(() => { void automaticPluginUpdate(pluginUpdatePolicy); }, PLUGIN_UPDATE_INTERVAL_MS);
    pluginUpdatePeriodicTimer.unref?.();
    if (changed) void automaticPluginUpdate(next);
    return next;
}

export function getPluginUpdateStatus(_: IpcMainInvokeEvent) {
    let lock: PluginUpdateLock | undefined;
    try {
        lock = acquirePluginUpdateLock();
        recoverInterruptedPluginUpdate();
        const installedVersion = currentPluginVersion();
        const pendingInspection = inspectPendingUpdate();
        const pending = reconcileReachedPendingUpdate(installedVersion, pendingInspection);
        return {
            current: pluginRuntimeVersion,
            channel: pluginUpdatePolicy.channel,
            enabled: pluginUpdatePolicy.enabled,
            pending: Boolean(pending),
            pendingVersion: pending?.version,
            pendingChannel: pending?.channel,
            lastCheckedAt: pluginUpdateLastCheckedAt,
            lastError: pendingInspection.error ?? pluginUpdateLastError,
        };
    } catch (error) {
        return {
            current: pluginRuntimeVersion,
            channel: pluginUpdatePolicy.channel,
            enabled: pluginUpdatePolicy.enabled,
            pending: false,
            pendingVersion: undefined,
            pendingChannel: undefined,
            lastCheckedAt: pluginUpdateLastCheckedAt,
            lastError: safeDiagnosticDetail(error, 500),
        };
    } finally {
        releasePluginUpdateLock(lock);
    }
}

export async function checkPluginUpdate(_: IpcMainInvokeEvent, value?: unknown): Promise<PluginUpdateCheckResult> {
    const policy = policyFrom(value);
    const revision = pluginUpdatePolicyRevision;
    const result = runPluginUpdateCheck(policy);
    void result.then(valueResult => setPluginUpdateLastError(policy, revision, valueResult.ok ? null : valueResult.error));
    return await result;
}

export async function updatePlugin(_: IpcMainInvokeEvent, value?: unknown): Promise<PluginUpdateResult> {
    const policy = policyFrom(value);
    const revision = pluginUpdatePolicyRevision;
    const result = runPluginUpdate(policy, revision);
    void result.then(valueResult => setPluginUpdateLastError(policy, revision, valueResult.ok ? null : valueResult.error));
    return await result;
}

function readInstalledPluginVersion(target: string): string {
    const manifest = readManifest(target);
    validatePluginSourceTree(target);
    const version = typeof manifest.version === "string" ? normalizePluginVersion(manifest.version) : null;
    if (!version) throw new Error("manifest instalado do plugin sem versão válida");
    return version;
}

function currentPluginVersion(): string {
    try { return readInstalledPluginVersion(userpluginSource().target); }
    catch { return UNKNOWN_PLUGIN_VERSION; }
}

function userpluginSource(allowMissingTarget = false) {
    const runtimeDir = resolve(__dirname);
    const roots = new Set<string>();
    const addRoot = (value: string | undefined) => {
        if (typeof value === "string" && value.trim()) roots.add(resolve(value));
    };

    // O processo injetado pode executar a partir do app.asar, fora do checkout.
    // Use dicas explícitas quando fornecidas e o cwd herdado do build como fallback;
    // cada candidato ainda precisa provar que é um checkout Vencord/Equicord.
    addRoot(process.env.VENCORD_SOURCE_DIR);
    addRoot(process.env.EQUICORD_SOURCE_DIR);
    addRoot(process.env.VENCORD_SRC);
    addRoot(process.env.EQUICORD_SRC);
    addRoot(process.cwd());

    let current = runtimeDir;
    for (let depth = 0; depth < 8; depth += 1) {
        addRoot(current);
        current = dirname(current);
    }

    for (const candidate of roots) {
        const projectRoot = basename(candidate) === "desktop" && basename(dirname(candidate)) === "dist"
            ? dirname(dirname(candidate))
            : basename(candidate) === "dist" ? dirname(candidate) : candidate;
        const target = join(projectRoot, "src", "userplugins", USERPLUGIN_DIR);
        const manifestPath = join(target, "manifest.json");
        if (!existsSync(join(projectRoot, "package.json"))) continue;
        if (!existsSync(manifestPath)) {
            if (allowMissingTarget && existsSync(join(projectRoot, "src", "userplugins"))) return { projectRoot, target };
            continue;
        }
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
            if (isCompatiblePluginManifest(manifest, PLUGIN_ASSET)) return { projectRoot, target };
        } catch {
            continue;
        }
    }

    throw new Error("não foi possível localizar o checkout Vencord/Equicord com segurança");
}

function resolveWindowsPnpm(): string {
    const userProfile = process.env.USERPROFILE ?? process.env.HOME;
    const candidates = [
        process.env.APPDATA ? join(process.env.APPDATA, "npm", "pnpm.cmd") : undefined,
        userProfile ? join(userProfile, "AppData", "Roaming", "npm", "pnpm.cmd") : undefined,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "pnpm", "pnpm.cmd") : undefined,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "pnpm", "pnpm.exe") : undefined,
        process.env.ProgramW6432 ? join(process.env.ProgramW6432, "nodejs", "pnpm.cmd") : undefined,
        process.env.ProgramFiles ? join(process.env.ProgramFiles, "nodejs", "pnpm.cmd") : undefined,
        process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "nodejs", "pnpm.cmd") : undefined,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    return candidates.find(candidate => existsSync(candidate)) ?? "pnpm.cmd";
}

function rebuildUserplugin(projectRoot: string): void {
    const windows = process.platform === "win32";
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const pnpm = windows ? resolveWindowsPnpm() : "pnpm";
    const command = windows
        ? (process.env.ComSpec && existsSync(process.env.ComSpec) ? process.env.ComSpec : join(windowsRoot, "System32", "cmd.exe"))
        : pnpm;
    const args = windows ? ["/d", "/s", "/c", "call", pnpm, "build"] : ["build"];
    const env = { ...process.env };
    if (windows) {
        const nodeDirs = [
            dirname(pnpm),
            process.env.ProgramW6432 ? join(process.env.ProgramW6432, "nodejs") : undefined,
            process.env.ProgramFiles ? join(process.env.ProgramFiles, "nodejs") : undefined,
            join(windowsRoot, "System32"),
        ].filter((value): value is string => typeof value === "string" && value.length > 0);
        env.Path = [...new Set([...nodeDirs, env.Path ?? env.PATH ?? ""].filter(Boolean))].join(";");
    }
    try {
        execFileSync(command, args, { cwd: projectRoot, env, stdio: "pipe", windowsHide: true, shell: false, timeout: USERPLUGIN_BUILD_TIMEOUT_MS });
    } catch (error) {
        const failure = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
        const detail = [failure.message, failure.stderr, failure.stdout].filter(Boolean).map(value => String(value).trim()).join("\n").slice(-1200);
        throw new Error(`não consegui recompilar o plugin${detail ? `: ${detail}` : ""}`);
    }
}

app.on("before-quit", event => {
    if (controller.isRelaunching() || quitting) return;
    controller.cancelProtonLogin();
    if (!controller.hasCleanupWork()) return;
    event.preventDefault();
    quitting = true;
    void controller.shutdown(false).then(result => {
        if (result.success) {
            app.exit(0);
            return;
        }
        quitting = false;
        log("error", "fechamento aguardou porque a restauração da VPN não foi confirmada", { estado: result.state, erro: result.error });
    }).catch(error => {
        quitting = false;
        log("error", "falha ao restaurar a rede antes do fechamento", { erro: safeDiagnosticDetail(error, 500) });
    });
});

app.whenReady().then(async () => {
    log("info", `abrindo plugin VPN | ${process.platform} ${process.arch} | electron ${process.versions.electron}`);
    try {
        const lock = acquirePluginUpdateLock();
        try { recoverInterruptedPluginUpdate(); }
        finally { releasePluginUpdateLock(lock); }
    } catch (error) {
        log("warn", "não consegui concluir a recuperação de update interrompido", { erro: error });
    }
    // Capture antes de qualquer update automático: depois do preparo o
    // manifest do checkout pode estar novo, embora este processo ainda seja o
    // antigo e aguarde o reload explícito.
    pluginRuntimeVersion = currentPluginVersion();
    await controller.initialize();
    if (pluginEnabled() && pluginSettings().onboardingCompleted === true) {
        if (controller.shouldSkipAutomaticEnable()) {
            log("warn", "VPN não foi ativada automaticamente após relaunch não confirmado");
        } else {
            const result = await controller.enable();
            if (!result.success) log("warn", "VPN não foi ativada no boot", { estado: result.state, erro: result.error });
        }
    } else if (pluginEnabled()) {
        log("info", "VPN não foi ativada no boot porque o onboarding ainda não foi concluído");
    }
}).catch(error => log("error", "falha ao inicializar o controlador VPN", { erro: error }));
