/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "fs";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
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
import { defaultPluginVpnDataDir, PluginVpnController, type ProtonLoginPayload, type ProtonOptimizationOptions } from "./vpn-controller";
import * as proton from "./vpn-proton";
import { safeDiagnosticDetail } from "./vpn-types";

const PLUGIN_VERSION = "2.0.0-beta.1";
const PLUGIN_ASSET = "goLiveBypass-vencord.zip";
const PLUGIN_CHECKSUM_ASSET = `${PLUGIN_ASSET}.sha256`;
const GITHUB_RELEASES_URL = "https://api.github.com/repos/pdl-clay/GoLiveBypass/releases?per_page=20";
const PLUGIN_UPDATE_TIMEOUT_MS = 30_000;
const PLUGIN_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const PLUGIN_UPDATE_INITIAL_DELAY_MS = 8_000;
const PLUGIN_API_MAX_BYTES = 2 * 1024 * 1024;
const PLUGIN_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
const PLUGIN_MAX_REDIRECTS = 4;
const USERPLUGIN_DIR = "goLiveBypass";
const USERPLUGIN_BUILD_TIMEOUT_MS = 120_000;
const PENDING_UPDATE_FILE = "plugin-update-pending.json";
const BACKUP_DIR = ".golivebypass-update-backups";
const SAFE_BACKUP_NAME = /^goLiveBypass-[0-9]{10,}$/;
const MAX_LOG_LINES = 400;
const MAX_LOG_BYTES = 256 * 1024;
const CAPTCHA_IPC_CHANNEL = "golive-plugin-proton-captcha-response";
const CAPTCHA_TIMEOUT_MS = 120_000;

const VPN_DATA_DIR = defaultPluginVpnDataDir();
const GUI_DATA_DIR = dirname(VPN_DATA_DIR);
const LOG_FILE = join(VPN_DATA_DIR, "plugin-vpn.log");

const history: string[] = [];
let quitting = false;

type PluginUpdatePolicy = { enabled: boolean; channel: PluginUpdateChannel };
type PendingPluginUpdate = {
    version: string;
    channel: PluginUpdateChannel;
    prerelease: boolean;
    digest: string;
    backupName: string;
    createdAt: number;
};

type PluginUpdateCheckResult = {
    ok: true;
    current: string;
    channel: PluginUpdateChannel;
    latest: string;
    available: boolean;
    pending: boolean;
} | {
    ok: false;
    current: string;
    channel: PluginUpdateChannel;
    latest?: string;
    available: false;
    pending: boolean;
    error: string;
};

type PluginUpdateResult = {
    ok: true;
    updated: boolean;
    current: string;
    latest: string;
    channel: PluginUpdateChannel;
    pending: boolean;
    reloadRequired: boolean;
} | {
    ok: false;
    updated: false;
    current: string;
    channel: PluginUpdateChannel;
    pending: boolean;
    error: string;
};

let pluginUpdatePolicy: PluginUpdatePolicy = { enabled: true, channel: "stable" };
let pluginUpdateInitialTimer: ReturnType<typeof setTimeout> | undefined;
let pluginUpdatePeriodicTimer: ReturnType<typeof setInterval> | undefined;
let pluginUpdateCheckFlight: Promise<PluginUpdateCheckResult> | null = null;
let pluginUpdateFlight: Promise<PluginUpdateResult> | null = null;
let pluginUpdateLastCheckedAt: number | null = null;
let pluginUpdateLastError: string | null = null;

type PluginSettingsRecord = Record<string, unknown>;

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
    if (!username) throw new Error("Informe o usuário Proton.");
    if (!password) throw new Error("Informe a senha Proton.");
    return { username, password, twoFactorCode };
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

function solveCaptcha(rawUrl: string, parent: BrowserWindow | null): Promise<CaptchaResult> {
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
            captchaSession.removeListener("will-download", preventDownload);
            resolve(result);
            if (!captchaWindow.isDestroyed()) captchaWindow.destroy();
        };
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
        void captchaWindow.loadURL(challenge.url).catch(() => {
            finish({ ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível abrir o CAPTCHA oficial da Proton." });
        });
    });
}

export function enable(_: IpcMainInvokeEvent) {
    return controller.enable();
}

export function shutdown(_: IpcMainInvokeEvent) {
    return controller.shutdown(true);
}

export function restoreNetwork(_: IpcMainInvokeEvent) {
    return controller.restoreNetwork();
}

