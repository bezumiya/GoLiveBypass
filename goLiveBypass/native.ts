/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AsyncLocalStorage } from "async_hooks";
import { RendererSettings } from "@main/settings";
import { execFile, execFileSync, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
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
    type Stats,
    statSync,
    writeFileSync,
} from "fs";
import type { ClientRequest } from "http";
import { request } from "https";
import { homedir, tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";

import {
    assinaturaDoRelato,
    type BugReportHttpSpec,
    type BugReportResult,
    type BugReportState,
    decidirEnvio,
    estadoDeEnvioValido,
    interpretarResposta,
    interpretarStatusDeBloqueio,
    limparEntradaDoRenderer,
    montarLog,
    montarMeta,
    montarPayload,
    montarPedido,
    montarPedidoDeStatus,
    resultadoDeduplicado,
    resultadoDeRede,
    resultadoSegredoRemanescente,
    resultadoTituloObrigatorio,
} from "./bug-report";
import {
    choosePluginRelease,
    comparePluginVersions,
    normalizePluginVersion,
    type PluginReleaseCandidate,
    type PluginUpdateChannel,
} from "./update-channel";
import { isCompatiblePluginManifest, releaseAssetUrl, securePluginUpdateUrl } from "./update-security";
import { defaultPluginVpnDataDir, PluginVpnController, type ProtonLoginPayload, type ProtonOptimizationOptions } from "./vpn-controller";
import { disposeWireSockSnapshotWorker } from "./vpn-snapshot-worker";
import {
    findSystemBinary,
    GOLIVE_PLUGIN_LINUX_NAMESPACE,
    isFlatpak as isLinuxFlatpak,
    isProcessInNamespace,
    isValidLinuxName,
} from "./vpn-linux";
import * as proton from "./vpn-proton";
import { safeDiagnosticDetail } from "./vpn-types";
import { createOperationId, createPluginLogger, trimJsonlTailByBytes, type PluginLogContext } from "./plugin-log";

const PLUGIN_VERSION = "2.0.6-beta-20";
const PLUGIN_ASSET = "goLiveBypass-vencord.zip";
const PLUGIN_CHECKSUM_ASSET = `${PLUGIN_ASSET}.sha256`;
const GITHUB_RELEASES_URL = "https://api.github.com/repos/bezumiya/GoLiveBypass/releases?per_page=20";
const PLUGIN_UPDATE_TIMEOUT_MS = 30_000;
const UNKNOWN_PLUGIN_VERSION = "unknown";
const PLUGIN_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const PLUGIN_UPDATE_INITIAL_DELAY_MS = 8_000;
const PLUGIN_API_MAX_BYTES = 2 * 1024 * 1024;
const PLUGIN_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
const PLUGIN_MAX_REDIRECTS = 4;
const USERPLUGIN_DIR = "goLiveBypass";
const UPDATE_STAGING_DIR = ".golivebypass-update-staging";

function resolvePlatformHelperRelativePath(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
    const platformKey = platform === "win32" ? "win32" : platform === "linux" ? "linux" : platform;
    const exeName = platform === "win32" ? "proton-confgen.exe" : "proton-confgen";
    return `bin/${platformKey}-${arch}/${exeName}`;
}

function requiredFilesForPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
    const common = [
        "index.tsx",
        "native.ts",
        "plugin-log.ts",
        "bug-report.ts",
        "update-channel.ts",
        "update-security.ts",
        "stability.ts",
        "vpn-controller.ts",
        "vpn-proton.ts",
        "vpn-types.ts",
        "vpn-snapshot.ts",
        "vpn-snapshot-worker.ts",
        "vpn-windows.ts",
        "vpn-linux.ts",
        "manifest.json",
    ];
    const files = [...common];
    // Os helpers de Linux (proton-confgen e netns-launcher) NAO entram na lista: eles vao
    // comprimidos dentro do vpn-proton.ts e o runtime os materializa quando nao existe bin/
    // (materializeEmbeddedLinuxAsset) — foi por isso que o pacote deixou de carrega-los. Exigir
    // o arquivo aqui rejeitava o proprio zip do release em Linux, que traz so o helper do
    // Windows: a arvore instalada e o update preparado nunca passavam da validacao.
    if (platform === "win32") files.push(resolvePlatformHelperRelativePath(platform, arch));
    return files;
}
function findLinuxNetnsLauncher(): string {
    const candidates = [
        join(__dirname, "bin", "linux-x64", "netns-launcher"),
        join(__dirname, "goLiveBypass", "bin", "linux-x64", "netns-launcher"),
        resolve(__dirname, "../../src/userplugins/goLiveBypass/bin/linux-x64/netns-launcher"),
        resolve(__dirname, "../src/userplugins/goLiveBypass/bin/linux-x64/netns-launcher"),
        resolve(process.cwd(), "goLiveBypass/bin/linux-x64/netns-launcher"),
        resolve(process.cwd(), "src/userplugins/goLiveBypass/bin/linux-x64/netns-launcher"),
    ];
    for (const candidate of candidates) {
        try {
            const stat = lstatSync(candidate);
            if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && (stat.mode & 0o111) !== 0 && (stat.mode & 0o022) === 0)
                return resolve(candidate);
        } catch {
            // try the next known package location
        }
    }
    try { return proton.materializeEmbeddedLinuxAsset("netns-launcher", VPN_DATA_DIR); } catch {}
    throw new Error("O launcher Linux do namespace não foi encontrado no pacote do plugin.");
}
async function installFlatpakNetnsLauncher(flatpakSpawn: string, pkexec: string, launcher: string, uid: number): Promise<string> {
    const install = findSystemBinary("install");
    if (!install) throw new Error("Utilitário 'install' não encontrado no host para preparar o relaunch Flatpak.");
    const destination = `/run/user/${uid}/golivebypass-netns-launcher-${process.pid}-${Date.now()}`;
    const payload = readFileSync(launcher);
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const child = spawn(flatpakSpawn, ["--host", pkexec, install, "-m", "700", "/dev/stdin", destination], {
        stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(destination);
    };
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-1000); });
    child.once("error", error => finish(error));
    child.once("close", code => {
        if (code === 0) {
            finish();
            return;
        }
        if (/AccessDenied|Portal call failed|Permission denied/i.test(stderr)) {
            finish(new Error("O cliente Flatpak não possui permissão para preparar o launcher no host. Conceda: flatpak override --user --talk-name=org.freedesktop.Flatpak <app-id>"));
            return;
        }
        finish(new Error(`Não foi possível preparar o launcher Linux no host (código ${code ?? "desconhecido"}): ${stderr.trim()}`));
    });
    child.stdin?.once("error", error => finish(error));
    child.stdin?.end(payload);
    return promise;
}

