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
    readFileSync,
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

import { defaultPluginVpnDataDir, PluginVpnController, type ProtonLoginPayload, type ProtonOptimizationOptions } from "./vpn-controller";
import * as proton from "./vpn-proton";
import { safeDiagnosticDetail } from "./vpn-types";

const PLUGIN_VERSION = "2.0.0-beta.1";
const PLUGIN_ASSET = "goLiveBypass-vencord.zip";
const GITHUB_RELEASES_URL = "https://api.github.com/repos/pdl-clay/GoLiveBypass/releases/latest";
const PLUGIN_UPDATE_TIMEOUT_MS = 30_000;
const USERPLUGIN_DIR = "goLiveBypass";
const USERPLUGIN_BUILD_TIMEOUT_MS = 120_000;
const MAX_LOG_LINES = 400;
const MAX_LOG_BYTES = 256 * 1024;
const CAPTCHA_IPC_CHANNEL = "golive-plugin-proton-captcha-response";
const CAPTCHA_TIMEOUT_MS = 120_000;

const VPN_DATA_DIR = defaultPluginVpnDataDir();
const GUI_DATA_DIR = dirname(VPN_DATA_DIR);
const LOG_FILE = join(VPN_DATA_DIR, "plugin-vpn.log");

const history: string[] = [];
let quitting = false;

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

function downloadText(url: string, redirects = 0): Promise<string> {
    return new Promise((resolveText, reject) => {
        const req = request(url, { headers: { "User-Agent": "GoLiveBypass-updater/1.0" } }, response => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (redirects >= 4) { reject(new Error("redirecionamentos demais no update")); return; }
                void downloadText(new URL(response.headers.location, url).toString(), redirects + 1).then(resolveText, reject);
                return;
            }
            if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode ?? 0}`)); return; }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > 2 * 1024 * 1024) { response.destroy(new Error("resposta do update grande demais")); return; }
                chunks.push(chunk);
            });
            response.on("end", () => resolveText(Buffer.concat(chunks).toString("utf8")));
            response.on("error", reject);
        });
        req.setTimeout(PLUGIN_UPDATE_TIMEOUT_MS, () => req.destroy(new Error("update request timed out")));
        req.on("error", reject);
        req.end();
    });
}

function downloadBytes(url: string, redirects = 0): Promise<Buffer> {
    return new Promise((resolveBytes, reject) => {
        const req = request(url, { headers: { "User-Agent": "GoLiveBypass-updater/1.0" } }, response => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (redirects >= 4) { reject(new Error("redirecionamentos demais no update")); return; }
                void downloadBytes(new URL(response.headers.location, url).toString(), redirects + 1).then(resolveBytes, reject);
                return;
            }
            if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode ?? 0}`)); return; }
            const chunks: Buffer[] = [];
            let size = 0;
            let tooLarge = false;
            response.on("data", (chunk: Buffer) => {
                if (tooLarge) return;
                size += chunk.length;
                if (size > 16 * 1024 * 1024) {
                    tooLarge = true;
                    response.destroy(new Error("pacote do update grande demais"));
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

function updateVersion(value: string): string {
    return value.trim().replace(/^v/i, "");
}

function compareUpdateVersion(local: string, remote: string): number {
    const parse = (value: string) => updateVersion(value).split(/[.-]/).map(part => /^\d+$/.test(part) ? Number(part) : part);
    const a = parse(local);
    const b = parse(remote);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const left = a[i] ?? 0;
        const right = b[i] ?? 0;
        if (left === right) continue;
        if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
        if (typeof left === "number") return 1;
        if (typeof right === "number") return -1;
        return String(left).localeCompare(String(right)) < 0 ? -1 : 1;
    }
    return 0;
}

function releaseInfo(): Promise<{ version: string; zipUrl: string; shaUrl: string; prerelease: boolean }> {
    return downloadText(GITHUB_RELEASES_URL).then(raw => {
        const release = JSON.parse(raw) as {
            tag_name?: unknown;
            prerelease?: unknown;
            draft?: unknown;
            assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
        };
        if (release.draft === true || release.prerelease === true || typeof release.tag_name !== "string")
            throw new Error("nenhum release estável disponível");
        const asset = release.assets?.find(item => item.name === PLUGIN_ASSET && typeof item.browser_download_url === "string");
        if (!asset || typeof asset.browser_download_url !== "string") throw new Error("release sem o pacote do plugin");
        return { version: updateVersion(release.tag_name), zipUrl: asset.browser_download_url, shaUrl: `${asset.browser_download_url}.sha256`, prerelease: false };
    });
}

export async function checkPluginUpdate(_: IpcMainInvokeEvent) {
    try {
        const release = await releaseInfo();
        return { ok: true as const, current: PLUGIN_VERSION, latest: release.version, available: compareUpdateVersion(PLUGIN_VERSION, release.version) < 0 };
    } catch (error) {
        return { ok: false as const, current: PLUGIN_VERSION, error: safeDiagnosticDetail(error, 500) };
    }
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

export async function updatePlugin(_: IpcMainInvokeEvent) {
    const release = await releaseInfo();
    if (compareUpdateVersion(PLUGIN_VERSION, release.version) >= 0)
        return { ok: true as const, updated: false as const, current: PLUGIN_VERSION, latest: release.version };

    const [zip, checksumText] = await Promise.all([downloadBytes(release.zipUrl), downloadText(release.shaUrl)]);
    const expected = /^([a-f0-9]{64})\b/i.exec(checksumText)?.[1]?.toLowerCase();
    if (!expected) throw new Error("release sem SHA-256 válido");
    if (createHash("sha256").update(zip).digest("hex") !== expected) throw new Error("SHA-256 do plugin não confere");

    const work = mkdtempSync(join(tmpdir(), "golivebypass-update-"));
    const archive = join(work, PLUGIN_ASSET);
    const extracted = join(work, "extract");
    writeFileSync(archive, zip);
    mkdirSync(extracted);
    try {
        try { execFileSync("unzip", ["-q", archive, "-d", extracted], { stdio: "ignore" }); }
        catch { execFileSync("tar", ["-xf", archive, "-C", extracted], { stdio: "ignore" }); }
        const source = join(extracted, USERPLUGIN_DIR);
        const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name !== "GoLiveBypass" || typeof manifest.version !== "string" || updateVersion(manifest.version) !== release.version)
            throw new Error("manifest do plugin não corresponde ao release");

        const { projectRoot, target } = userpluginSource();
        const backupRoot = join(projectRoot, ".golivebypass-update-backups");
        mkdirSync(backupRoot, { recursive: true });
        const backup = join(backupRoot, `${USERPLUGIN_DIR}-${Date.now()}`);
        renameSync(target, backup);
        try {
            renameSync(source, target);
            rebuildUserplugin(projectRoot);
        } catch (error) {
            rmSync(target, { recursive: true, force: true });
            renameSync(backup, target);
            try { rebuildUserplugin(projectRoot); } catch (rollbackError) { log("error", "falha ao restaurar o build anterior", { erro: rollbackError }); }
            throw error;
        }
        log("info", `plugin atualizado de ${PLUGIN_VERSION} para ${release.version}; reload necessário`);
        return { ok: true as const, updated: true as const, current: PLUGIN_VERSION, latest: release.version };
    } finally {
        rmSync(work, { recursive: true, force: true });
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