export function getVpnStatus(_: IpcMainInvokeEvent) {
    return controller.getStatus();
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
        const result = await controller.loginProton(payload, url => solveCaptcha(url, parent).then(captcha => captcha.ok ? captcha.token : null));
        if (result.success && result.username) setStoredUsername(result.username);
        return result;
    } catch (error) {
        return { success: false as const, code: "CONFIGURATION_ERROR" as const, retryable: false, message: safeDiagnosticDetail(error, 500), error: safeDiagnosticDetail(error, 500) };
    }
}

export function checkProtonSession(_: IpcMainInvokeEvent, username?: unknown) {
    const value = typeof username === "string" && username.trim() ? username : String(controllerSettings().protonUsername || "");
    return controller.checkProtonSession(value).catch(error => ({ valid: false, error: safeDiagnosticDetail(error, 500) }));
}

export function getProtonPlan(_: IpcMainInvokeEvent, username?: unknown) {
    const value = typeof username === "string" && username.trim() ? username : String(controllerSettings().protonUsername || "");
    return controller.getProtonPlan(value);
}

export function logoutProton(_: IpcMainInvokeEvent) {
    const removed = controller.logoutProton();
    setStoredUsername("");
    return { success: removed };
}

export function optimizeProtonRoute(event: IpcMainInvokeEvent, value: unknown) {
    const options = cleanOptimizationOptions(value);
    options.onProgress = progress => {
        if (!event.sender.isDestroyed()) event.sender.send("golive-vpn-proton-progress", progress);
    };
    return controller.optimizeProton(options);
}

export function cancelProtonOptimization(_: IpcMainInvokeEvent, requestId: unknown) {
    return { cancelled: typeof requestId === "string" && controller.cancelOptimization(requestId) };
}

// ------------------------------------------------------------------ atualização do userplugin

function secureHttpsUrl(rawUrl: string, baseUrl?: string): string {
    const parsed = new URL(rawUrl, baseUrl);
    if (parsed.protocol !== "https:") throw new Error("update recusou URL que não usa HTTPS");
    return parsed.toString();
}