async function removeFlatpakNetnsLauncher(flatpakSpawn: string, pkexec: string, destination: string): Promise<void> {
    const rm = findSystemBinary("rm");
    if (!rm) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const child = spawn(flatpakSpawn, ["--host", pkexec, rm, "-f", destination], { stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
    await promise;
}

const USERPLUGIN_BUILD_TIMEOUT_MS = 120_000;
const PENDING_UPDATE_FILE = "plugin-update-pending.json";
const UPDATE_LOCK_FILE = "plugin-update.lock";
const BACKUP_DIR = ".golivebypass-update-backups";
const SAFE_BACKUP_NAME = /^goLiveBypass-[0-9]{10,}$/;
const SAFE_DISPLACED_NAME = /^goLiveBypass-pending-[0-9]{10,}$/;
const CAPTCHA_IPC_CHANNEL = "golive-plugin-proton-captcha-response";
const CAPTCHA_TIMEOUT_MS = 120_000;
const SOURCE_DIGEST_PATTERN = /^[a-f0-9]{64}$/i;

const VPN_DATA_DIR = defaultPluginVpnDataDir();
const GUI_DATA_DIR = dirname(VPN_DATA_DIR);
const LOG_FILE = join(VPN_DATA_DIR, "plugin-vpn.log");

const logContext = new AsyncLocalStorage<PluginLogContext>();

function trimPluginLogFile(): void {
    const bytes = readFileSync(LOG_FILE);
    if (bytes.byteLength <= 256 * 1024) return;
    writeFileSync(LOG_FILE, trimJsonlTailByBytes(bytes, 256 * 1024));
}

function persistPluginLogLine(line: string): void {
    try {
        mkdirSync(VPN_DATA_DIR, { recursive: true });
        trimPluginLogFile();
        appendFileSync(LOG_FILE, line, "utf8");
        trimPluginLogFile();
    } catch {
        // Diagnóstico nunca pode impedir o Discord de continuar abrindo.
    }
}

const pluginLogger = createPluginLogger({
    component: "plugin.native",
    pluginVersion: PLUGIN_VERSION,
    platform: process.platform,
    arch: process.arch,
    onLine: persistPluginLogLine,
});

try {
    if (existsSync(LOG_FILE)) {
        const previous = readFileSync(LOG_FILE, "utf8").slice(-128 * 1024).split(/\r?\n/);
        pluginLogger.restore(previous);
    }
} catch {
    // O ring da execução corrente continua disponível se o arquivo antigo não puder ser lido.
}

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
    const { plugins } = root;
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

const LEGACY_EVENT_MAP: Record<string, string> = {
    "abrindo plugin VPN": "plugin.process.started",
    "falha ao inicializar o controlador VPN": "plugin.process.failed",
    "ativação VPN falhou": "vpn.activation.failed",
    "ativação VPN Linux falhou": "vpn.activation.failed",
    "serviço WireSock ativo com filtro por aplicativo": "wiresock.start.accepted",
    "WireSock próprio parado": "wiresock.stop.completed",
    "diagnóstico assíncrono da rede": "wiresock.diagnostic",
    "probe de rota do Discord concluído": "route.probe.completed",
    "probe de rota do Discord falhou": "route.probe.failed",
};

function eventForMessage(message: string): string {
    const normalized = message.trim();
    if (/^[A-Za-z][A-Za-z0-9_.-]{2,}$/.test(normalized) && normalized.includes(".")) return normalized;
    const lower = normalized.toLowerCase();
    const exact = LEGACY_EVENT_MAP[normalized];
    if (exact) return exact;
    if (lower.includes("watchdog")) return "wiresock.watchdog";
    if (lower.includes("rota") || lower.includes("probe de rota")) return "route.diagnostic";
    if (lower.includes("helper") || lower.includes("proton-confgen")) return "helper.event";
    if (lower.includes("wiresock")) return "wiresock.event";
    if (lower.includes("updater") || lower.includes("update")) return "updater.event";
    if (lower.includes("proton") || lower.includes("autenticação") || lower.includes("sessão")) return "proton.event";
    return "legacy.message";
}

function log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
    const context = logContext.getStore() || {};
    const operationId = typeof data?.operation_id === "string" ? data.operation_id : context.operation_id;
    const attemptId = typeof data?.attempt_id === "string" ? data.attempt_id : context.attempt_id;
    const phase = typeof data?.phase === "string" ? data.phase : context.phase;
    const cleanData = data ? { ...data } : undefined;
    if (cleanData) {
        delete cleanData.operation_id;
        delete cleanData.attempt_id;
        delete cleanData.phase;
    }
    pluginLogger.emit(level, eventForMessage(message), {
        ...context,
        operation_id: operationId,
        attempt_id: attemptId,
        phase,
    }, cleanData, message);
}

function operationFailure(value: unknown): { failed: boolean; error?: unknown } {
    if (value === null || typeof value !== "object" || !("success" in value) || value.success !== false)
        return { failed: false };
    return { failed: true, error: "error" in value ? value.error : undefined };
}
function runLogOperation<T>(prefix: string, operation: () => Promise<T> | T): Promise<T> {
    const operationId = createOperationId(prefix);
    return logContext.run({ operation_id: operationId }, async () => {
        const startedAt = Date.now();
        log("info", `operation.${prefix}.started`, { phase: "requested" });
        try {
            const result = await operation();
            const failure = operationFailure(result);
            log(failure.failed ? "error" : "info", `operation.${prefix}.${failure.failed ? "failed" : "completed"}`, {
                phase: failure.failed ? "failed" : "completed",
                duration_ms: Date.now() - startedAt,
                ...(failure.failed ? { error: failure.error } : {}),
            });
            return result;
        } catch (error) {
            log("error", `operation.${prefix}.failed`, { phase: "failed", duration_ms: Date.now() - startedAt, error: safeDiagnosticDetail(error, 300) });
            throw error;
        }
    });
}

async function requestRelaunch(namespace: string | null): Promise<boolean> {
    if (process.platform !== "linux") {
        return false;
    }

    if (namespace !== null && !isValidLinuxName(namespace)) {
        throw new Error(`Nome de network namespace inválido para reinício: ${namespace}`);
    }

    const inFlatpak = isLinuxFlatpak();
    let flatpakId: string | null = null;
    if (inFlatpak) {
        flatpakId = process.env.FLATPAK_ID?.trim() || null;
        if (!flatpakId && existsSync("/.flatpak-info")) {
            try {
                const infoContent = readFileSync("/.flatpak-info", "utf8");
                const match = infoContent.match(/^app=(.+)$/m) || infoContent.match(/^name=(.+)$/m);
                if (match && match[1]?.trim()) flatpakId = match[1].trim();
            } catch {
                // ignore
            }
        }
        if (!flatpakId) {
            throw new Error("Ambiente Flatpak detectado, mas o identificador da aplicação (FLATPAK_ID) não pôde ser determinado.");
        }
    }

    const currentlyInNamespace = isProcessInNamespace();

    const rawArgs = process.argv.slice(1);
    const clientArgs: string[] = [];
    for (const arg of rawArgs) {
        if (typeof arg !== "string" || arg.length > 4096 || /[\0\r\n]/.test(arg)) continue;
        if (/password|secret|token|auth/i.test(arg)) continue;
        clientArgs.push(arg);
    }

    const safeEnvKeys = [
        "WAYLAND_DISPLAY",
        "DISPLAY",
        "XDG_BACKEND",
        "XDG_SESSION_TYPE",
        "GDK_BACKEND",
        "QT_QPA_PLATFORM",
        "MOZ_ENABLE_WAYLAND",
        "ELECTRON_OZONE_PLATFORM_HINT",
        "OZONE_PLATFORM",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "DESKTOP_SESSION",
        "XDG_CONFIG_DIRS",
        "XDG_DATA_DIRS",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "PULSE_SERVER",
        "PIPEWIRE_REMOTE",
        "PIPEWIRE_LATENCY",
        "HOME",
        "USER",
        "LOGNAME",
        "PATH",
        "LANG",
        "LC_ALL",
        "LC_MESSAGES",
        "SHELL",
        "TERM",
        "TZ",
    ];

    const safeEnv: NodeJS.ProcessEnv = {};
    for (const key of safeEnvKeys) {
        const val = process.env[key];
        if (typeof val === "string" && val.length > 0 && !/[\0\r\n]/.test(val)) {
            safeEnv[key] = val;
        }
    }

    if (namespace) {
        safeEnv[GOLIVE_PLUGIN_LINUX_NAMESPACE] = namespace;
    }

    const setenvArgs: string[] = [];
    for (const [k, v] of Object.entries(safeEnv)) {
        if (v && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/[\0\r\n]/.test(v)) {
            setenvArgs.push(`--setenv=${k}=${v}`);
        }
    }
    const launcherEnvArgs: string[] = [];
    for (const [k, v] of Object.entries(safeEnv)) {
        if (v && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/[\0\r\n]/.test(v)) {
            launcherEnvArgs.push(`--env=${k}=${v}`);
        }
    }

    if (!namespace && currentlyInNamespace) {
        const unitName = `golivebypass-relaunch-${Date.now()}`;
        if (inFlatpak) {
            const flatpakSpawn = findSystemBinary("flatpak-spawn");
            if (!flatpakSpawn) {
                throw new Error("Ponte Flatpak ('flatpak-spawn') ausente. Instale o flatpak ou execute o cliente nativo.");
            }
            const args = [
                "--host",
                "systemd-run",
                "--user",
                "--collect",
                `--unit=${unitName}`,
                ...setenvArgs,
                "flatpak",
                "run",
                `--unset-env=${GOLIVE_PLUGIN_LINUX_NAMESPACE}`,
                flatpakId!,
                ...clientArgs,
            ];
            await new Promise<void>((resolve, reject) => {
                execFile(flatpakSpawn, args, (error, _stdout, stderr) => {
                    if (error) {
                        const errStr = `${stderr || ""} ${error.message || ""}`;
                        if (/AccessDenied|Portal call failed|Permission denied/i.test(errStr)) {
                            reject(new Error(
                                "O cliente Flatpak não possui permissão para executar comandos no host via flatpak-spawn. " +
                                `Conceda a permissão no terminal: flatpak override --user --talk-name=org.freedesktop.Flatpak ${flatpakId}`
                            ));
                            return;
                        }
                        if (/Failed to connect to bus|No such file or directory/i.test(errStr) || error.code === "ENOENT") {
                            reject(new Error("O serviço 'systemd --user' está indisponível ou inacessível no host para realizar o reinício fora do namespace."));
                            return;
                        }
                        reject(new Error(`Falha no flatpak-spawn/systemd-run para reinício fora do namespace: ${errStr.trim()}`));
                        return;
                    }
                    resolve();
                });
            });
        } else {
            const systemdRun = findSystemBinary("systemd-run");
            if (!systemdRun) {
                throw new Error("Utilitário 'systemd-run' ausente. O reinício para fora do namespace de rede exige systemd na sessão do usuário.");
            }
            if (!existsSync(process.execPath)) {
                throw new Error(`Executável do cliente Discord ausente ou inacessível: ${process.execPath}`);
            }
            const args = [
                "--user",
                "--collect",
                `--unit=${unitName}`,
                ...setenvArgs,
                process.execPath,
                ...clientArgs,
            ];
            await new Promise<void>((resolve, reject) => {
                execFile(systemdRun, args, (error, _stdout, stderr) => {
                    if (error) {
                        const errStr = `${stderr || ""} ${error.message || ""}`;
                        if (/Failed to connect to bus|No such file or directory/i.test(errStr)) {
                            reject(new Error("O serviço 'systemd --user' está indisponível ou inacessível para realizar o reinício fora do namespace."));
                            return;
                        }
                        reject(new Error(`Falha ao executar systemd-run para reinício fora do namespace: ${errStr.trim()}`));
                        return;
                    }
                    resolve();
                });
            });
        }

        log("info", "comando de relaunch externo aceito com sucesso; encerrando processo atual");
        app.exit(0);
        return true;
    }

    if (namespace) {
        const directNativeLaunch = currentlyInNamespace && !inFlatpak;
        let temporaryHostLauncher: string | undefined;
        let temporaryHostLauncherAccepted = false;
        try {
            const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
            const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
            if (uid === undefined || gid === undefined) throw new Error("Não foi possível determinar o usuário atual para o relaunch Linux.");

            let command: string;
            let spawnArgs: string[];
            let childEnv: NodeJS.ProcessEnv | undefined;
            if (directNativeLaunch) {
                if (!existsSync(process.execPath)) {
                    throw new Error(`Executável do cliente Discord ausente ou inacessível: ${process.execPath}`);
                }
                command = process.execPath;
                spawnArgs = clientArgs;
                childEnv = safeEnv;
            } else {
                const pkexec = findSystemBinary("pkexec");
                if (!pkexec) throw new Error("Utilitário 'pkexec' ausente; o relaunch para entrar no namespace Linux exige polkit.");
                const launcher = findLinuxNetnsLauncher();
                const target = inFlatpak ? (findSystemBinary("flatpak") || "/usr/bin/flatpak") : process.execPath;
                if (!inFlatpak && !existsSync(target)) {
                    throw new Error(`Executável do cliente Discord ausente ou inacessível: ${target}`);
                }
                const targetArgs = inFlatpak
                    ? ["run", `--env=${GOLIVE_PLUGIN_LINUX_NAMESPACE}=${namespace}`, flatpakId!, ...clientArgs]
                    : clientArgs;
                const launcherArgs = [
                    namespace,
                    String(uid),
                    String(gid),
                    ...(inFlatpak ? ["--self-delete"] : []),
                    ...launcherEnvArgs,
                    "--",
                    target,
                    ...targetArgs,
                ];
                if (inFlatpak) {
                    const flatpakSpawn = findSystemBinary("flatpak-spawn");
                    if (!flatpakSpawn) throw new Error("Ponte Flatpak ('flatpak-spawn') ausente. Conceda acesso ao host ou use o cliente nativo.");
                    temporaryHostLauncher = await installFlatpakNetnsLauncher(flatpakSpawn, pkexec, launcher, uid);
                    command = flatpakSpawn;
                    spawnArgs = ["--host", pkexec, temporaryHostLauncher, ...launcherArgs];
                } else {
                    command = pkexec;
                    spawnArgs = [launcher, ...launcherArgs];
                }
            }

            const { promise, resolve, reject } = Promise.withResolvers<void>();
            const child = spawn(command, spawnArgs, {
                detached: true,
                stdio: ["ignore", "ignore", "pipe"],
                env: childEnv,
            });
            let settled = false;
            let stderrData = "";
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                if (error) reject(error);
                else resolve();
            };
            child.stderr?.on("data", chunk => { stderrData = (stderrData + chunk.toString("utf8")).slice(-1000); });
            child.once("error", error => finish(error));
            child.once("close", (code, signal) => {
                if (code === 0 || code === null) {
                    finish();
                    return;
                }
                const detail = `${stderrData.trim()} (código ${code}, sinal ${signal})`.trim();
                if (/AccessDenied|Portal call failed|Permission denied/i.test(detail)) {
                    finish(new Error(`O cliente Flatpak não possui permissão para executar o relaunch no host. Conceda: flatpak override --user --talk-name=org.freedesktop.Flatpak ${flatpakId || "<app-id>"}`));
                    return;
                }
                finish(new Error(`Relaunch Linux encerrou prematuramente: ${detail}`));
            });
            const timer = setTimeout(() => finish(), 200);
            timer.unref?.();
            child.unref();
            await promise;
            temporaryHostLauncherAccepted = true;
        } finally {
            if (temporaryHostLauncher && !temporaryHostLauncherAccepted) {
                const flatpakSpawn = findSystemBinary("flatpak-spawn");
                const pkexec = findSystemBinary("pkexec");
                if (flatpakSpawn && pkexec) await removeFlatpakNetnsLauncher(flatpakSpawn, pkexec, temporaryHostLauncher);
            }
        }

        log("info", "comando de relaunch no namespace aceito com sucesso; encerrando processo atual", { namespace });
        app.exit(0);
        return true;
    }

    if (inFlatpak) {
        const flatpakSpawn = findSystemBinary("flatpak-spawn");
        if (!flatpakSpawn) {
            throw new Error("Ponte Flatpak ('flatpak-spawn') ausente. Instale o flatpak ou execute o cliente nativo.");
        }
        const spawnArgs = [
            "--host",
            "flatpak",
            "run",
            `--unset-env=${GOLIVE_PLUGIN_LINUX_NAMESPACE}`,
            flatpakId!,
            ...clientArgs,
        ];
        const child = spawn(flatpakSpawn, spawnArgs, {
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.unref();
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            child.once("error", err => { if (!settled) { settled = true; reject(err); } });
            child.once("exit", (code, signal) => {
                if (!settled && code !== 0 && code !== null) {
                    settled = true;
                    reject(new Error(`Reinício Flatpak encerrou prematuramente (código: ${code}, sinal: ${signal})`));
                }
            });
            setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 200);
        });
    } else {
        if (!existsSync(process.execPath)) {
            throw new Error(`Executável do cliente Discord ausente ou inacessível: ${process.execPath}`);
        }
        const child = spawn(process.execPath, clientArgs, {
            detached: true,
            stdio: "ignore",
            env: safeEnv,
        });
        child.unref();
    }

    log("info", "comando de relaunch normal aceito com sucesso; encerrando processo atual");
    app.exit(0);
    return true;
}

const controller = new PluginVpnController({
    dataDir: VPN_DATA_DIR,
    guiDataDir: GUI_DATA_DIR,
    readSettings: controllerSettings,
    isEnabled: pluginEnabled,
    log,
    requestRelaunch,
});
export function logFromRenderer(_: IpcMainInvokeEvent, message: unknown): void {
    if (typeof message !== "string" || !message.trim()) return;
    const trimmed = message.slice(0, 2000);
    const isError = trimmed.startsWith("[error][renderer]");
    const clean = isError ? trimmed.replace(/^\[error\]\[renderer\]\s*/, "") : trimmed;
    pluginLogger.emit(isError ? "error" : "info", isError ? "renderer.error" : "renderer.message", {
        ...logContext.getStore(),
        component: "plugin.renderer",
    }, { error: clean, source: "renderer" }, clean);
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
    return runLogOperation("vpn-activation", () => controller.enable());
}

export function enableAutomatic(_: IpcMainInvokeEvent) {
    return runLogOperation("vpn-autostart", () => controller.enableAutomatic());
}

export function shutdown(_: IpcMainInvokeEvent) {
    // Desativar o userplugin no Windows não reinicia o Discord para não interromper
    // chamadas em andamento. No Linux, contudo, um processo dentro de netns não consegue
    // voltar à rede host sem relaunch; portanto pedimos relaunch externo apenas no Linux.
    controller.cancelProtonLogin();
    disposeWireSockSnapshotWorker();
    return runLogOperation("vpn-shutdown", () => controller.shutdown(process.platform === "linux"));
}