function downloadBytes(url: string, maxBytes: number, redirects = 0, baseUrl?: string): Promise<Buffer> {
    const safeUrl = secureHttpsUrl(url, baseUrl);
    return new Promise((resolveBytes, reject) => {
        const req = request(safeUrl, { headers: { "User-Agent": "GoLiveBypass-updater/1.0" } }, response => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (redirects >= PLUGIN_MAX_REDIRECTS) { reject(new Error("redirecionamentos demais no update")); return; }
                try {
                    void downloadBytes(response.headers.location, maxBytes, redirects + 1, safeUrl).then(resolveBytes, reject);
                } catch (error) {
                    reject(error);
                }
                return;
            }
            if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode ?? 0}`)); return; }
            const contentLength = Number(response.headers["content-length"] ?? "");
            if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                response.resume();
                reject(new Error("resposta do update grande demais"));
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            let tooLarge = false;
            response.on("data", (chunk: Buffer) => {
                if (tooLarge) return;
                size += chunk.length;
                if (size > maxBytes) {
                    tooLarge = true;
                    response.destroy(new Error("resposta do update grande demais"));
                    return;
                }
                chunks.push(chunk);
            });
            response.on("end", () => { if (!tooLarge) resolveBytes(Buffer.concat(chunks)); });
            response.on("error", reject);
        });
        req.setTimeout(PLUGIN_UPDATE_TIMEOUT_MS, () => req.destroy(new Error("update request timed out")));
        req.on("error", reject);
        req.end();
    });
}

function downloadText(url: string, maxBytes = PLUGIN_API_MAX_BYTES, redirects = 0, baseUrl?: string): Promise<string> {
    return downloadBytes(url, maxBytes, redirects, baseUrl).then(value => value.toString("utf8"));
}

function compareUpdateVersion(local: string, remote: string): number {
    return comparePluginVersions(local, remote);
}

function pendingUpdatePath(): string {
    return join(VPN_DATA_DIR, PENDING_UPDATE_FILE);
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
    const digest = typeof raw.digest === "string" && /^[a-f0-9]{64}$/i.test(raw.digest) ? raw.digest.toLowerCase() : null;
    const backupName = typeof raw.backupName === "string" && SAFE_BACKUP_NAME.test(raw.backupName) ? raw.backupName : null;
    if (!version || !channel || !digest || !backupName || typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return null;
    return {
        version,
        channel,
        prerelease: raw.prerelease === true,
        digest,
        backupName,
        createdAt: raw.createdAt,
    };
}

function readPendingUpdate(): PendingPluginUpdate | null {
    if (!existsSync(pendingUpdatePath())) return null;
    try {
        const pending = validPendingUpdate(JSON.parse(readFileSync(pendingUpdatePath(), "utf8")));
        if (pending) return pending;
    } catch (error) {
        log("warn", "marcador de update pendente inválido", { erro: error });
    }
    rmSync(pendingUpdatePath(), { force: true });
    return null;
}

function writePendingUpdate(pending: PendingPluginUpdate): void {
    mkdirSync(VPN_DATA_DIR, { recursive: true });
    const temporary = join(VPN_DATA_DIR, `${PENDING_UPDATE_FILE}.tmp-${Date.now()}`);
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

function clearPendingUpdate(pending: PendingPluginUpdate, projectRoot?: string): void {
    if (projectRoot) {
        try { rmSync(safeBackupPath(projectRoot, pending.backupName), { recursive: true, force: true }); }
        catch (error) { log("warn", "não consegui remover backup pendente", { erro: error }); }
    }
    rmSync(pendingUpdatePath(), { force: true });
}

function readManifest(target: string): { name?: unknown; version?: unknown } {
    const manifestPath = join(target, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("manifest do plugin ausente");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown };
    if (manifest.name !== "GoLiveBypass") throw new Error("o destino do updater não é o userplugin GoLiveBypass");
    return manifest;
}

function reconcileReachedPendingUpdate(): PendingPluginUpdate | null {
    const pending = readPendingUpdate();
    if (!pending) return null;
    if (compareUpdateVersion(PLUGIN_VERSION, pending.version) >= 0) {
        try { clearPendingUpdate(pending, userpluginSource().projectRoot); }
        catch { clearPendingUpdate(pending); }
        return null;
    }
    return pending;
}

function discardPendingBetaForStable(): void {
    const pending = readPendingUpdate();
    if (!pending || pending.channel !== "beta") return;
    if (compareUpdateVersion(PLUGIN_VERSION, pending.version) >= 0) {
        try { clearPendingUpdate(pending, userpluginSource().projectRoot); }
        catch { clearPendingUpdate(pending); }
        return;
    }

    const { projectRoot, target } = userpluginSource();
    const backup = safeBackupPath(projectRoot, pending.backupName);
    if (!existsSync(backup)) {
        clearPendingUpdate(pending);
        throw new Error("backup do beta pendente não foi encontrado");
    }

    const currentManifest = readManifest(target);
    const currentVersion = typeof currentManifest.version === "string" ? normalizePluginVersion(currentManifest.version) : null;
    if (currentVersion !== pending.version) {
        log("warn", "ignorei rollback beta porque a fonte atual não corresponde ao marcador", { atual: currentVersion ?? "inválida", pendente: pending.version });
        clearPendingUpdate(pending, projectRoot);
        return;
    }

    const displaced = join(projectRoot, `${BACKUP_DIR}/goLiveBypass-pending-${Date.now()}`);
    renameSync(target, displaced);
    try {
        renameSync(backup, target);
        rebuildUserplugin(projectRoot);
        rmSync(displaced, { recursive: true, force: true });
        clearPendingUpdate(pending);
        log("info", `update beta pendente descartado ao selecionar stable (${pending.version})`);
    } catch (error) {
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
        if (existsSync(displaced)) renameSync(displaced, target);
        try { rebuildUserplugin(projectRoot); } catch (rollbackError) { log("error", "falha ao restaurar beta pendente", { erro: rollbackError }); }
        throw error;
    }
}

function releaseAssetUrl(value: unknown): string | null {
    if (typeof value !== "string" || !value.trim()) return null;
    try { return secureHttpsUrl(value); } catch { return null; }
}

function releaseInfo(channel: PluginUpdateChannel): Promise<PluginReleaseCandidate | null> {
    return downloadText(GITHUB_RELEASES_URL).then(raw => {
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
        return choosePluginRelease(candidates, PLUGIN_VERSION, channel);
    });
}

function validateArchiveEntries(archive: string, extracted: string): void {
    let listing: string;
    try {
        listing = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
        listing = execFileSync("tar", ["-tf", archive], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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

function extractAndValidatePlugin(zip: Buffer, release: PluginReleaseCandidate): { work: string; source: string } {
    const work = mkdtempSync(join(tmpdir(), "golivebypass-update-"));
    const archive = join(work, PLUGIN_ASSET);
    const extracted = join(work, "extract");
    writeFileSync(archive, zip, { mode: 0o600 });
    mkdirSync(extracted);
    try {
        validateArchiveEntries(archive, extracted);
        try { execFileSync("unzip", ["-q", archive, "-d", extracted], { stdio: "ignore" }); }
        catch { execFileSync("tar", ["-xf", archive, "-C", extracted], { stdio: "ignore" }); }
        validateExtractedTree(extracted);
        const source = join(extracted, USERPLUGIN_DIR);
        const sourceResolved = resolve(source);
        const rootResolved = resolve(extracted);
        if (!sourceResolved.startsWith(`${rootResolved}${process.platform === "win32" ? "\\" : "/"}`))
            throw new Error("fonte extraída fora da pasta temporária");
        const manifest = readManifest(source);
        if (typeof manifest.version !== "string" || normalizePluginVersion(manifest.version) !== release.version)
            throw new Error("manifest do plugin não corresponde ao release");
        return { work, source };
    } catch (error) {
        rmSync(work, { recursive: true, force: true });
        throw error;
    }
}

async function performPluginUpdateCheck(policy: PluginUpdatePolicy): Promise<PluginUpdateCheckResult> {
    if (policy.channel === "stable") discardPendingBetaForStable();
    const pending = reconcileReachedPendingUpdate();
    if (pending) {
        return { ok: true, current: PLUGIN_VERSION, channel: policy.channel, latest: pending.version, available: false, pending: true };
    }
    const release = await releaseInfo(policy.channel);
    if (!release) return { ok: true, current: PLUGIN_VERSION, channel: policy.channel, latest: PLUGIN_VERSION, available: false, pending: false };
    return {
        ok: true,
        current: PLUGIN_VERSION,
        channel: policy.channel,
        latest: release.version,
        available: compareUpdateVersion(PLUGIN_VERSION, release.version) < 0,
        pending: false,
    };
}

function runPluginUpdateCheck(policy: PluginUpdatePolicy): Promise<PluginUpdateCheckResult> {
    if (pluginUpdateCheckFlight) return pluginUpdateCheckFlight;
    const flight = performPluginUpdateCheck(policy)
        .catch(error => ({ ok: false as const, current: PLUGIN_VERSION, channel: policy.channel, available: false as const, pending: Boolean(readPendingUpdate()), error: safeDiagnosticDetail(error, 500) }))
        .finally(() => { pluginUpdateCheckFlight = null; pluginUpdateLastCheckedAt = Date.now(); });
    pluginUpdateCheckFlight = flight;
    return flight;
}

async function performPluginUpdate(policy: PluginUpdatePolicy): Promise<PluginUpdateResult> {
    if (policy.channel === "stable") discardPendingBetaForStable();
    const pending = reconcileReachedPendingUpdate();
    if (pending)
        return { ok: true, updated: false, current: PLUGIN_VERSION, latest: pending.version, channel: policy.channel, pending: true, reloadRequired: true };

    const release = await releaseInfo(policy.channel);
    if (!release) return { ok: true, updated: false, current: PLUGIN_VERSION, latest: PLUGIN_VERSION, channel: policy.channel, pending: false, reloadRequired: false };
    const [zip, checksumText] = await Promise.all([downloadBytes(release.zipUrl, PLUGIN_ARCHIVE_MAX_BYTES), downloadText(release.shaUrl)]);
    const expected = /^([a-f0-9]{64})\b/i.exec(checksumText)?.[1]?.toLowerCase();
    if (!expected) throw new Error("release sem SHA-256 válido");
    const digest = createHash("sha256").update(zip).digest("hex");
    if (digest !== expected) throw new Error("SHA-256 do plugin não confere");

    const extracted = extractAndValidatePlugin(zip, release);
    try {
        const { projectRoot, target } = userpluginSource();
        const backupRoot = join(projectRoot, BACKUP_DIR);
        mkdirSync(backupRoot, { recursive: true });
        const backupName = `${USERPLUGIN_DIR}-${Date.now()}`;
        const backup = safeBackupPath(projectRoot, backupName);
        renameSync(target, backup);
        try {
            renameSync(extracted.source, target);
            rebuildUserplugin(projectRoot);
            writePendingUpdate({ version: release.version, channel: policy.channel, prerelease: release.prerelease, digest, backupName, createdAt: Date.now() });
        } catch (error) {
            if (existsSync(target)) rmSync(target, { recursive: true, force: true });
            if (existsSync(backup)) renameSync(backup, target);
            try { rebuildUserplugin(projectRoot); } catch (rollbackError) { log("error", "falha ao restaurar o build anterior", { erro: rollbackError }); }
            throw error;
        }
        log("info", `plugin preparado de ${PLUGIN_VERSION} para ${release.version}; reload necessário`);
        return { ok: true, updated: true, current: PLUGIN_VERSION, latest: release.version, channel: policy.channel, pending: true, reloadRequired: true };
    } finally {
        rmSync(extracted.work, { recursive: true, force: true });
    }
}

function runPluginUpdate(policy: PluginUpdatePolicy): Promise<PluginUpdateResult> {
    if (pluginUpdateFlight) return pluginUpdateFlight;
    const flight = performPluginUpdate(policy)
        .catch(error => ({ ok: false as const, updated: false as const, current: PLUGIN_VERSION, channel: policy.channel, pending: Boolean(readPendingUpdate()), error: safeDiagnosticDetail(error, 500) }))
        .finally(() => { pluginUpdateFlight = null; });
    pluginUpdateFlight = flight;
    return flight;
}

async function automaticPluginUpdate(policy: PluginUpdatePolicy): Promise<void> {
    if (!policy.enabled) return;
    const check = await runPluginUpdateCheck(policy);
    if (!check.ok) {
        pluginUpdateLastError = check.error;
        return;
    }
    if (check.available && !check.pending && pluginUpdatePolicy.enabled && pluginUpdatePolicy.channel === policy.channel) {
        const update = await runPluginUpdate(policy);
        if (!update.ok) pluginUpdateLastError = update.error;
    }
}

export function configurePluginUpdates(_: IpcMainInvokeEvent, value?: unknown): PluginUpdatePolicy {
    const next = policyFrom(value, { enabled: true, channel: "stable" });
    const changed = next.enabled !== pluginUpdatePolicy.enabled || next.channel !== pluginUpdatePolicy.channel;
    pluginUpdatePolicy = next;
    clearPluginUpdateTimers();
    if (changed && next.channel === "stable") {
        try { discardPendingBetaForStable(); }
        catch (error) {
            pluginUpdateLastError = safeDiagnosticDetail(error, 500);
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
    const pending = reconcileReachedPendingUpdate();
    return {
        current: PLUGIN_VERSION,
        channel: pluginUpdatePolicy.channel,
        enabled: pluginUpdatePolicy.enabled,
        pending: Boolean(pending),
        pendingVersion: pending?.version,
        lastCheckedAt: pluginUpdateLastCheckedAt,
        lastError: pluginUpdateLastError,
    };
}

export async function checkPluginUpdate(_: IpcMainInvokeEvent, value?: unknown): Promise<PluginUpdateCheckResult> {
    const policy = policyFrom(value);
    const result = runPluginUpdateCheck(policy);
    void result.then(valueResult => { pluginUpdateLastError = valueResult.ok ? null : valueResult.error; });
    return await result;
}

export async function updatePlugin(_: IpcMainInvokeEvent, value?: unknown): Promise<PluginUpdateResult> {
    const policy = policyFrom(value);
    const result = runPluginUpdate(policy);
    void result.then(valueResult => { pluginUpdateLastError = valueResult.ok ? null : valueResult.error; });
    return await result;
}

function userpluginSource() {
    const runtimeDir = resolve(__dirname);
    if (basename(runtimeDir) !== "desktop" || basename(dirname(runtimeDir)) !== "dist")
        throw new Error("não foi possível localizar o build do Vencord/Equicord com segurança");
    const projectRoot = dirname(dirname(runtimeDir));
    const target = join(projectRoot, "src", "userplugins", USERPLUGIN_DIR);
    const manifestPath = join(target, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("não achei o userplugin GoLiveBypass na fonte do build");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
    if (manifest.name !== "GoLiveBypass") throw new Error("o destino do updater não é o userplugin GoLiveBypass");
    return { projectRoot, target };
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
    await controller.initialize();
    if (pluginEnabled()) {
        const result = await controller.enable();
        if (!result.success) log("warn", "VPN não foi ativada no boot", { estado: result.state, erro: result.error });
    }
}).catch(error => log("error", "falha ao inicializar o controlador VPN", { erro: error }));