export function restoreNetwork(_: IpcMainInvokeEvent) {
    return runLogOperation("vpn-restore", () => controller.restoreNetwork());
}

export function restartDiscord(_: IpcMainInvokeEvent) {
    return runLogOperation("vpn-restart", () => controller.restartDiscord());
}

export function getVpnStatus(_: IpcMainInvokeEvent) {
    // O modo de armazenamento da sessão é uma propriedade da máquina, não do
    // tunel: a UI avisa antes do login quando a sessão não poderá ser guardada.
    //
    // A ponte IPC já devolve promessa ao renderer; usar o caminho assíncrono aqui tira a
    // consulta do WireSock (PowerShell, ~285ms medidos na VM) da thread principal, que é o
    // que engasgava a interface do Discord no watchdog e no polling do painel.
    return controller.getStatusAsync().then(status => ({
        ...status,
        sessionStorage: proton.protonSessionStorageMode(),
    }));
}

export function getProtonOptimizationStatus(_: IpcMainInvokeEvent): PluginOptimizationStatus {
    return { ...pluginOptimizationStatus };
}

export function getLog(_: IpcMainInvokeEvent): string {
    return pluginLogger.getLog();
}

export function getPluginVpnPaths(_: IpcMainInvokeEvent) {
    return { ...controller.paths, logPath: LOG_FILE };
}

// ------------------------------------------------------------------ reporte de bug
// Endpoint, URL de status e token são os MESMOS da GUI (golive-gui/electron/bugreport.ts).
// O token é extraível do pacote nativo por design — o escopo dele é abrir issue em
// repositório público, com rate limit por IP — e por isso nunca é exportado ao renderer
// nem escrito no log. O envio só acontece por ação do usuário: nada aqui é chamado em
// boot, falha, ativação ou updater.
const BUG_API_URL = "https://api.skyplaceia.com/bugs/v1/reports";
const BUG_STATUS_URL = "https://api.skyplaceia.com/bugs/v1/block-status";
const BUG_API_TOKEN = "c3d0bff691ecc3ddc6f6ca10037b9ac967c62547e681d3749204e50800504511";
const BUG_REPORT_STATE_FILE = "bug-report-state.json";
const BUG_STATUS_TIMEOUT_MS = 5_000;
const BUG_POST_TIMEOUT_MS = 15_000;
const BUG_RESPONSE_MAX_BYTES = 16 * 1024;
const BUG_LOG_TAIL_BYTES = 96 * 1024;

function bugReportStatePath(): string {
    return join(VPN_DATA_DIR, BUG_REPORT_STATE_FILE);
}

// Termos usados SÓ na varredura local do relato. A chave do perfil é lida apenas para
// virar termo de busca: nenhuma linha do arquivo entra no payload.
function coletarSegredosLocais(): string[] {
    const config = controllerSettings();
    const candidatos = [
        homedir(),
        VPN_DATA_DIR,
        typeof config.protonUsername === "string" ? config.protonUsername : "",
        typeof config.customConfigPath === "string" ? config.customConfigPath : "",
    ];

    const perfil = controller.paths.serviceConfigPath;
    if (existsSync(perfil)) {
        try {
            const chave = /PrivateKey\s*=\s*(\S+)/i.exec(readFileSync(perfil, "utf8"));
            if (chave) candidatos.push(chave[1]);
        } catch (error) {
            log("warn", "não consegui ler a chave do perfil WireGuard para a varredura do relato", { erro: error });
        }
    }

    return candidatos.filter(candidato => candidato.length >= 3);
}

function lerCaudaDoLog(maxBytes = BUG_LOG_TAIL_BYTES): string {
    try {
        if (!existsSync(LOG_FILE)) return "";
        const buffer = readFileSync(LOG_FILE);
        const pedaco = buffer.length > maxBytes ? buffer.subarray(buffer.length - maxBytes) : buffer;
        const texto = pedaco.toString("utf8");
        // O corte pode cair no meio de uma linha: descarta a primeira, parcial.
        return pedaco.length < buffer.length ? texto.slice(texto.indexOf("\n") + 1) : texto;
    } catch (error) {
        log("warn", "não consegui ler o log do plugin para o relato", { erro: error });
        return "";
    }
}

function lerEstadoDeEnvio(): BugReportState | null {
    try {
        if (!existsSync(bugReportStatePath())) return null;
        return estadoDeEnvioValido(JSON.parse(readFileSync(bugReportStatePath(), "utf8")));
    } catch {
        return null;
    }
}

// Só é chamada depois de um 201 com issue_url: uma tentativa que falhou não pode
// esconder o mesmo erro por 48h.
function gravarEstadoDeEnvio(signature: string, issueUrl: string): void {
    const destino = bugReportStatePath();
    const temporario = `${destino}.${process.pid}.tmp`;
    try {
        mkdirSync(VPN_DATA_DIR, { recursive: true });
        writeFileSync(temporario, JSON.stringify({ signature, issueUrl, at: Math.floor(Date.now() / 1000) }), "utf8");
        renameSync(temporario, destino);
    } catch (error) {
        log("warn", "não consegui gravar o estado do último relato", { erro: error });
        try {
            rmSync(temporario, { force: true });
        } catch {
            // Sem estado o pior caso é repetir o relato; nada a fazer aqui.
        }
    }
}

function bugRequest(spec: BugReportHttpSpec, timeoutMs: number): Promise<{ status: number; retryAfter: number; texto: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; retryAfter: number; texto: string }>();
    let settled = false;
    let req: ClientRequest | undefined;

    const resolver = (valor: { status: number; retryAfter: number; texto: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(valor);
    };
    const rejeitar = (erro: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(erro);
    };
    const deadline = setTimeout(() => {
        req?.destroy(new Error("prazo do relato excedido"));
        rejeitar(new Error("prazo do relato excedido"));
    }, timeoutMs);
    deadline.unref?.();

    const headers = { ...spec.headers };
    if (spec.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(spec.body, "utf8"));

    try {
        req = request(spec.url, { method: spec.method, headers }, response => {
            const partes: Buffer[] = [];
            let total = 0;
            response.on("data", (pedaco: Buffer) => {
                if (total >= BUG_RESPONSE_MAX_BYTES) return;
                total += pedaco.length;
                partes.push(pedaco);
            });
            response.on("error", rejeitar);
            response.on("end", () => resolver({
                status: response.statusCode ?? 0,
                retryAfter: Number(response.headers["retry-after"] ?? 0),
                texto: Buffer.concat(partes).subarray(0, BUG_RESPONSE_MAX_BYTES).toString("utf8"),
            }));
        });
    } catch (error) {
        rejeitar(error);
        return promise;
    }

    req.on("error", rejeitar);
    if (spec.body !== undefined) req.write(spec.body);
    req.end();

    return promise;
}

export async function getBugReportStatus(_: IpcMainInvokeEvent) {
    try {
        const resposta = await bugRequest(montarPedidoDeStatus({ url: BUG_STATUS_URL, token: BUG_API_TOKEN }), BUG_STATUS_TIMEOUT_MS);
        return interpretarStatusDeBloqueio(resposta.status, resposta.texto);
    } catch (error) {
        log("warn", "não consegui consultar o bloqueio de relatos", { erro: error });
        return { blocked: false, retryAfter: 0, remaining: 0 };
    }
}

export async function submitBugReport(_: IpcMainInvokeEvent, value: unknown): Promise<BugReportResult> {
    const pedido = limparEntradaDoRenderer(value);
    if (!pedido.title.trim()) return resultadoTituloObrigatorio();

    const segredos = coletarSegredosLocais();
    const blocoDeLog = pedido.includeLogs
        ? montarLog({ ring: pluginLogger.getLog(), caudaArquivo: lerCaudaDoLog(), sessao: pedido.session, segredos, token: BUG_API_TOKEN })
        : "";
    const status = await controller.getStatusAsync();
    const meta = montarMeta({
        versao: currentPluginVersion(),
        plataforma: `${process.platform}-${process.arch}`,
        electron: process.versions.electron ?? "?",
        node: process.versions.node ?? "?",
        estadoVpn: { state: status.state, active: status.active, owned: status.owned, generation: status.generation },
        modo: pluginSettings().vpnMode === "custom" ? "custom" : "proton",
        onboarding: pluginSettings().onboardingCompleted === true,
    });

    const montado = montarPayload({ titulo: pedido.title, descricao: pedido.description, log: blocoDeLog, meta, segredos, token: BUG_API_TOKEN });
    if (montado.bloqueado) {
        // O motivo fica no log local; o segredo que causou o bloqueio, nunca.
        log("warn", "envio de relato bloqueado antes de sair da máquina", { code: montado.code });
        return montado.code === "TITULO_OBRIGATORIO" ? resultadoTituloObrigatorio() : resultadoSegredoRemanescente();
    }

    const assinatura = assinaturaDoRelato(montado.payload.title, montado.payload.description);
    const decisao = decidirEnvio(lerEstadoDeEnvio(), assinatura, Math.floor(Date.now() / 1000));
    if (!decisao.enviar && decisao.issueUrl) {
        log("info", "relato igual aos das últimas 48h não foi reenviado");
        return resultadoDeduplicado(decisao.issueUrl);
    }

    try {
        const resposta = await bugRequest(montarPedido(montado.payload, { url: BUG_API_URL, token: BUG_API_TOKEN }), BUG_POST_TIMEOUT_MS);
        const resultado = interpretarResposta(resposta.status, resposta.retryAfter, resposta.texto);
        if (resultado.ok && resultado.issueUrl) {
            gravarEstadoDeEnvio(assinatura, resultado.issueUrl);
            log("info", "relato enviado", { issue: resultado.issueNumber ?? 0 });
        } else {
            log("warn", "envio de relato recusado pela API", { status: resposta.status, code: resultado.code });
        }
        return resultado.error ? { ...resultado, error: safeDiagnosticDetail(resultado.error) } : resultado;
    } catch (error) {
        log("warn", "envio de relato sem resposta", { erro: error });
        return resultadoDeRede();
    }
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
    return runLogOperation("proton-login", async () => {
        try {
            const payload = cleanLoginPayload(value);
            const parent = BrowserWindow.fromWebContents(event.sender);
            const result = await controller.loginProton(payload, (url, signal) => solveCaptcha(url, parent, signal).then(captcha => captcha.ok ? captcha.token : null));
            if (result.success && result.username) setStoredUsername(result.username);
            return result;
        } catch (error) {
            return { success: false as const, code: "CONFIGURATION_ERROR" as const, retryable: false, message: safeDiagnosticDetail(error, 500), error: safeDiagnosticDetail(error, 500) };
        }
    });
}

export function cancelProtonLogin(_: IpcMainInvokeEvent, requestId?: unknown) {
    return { cancelled: controller.cancelProtonLogin(typeof requestId === "string" ? requestId : undefined) };
}

export function checkProtonSession(_: IpcMainInvokeEvent, username?: unknown) {
    const value = typeof username === "string" && username.trim() ? username : String(controllerSettings().protonUsername || "");
    return runLogOperation("proton-session-check", () => controller.checkProtonSession(value).catch(() => ({
        valid: false,
        code: "UNKNOWN" as const,
        error: "Não foi possível verificar a sessão Proton.",
    })));
}

export function getProtonPlan(_: IpcMainInvokeEvent, username?: unknown) {
    const value = typeof username === "string" && username.trim() ? username : String(controllerSettings().protonUsername || "");
    return runLogOperation("proton-plan", () => controller.getProtonPlan(value));
}

export async function logoutProton(_: IpcMainInvokeEvent) {
    return runLogOperation("proton-logout", async () => {
        const result = await controller.logoutProton();
        if (result.success) setStoredUsername("");
        return result;
    });
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
    return runLogOperation("proton-optimization", () => controller.optimizeProton(options).then(result => {
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
    }));
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
        let req: ClientRequest | undefined;

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

        const deadlineTimer = setTimeout(() => abortRequest("update request timed out"), remaining);
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
        const { code } = (error as { code?: string });
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
        const { pid } = raw;
        const { token } = raw;
        const { startedAt } = raw;
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

interface PluginManifestData {
    name?: unknown;
    version?: unknown;
    updater?: unknown;
    platforms?: unknown;
}

function readManifest(target: string): PluginManifestData {
    const manifestPath = join(target, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("manifest do plugin ausente");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifestData;
    if (!isCompatiblePluginManifest(manifest, PLUGIN_ASSET)) throw new Error("manifest do plugin não pertence ao updater oficial");
    if (manifest.platforms !== undefined) {
        if (!Array.isArray(manifest.platforms) || !manifest.platforms.every(p => typeof p === "string" && p.trim().length > 0)) {
            throw new Error("manifest do plugin contém metadados de plataformas inválidos");
        }
    }
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

function validatePluginSourceTree(root: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): void {
    let rootStats: Stats;
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

    const manifest = readManifest(root);
    if (Array.isArray(manifest.platforms)) {
        const normalizedPlatforms = manifest.platforms.map(p => String(p).trim().toLowerCase());
        const current = platform === "win32" ? ["win32", "windows"] : [platform];
        if (!current.some(p => normalizedPlatforms.includes(p))) {
            throw new Error(`o pacote do plugin não suporta a plataforma atual (${platform})`);
        }
    }

    for (const relative of requiredFilesForPlatform(platform, arch)) {
        const candidate = join(root, relative);
        let stats: Stats;
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

    const { sourceDigest } = pending;
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
            if (pluginUpdateCheckFlight?.promise === flight) pluginUpdateCheckFlight = null;
        });
    const trackedFlight: PluginUpdateFlight<PluginUpdateCheckResult> = { policyKey, revision, controller, promise: flight };
    pluginUpdateCheckFlight = trackedFlight;
    return flight;
}

async function performPluginUpdateLocked(policy: PluginUpdatePolicy, revision: number, controller: AbortController): Promise<PluginUpdateResult> {
    const { signal } = controller;
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
            if (pluginUpdateFlight?.promise === flight) pluginUpdateFlight = null;
        });
    const trackedFlight: PluginUpdateFlight<PluginUpdateResult> = { policyKey, revision, controller, promise: flight };
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
    return runLogOperation("updater-check", async () => {
        const policy = policyFrom(value);
        const revision = pluginUpdatePolicyRevision;
        const result = runPluginUpdateCheck(policy);
        void result.then(valueResult => setPluginUpdateLastError(policy, revision, valueResult.ok ? null : valueResult.error));
        return await result;
    });
}

export async function updatePlugin(_: IpcMainInvokeEvent, value?: unknown): Promise<PluginUpdateResult> {
    return runLogOperation("updater-update", async () => {
        const policy = policyFrom(value);
        const revision = pluginUpdatePolicyRevision;
        const result = runPluginUpdate(policy, revision);
        void result.then(valueResult => setPluginUpdateLastError(policy, revision, valueResult.ok ? null : valueResult.error));
        return await result;
    });
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
    catch { return normalizePluginVersion(PLUGIN_VERSION) ?? UNKNOWN_PLUGIN_VERSION; }
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
    // A limpeza precisa terminar antes de o processo morrer, mas o fechamento NAO pode ficar
    // pendurado. `event.preventDefault()` cancela o quit com as janelas ja destruidas: se a
    // restauracao nao confirmar, o app vira um processo SEM interface -- nao fecha (so pelo
    // gerenciador de tarefas) e nao reabre, porque o processo antigo continua segurando o
    // lugar. Relato real no Windows, com o log do plugin registrando
    // "fechamento aguardou porque a restauracao da VPN nao foi confirmada".
    //
    // Por isso a saida acontece de qualquer forma, como no before-quit da GUI
    // (restore.catch(log).finally(app.quit)): o que falhou fica no log e o boot seguinte
    // adota owner.lock + WireSock para concluir a restauracao. Continuar vivo nao restaura
    // nada -- so esconde o erro e deixa o usuario sem conseguir fechar nem reabrir.
    void runLogOperation("vpn-shutdown", () => controller.shutdown(false))
        .then(result => {
            if (!result.success)
                log("error", "fechamento seguiu sem confirmar a restauração da VPN", { state: result.state, erro: result.error });
        })
        .catch(error => {
            log("error", "falha ao restaurar a rede antes do fechamento", { erro: safeDiagnosticDetail(error, 500) });
        })
        .finally(() => {
            // `app.exit()` não emite `will-quit`: encerra a worker aqui também, para nenhuma
            // sessão do PowerShell ficar pendurada quando o app sai por este caminho.
            disposeWireSockSnapshotWorker();
            app.exit(0);
        });
});

// A worker da inspeção não pode sobreviver ao processo: o `unref` já não a segura, mas
// encerrar aqui garante que nenhuma sessão do PowerShell fique órfã quando o app sai.
app.on("will-quit", () => {
    disposeWireSockSnapshotWorker();
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
            const result = await controller.enableAutomatic();
            if (!result.success && !result.suppressed) log("warn", "VPN não foi ativada no boot", { estado: result.state, erro: result.error });
        }
    } else if (pluginEnabled()) {
        log("info", "VPN não foi ativada no boot porque o onboarding ainda não foi concluído");
    }
}).catch(error => log("error", "falha ao inicializar o controlador VPN", { erro: error }));
