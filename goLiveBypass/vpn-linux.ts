/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import net from "net";
import path from "path";

import {
    isValidWireGuardKey,
    safeDiagnosticDetail,
    type VpnOwnerRecord,
} from "./vpn-types";

export const GOLIVE_PLUGIN_LINUX_NAMESPACE = "GOLIVE_PLUGIN_LINUX_NAMESPACE";
export const MAX_LINUX_INTERFACE_LEN = 15;
export const MAX_LINUX_NAMESPACE_LEN = 31;
export const PROTECTED_LINUX_NAMES = Object.freeze(["discord-vpn", "wg-discord"] as const);
export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
export const DEFAULT_AUTH_PROMPT_TIMEOUT_MS = 60_000;
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export type LinuxLogger = (
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>
) => void;

export interface LinuxNetworkOwner {
    namespace?: string;
    interfaceName?: string;
}

export interface LinuxDependencyStatus {
    ok: boolean;
    elevationOk: boolean;
    hasIp: boolean;
    hasWg: boolean;
    hasPkexec: boolean;
    hasFlatpakSpawn: boolean;
    hasSystemdRun: boolean;
    isFlatpak: boolean;
    inNamespace: boolean;
    issues: string[];
    missing: string[];
    error?: string;
    paths: {
        ip: string | null;
        wg: string | null;
        pkexec: string | null;
        systemdRun: string | null;
        flatpakSpawn: string | null;
        install: string | null;
        mkdir: string | null;
        rm: string | null;
    };
}
export type LinuxAuthorizationCode = "AUTHORIZED" | "CANCELLED" | "TIMEOUT" | "FAILED";

export interface LinuxAuthorizationResult {
    authorized: boolean;
    code: LinuxAuthorizationCode;
    error?: string;
}

export interface LinuxNetworkInspection {
    active: boolean;
    owned: boolean;
    reliable: boolean;
    namespace: string | null;
    interfaceName: string | null;
    namespaceExists: boolean;
    interfaceExists: boolean;
    externalConflict: boolean;
    reason: string | null;
}

export interface LinuxNetworkCleanupResult {
    stopped: boolean;
    namespaceRemoved: boolean;
    interfaceRemoved: boolean;
    dnsRemoved: boolean;
    error?: string;
}

export interface LinuxStartOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    namespace?: string;
    interfaceName?: string;
    log?: LinuxLogger;
}

export interface LinuxStopOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    log?: LinuxLogger;
}

const DEFAULT_SYSTEM_DIRS = Object.freeze([
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
]);

const FLATPAK_HOST_BINARIES = new Set([
    "ip",
    "wg",
    "pkexec",
    "systemd-run",
    "install",
    "mkdir",
    "rm",
    "flatpak",
    "true",
    "alacritty",
    "foot",
    "kitty",
    "xterm",
    "gnome-terminal",
    "konsole",
]);

export function findSystemBinary(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
    if (!name || /[\0/\\]/.test(name)) return null;
    const candidates = new Set<string>();
    if (env.PATH) {
        for (const dir of env.PATH.split(":")) {
            const trimmed = dir.trim();
            if (trimmed && path.isAbsolute(trimmed)) {
                candidates.add(trimmed);
            }
        }
    }
    for (const dir of DEFAULT_SYSTEM_DIRS) {
        candidates.add(dir);
    }
    for (const dir of candidates) {
        const full = path.join(dir, name);
        try {
            const stat = fs.statSync(full);
            if (stat.isFile() && (stat.mode & 0o111) !== 0) {
                return full;
            }
        } catch {
            // ignore inaccessible files
        }
    }
    // Flatpak's filesystem view does not expose host tools. Return only
    // allowlisted absolute host paths; flatpak-spawn executes them outside
    // the sandbox and the preflight still reports actionable portal errors.
    if (isFlatpak(env) && FLATPAK_HOST_BINARIES.has(name)) return `/usr/bin/${name}`;
    return null;
}

export function isLinux(platform: string = process.platform): boolean {
    return platform === "linux";
}

export function isFlatpak(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env.FLATPAK_ID || env.FLATPAK_SANDBOX_DIR || fs.existsSync("/.flatpak-info"));
}

export function isProtectedLinuxName(name: string): boolean {
    if (typeof name !== "string") return false;
    const lower = name.trim().toLowerCase();
    return (PROTECTED_LINUX_NAMES as readonly string[]).includes(lower);
}

export function isValidLinuxName(name: string, maxLen = MAX_LINUX_NAMESPACE_LEN): boolean {
    if (typeof name !== "string") return false;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > maxLen) return false;
    if (trimmed === "." || trimmed === "..") return false;
    if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) return false;
    if (/[\s]/.test(trimmed)) return false;
    return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(trimmed);
}

export function isProcessInNamespace(namespace?: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!isLinux()) return false;
    const envNamespace = typeof env[GOLIVE_PLUGIN_LINUX_NAMESPACE] === "string"
        ? env[GOLIVE_PLUGIN_LINUX_NAMESPACE]!.trim()
        : "";
    const targetNamespace = namespace?.trim() || envNamespace;
    if (!targetNamespace || (envNamespace && envNamespace !== targetNamespace)) return false;
    try {
        const nsRunPath = path.join("/run/netns", targetNamespace);
        const selfNsPath = "/proc/self/ns/net";
        if (!fs.existsSync(nsRunPath) || !fs.existsSync(selfNsPath)) return false;
        const statNs = fs.statSync(nsRunPath);
        const statSelf = fs.statSync(selfNsPath);
        return statNs.ino > 0 && statNs.ino === statSelf.ino;
    } catch {
        return false;
    }
}

interface CommandSpec {
    file: string;
    args: string[];
}

function resolveCommandInvocation(
    binaryPath: string,
    args: string[],
    options: { elevated: boolean; inNamespace: boolean; isFlatpakEnv: boolean; env?: NodeJS.ProcessEnv }
): CommandSpec {
    const env = options.env || process.env;
    let cmdFile = binaryPath;
    let cmdArgs = [...args];

    if (options.elevated) {
        const pkexec = findSystemBinary("pkexec", env);
        if (!pkexec) {
            throw new Error(
                "Utilitário de elevação 'pkexec' (polkit) não encontrado no sistema. " +
                "Instale o pacote polkit para permitir operações de rede privilegiadas."
            );
        }
        cmdArgs = [cmdFile, ...cmdArgs];
        cmdFile = pkexec;
    }

    if (options.isFlatpakEnv) {
        const flatpakSpawn = findSystemBinary("flatpak-spawn", env);
        if (!flatpakSpawn) {
            throw new Error(
                "Ponte Flatpak ('flatpak-spawn') não encontrada. " +
                "Verifique se o Discord possui permissão de acesso ao host (flatpak override --user --talk-name=org.freedesktop.Flatpak <id>)."
            );
        }
        cmdArgs = ["--host", cmdFile, ...cmdArgs];
        cmdFile = flatpakSpawn;
    } else if (options.inNamespace) {
        const systemdRun = findSystemBinary("systemd-run", env);
        if (!systemdRun) {
            throw new Error(
                "Utilitário 'systemd-run' não encontrado para ponte de comunicação com o host a partir do namespace de rede."
            );
        }
        cmdArgs = ["--user", "--wait", "--pipe", cmdFile, ...cmdArgs];
        cmdFile = systemdRun;
    }

    return { file: cmdFile, args: cmdArgs };
}

interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

async function runCommandAsync(
    spec: CommandSpec,
    options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<CommandResult> {
    const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    let timer: NodeJS.Timeout | null = null;
    let killed = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(spec.file, spec.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });

    const cleanup = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (options?.signal) {
            options.signal.removeEventListener("abort", onAbort);
        }
    };

    const onAbort = () => {
        if (killed) return;
        killed = true;
        try {
            child.kill("SIGTERM");
        } catch {
            // ignore
        }
        setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch {
                // ignore
            }
        }, 1000).unref();
        cleanup();
        reject(new Error("Operação cancelada pelo usuário ou sinal de aborto."));
    };

    if (options?.signal) {
        if (options.signal.aborted) {
            onAbort();
            return promise;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeoutMs > 0) {
        timer = setTimeout(() => {
            if (killed) return;
            killed = true;
            try {
                child.kill("SIGTERM");
            } catch {
                // ignore
            }
            setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                } catch {
                    // ignore
                }
            }, 1000).unref();
            cleanup();
            reject(new Error(`Comando expirou após ${timeoutMs}ms: ${spec.file}`));
        }, timeoutMs);
    }

    child.stdout?.on("data", chunk => {
        if (stdout.length < MAX_COMMAND_OUTPUT_BYTES) {
            stdout += chunk.toString("utf8");
        }
    });

    child.stderr?.on("data", chunk => {
        if (stderr.length < MAX_COMMAND_OUTPUT_BYTES) {
            stderr += chunk.toString("utf8");
        }
    });

    child.on("error", error => {
        cleanup();
        reject(error);
    });

    child.on("close", (code, sig) => {
        cleanup();
        resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: code,
            signal: sig,
        });
    });

    return promise;
}

async function execPrivileged(
    binary: string,
    args: string[],
    options?: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
): Promise<CommandResult> {
    const env = options?.env || process.env;
    const isFlatpakEnv = isFlatpak(env);
    const inNamespace = isProcessInNamespace(undefined, env);
    const spec = resolveCommandInvocation(binary, args, {
        elevated: true,
        inNamespace,
        isFlatpakEnv,
        env,
    });
    const result = await runCommandAsync(spec, options);
    if (result.exitCode !== 0) {
        const detail = safeDiagnosticDetail(result.stderr || result.stdout || `Exit code ${result.exitCode}`);
        throw new Error(`Falha ao executar ${path.basename(binary)}: ${detail}`);
    }
    return result;
}
class LinuxAuthorizationError extends Error {
    constructor(message: string, readonly exitCode: number | null) {
        super(message);
        this.name = "LinuxAuthorizationError";
    }
}

async function runAuthorizationCommand(
    spec: CommandSpec,
    options: { timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
    const result = await runCommandAsync(spec, options);
    if (result.exitCode !== 0) {
        const detail = safeDiagnosticDetail(result.stderr || result.stdout || `Exit code ${result.exitCode}`);
        throw new LinuxAuthorizationError(`Falha ao executar ${path.basename(spec.file)}: ${detail}`, result.exitCode);
    }
}

function classifyLinuxAuthorizationError(error: unknown): LinuxAuthorizationCode {
    const detail = safeDiagnosticDetail(error);
    const exitCode = error instanceof LinuxAuthorizationError ? error.exitCode : null;
    if (exitCode === 126) return "CANCELLED";
    if (/expirou após|expired|timed out|timeout/i.test(detail)) return "TIMEOUT";
    if (/cancel|cancelad|dismiss|interromp|aborted/i.test(detail)) return "CANCELLED";
    return "FAILED";
}

function shouldUseTerminalAuthorizationFallback(error: unknown): boolean {
    const detail = safeDiagnosticDetail(error);
    return /textual authentication agent|current controlling terminal|no such device or address|no authentication agent|authentication agent.*(?:not found|unavailable)/i.test(detail);
}

const AUTHORIZATION_TERMINAL_TITLE = "GoLiveBypass — autorização do sistema";
const AUTHORIZATION_TERMINALS = ["alacritty", "foot", "kitty", "xterm", "gnome-terminal", "konsole"] as const;

function resolveTerminalAuthorizationSpec(pkexec: string, truePath: string, env: NodeJS.ProcessEnv): CommandSpec | null {
    for (const name of AUTHORIZATION_TERMINALS) {
        const terminal = findSystemBinary(name, env);
        if (!terminal) continue;

        const terminalArgs = name === "alacritty"
            ? ["--title", AUTHORIZATION_TERMINAL_TITLE, "--command", pkexec, truePath]
            : name === "foot"
                ? [`--title=${AUTHORIZATION_TERMINAL_TITLE}`, pkexec, truePath]
                : name === "kitty"
                    ? ["--title", AUTHORIZATION_TERMINAL_TITLE, pkexec, truePath]
                    : name === "xterm"
                        ? ["-T", AUTHORIZATION_TERMINAL_TITLE, "-e", pkexec, truePath]
                        : name === "gnome-terminal"
                            ? ["--wait", `--title=${AUTHORIZATION_TERMINAL_TITLE}`, "--", pkexec, truePath]
                            : ["--wait", "--title", AUTHORIZATION_TERMINAL_TITLE, "-e", pkexec, truePath];

        if (!isFlatpak(env)) return { file: terminal, args: terminalArgs };
        const flatpakSpawn = findSystemBinary("flatpak-spawn", env);
        if (flatpakSpawn) return { file: flatpakSpawn, args: ["--host", terminal, ...terminalArgs] };
    }
    return null;
}

export async function requestLinuxAuthorization(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
}): Promise<LinuxAuthorizationResult> {
    if (!isLinux()) {
        return { authorized: false, code: "FAILED", error: "A autorização administrativa Linux só pode ser solicitada no Linux." };
    }

    const env = options?.env || process.env;
    const pkexec = findSystemBinary("pkexec", env);
    if (!pkexec) {
        return { authorized: false, code: "FAILED", error: "Utilitário 'pkexec' (polkit) não encontrado no sistema." };
    }

    const truePath = findSystemBinary("true", env) || "/usr/bin/true";
    const timeoutMs = options?.timeoutMs ?? DEFAULT_AUTH_PROMPT_TIMEOUT_MS;
    const startedAt = Date.now();
    const remainingTimeout = () => Math.max(1, timeoutMs - (Date.now() - startedAt));
    const failure = (error: unknown): LinuxAuthorizationResult => {
        const detail = safeDiagnosticDetail(error);
        const code = classifyLinuxAuthorizationError(error);
        const message = code === "TIMEOUT"
            ? "A autorização administrativa expirou. Tente ativar novamente."
            : code === "CANCELLED"
                ? "A autorização administrativa foi cancelada."
                : `Não foi possível obter autorização administrativa via polkit. ${detail}`;
        return { authorized: false, code, error: message };
    };
    const primarySpec = resolveCommandInvocation(truePath, [], {
        elevated: true,
        inNamespace: isProcessInNamespace(undefined, env),
        isFlatpakEnv: isFlatpak(env),
        env,
    });

    try {
        await runAuthorizationCommand(primarySpec, {
            timeoutMs: remainingTimeout(),
            signal: options?.signal,
        });
        return { authorized: true, code: "AUTHORIZED" };
    } catch (error) {
        if (options?.signal?.aborted || !shouldUseTerminalAuthorizationFallback(error)) return failure(error);

        const terminalSpec = resolveTerminalAuthorizationSpec(pkexec, truePath, env);
        if (!terminalSpec) {
            return {
                authorized: false,
                code: "FAILED",
                error: "Nenhum agente gráfico polkit ou terminal compatível está disponível para solicitar a senha do sistema.",
            };
        }

        try {
            await runAuthorizationCommand(terminalSpec, {
                timeoutMs: remainingTimeout(),
                signal: options?.signal,
            });
            return { authorized: true, code: "AUTHORIZED" };
        } catch (fallbackError) {
            return failure(fallbackError);
        }
    }
}

export function linuxDependencyIssues(env: NodeJS.ProcessEnv = process.env): string[] {
    if (!isLinux()) {
        return ["GoLiveBypass no Linux é suportado apenas em ambientes Linux."];
    }
    const issues: string[] = [];
    const hasIp = Boolean(findSystemBinary("ip", env));
    const hasWg = Boolean(findSystemBinary("wg", env));
    const hasPkexec = Boolean(findSystemBinary("pkexec", env));
    const isFlat = isFlatpak(env);
    const inNs = isProcessInNamespace(undefined, env);

    if (!hasIp) {
        issues.push("Utilitário 'ip' (iproute2) não encontrado. Instale o pacote iproute2 no sistema.");
    }
    if (!hasWg) {
        issues.push("Utilitário 'wg' (wireguard-tools) não encontrado. Instale o pacote wireguard-tools no sistema.");
    }
    if (!hasPkexec) {
        issues.push("Utilitário 'pkexec' (polkit) não encontrado. Instale o pacote polkit para autorização administrativa.");
    }
    if (isFlat) {
        const hasFlatpakSpawn = Boolean(findSystemBinary("flatpak-spawn", env));
        if (!hasFlatpakSpawn) {
            issues.push("Ponte Flatpak ('flatpak-spawn') não encontrada. Verifique se o Discord possui permissão de host.");
        }
    } else if (inNs) {
        const hasSystemdRun = Boolean(findSystemBinary("systemd-run", env));
        if (!hasSystemdRun) {
            issues.push("Utilitário 'systemd-run' não encontrado para ponte de comunicação com o host a partir do namespace.");
        }
    }
    return issues;
}

export const linuxDependenciesSync = linuxDependencyIssues;

export async function linuxDependencyStatus(
    prompt = false,
    options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }
): Promise<LinuxDependencyStatus> {
    const env = options?.env || process.env;
    const isLinuxEnv = isLinux();
    const isFlat = isFlatpak(env);
    const inNs = isProcessInNamespace(undefined, env);

    const ipPath = findSystemBinary("ip", env);
    const wgPath = findSystemBinary("wg", env);
    const pkexecPath = findSystemBinary("pkexec", env);
    const systemdRunPath = findSystemBinary("systemd-run", env);
    const flatpakSpawnPath = findSystemBinary("flatpak-spawn", env);
    const installPath = findSystemBinary("install", env);
    const mkdirPath = findSystemBinary("mkdir", env);
    const rmPath = findSystemBinary("rm", env);

    const hasIp = Boolean(ipPath);
    const hasWg = Boolean(wgPath);
    const hasPkexec = Boolean(pkexecPath);
    const hasFlatpakSpawn = Boolean(flatpakSpawnPath);
    const hasSystemdRun = Boolean(systemdRunPath);

    const issues = linuxDependencyIssues(env);
    const missing: string[] = [];
    if (!hasIp) missing.push("ip");
    if (!hasWg) missing.push("wg");
    if (!hasPkexec) missing.push("pkexec");
    if (isFlat && !hasFlatpakSpawn) missing.push("flatpak-spawn");
    if (!isFlat && inNs && !hasSystemdRun) missing.push("systemd-run");

    let elevationOk = hasPkexec;
    let authError: string | undefined;

    if (prompt && hasPkexec && isLinuxEnv) {
        const authorization = await requestLinuxAuthorization({
            timeoutMs: options?.timeoutMs ?? DEFAULT_AUTH_PROMPT_TIMEOUT_MS,
            env,
        });
        elevationOk = authorization.authorized;
        if (!authorization.authorized) {
            authError = authorization.error;
            issues.push(`Autorização administrativa (pkexec) falhou: ${authError}`);
        }
    }

    const ok = isLinuxEnv && missing.length === 0 && elevationOk;
    const error = issues.length > 0 ? issues[0] : undefined;

    return {
        ok,
        elevationOk,
        hasIp,
        hasWg,
        hasPkexec,
        hasFlatpakSpawn,
        hasSystemdRun,
        isFlatpak: isFlat,
        inNamespace: inNs,
        issues,
        missing,
        error,
        paths: {
            ip: ipPath,
            wg: wgPath,
            pkexec: pkexecPath,
            systemdRun: systemdRunPath,
            flatpakSpawn: flatpakSpawnPath,
            install: installPath,
            mkdir: mkdirPath,
            rm: rmPath,
        },
    };
}

export const checkLinuxDependencies = linuxDependencyStatus;

const CANONICAL_INTERFACE_KEYS: Record<string, string> = Object.freeze({
    privatekey: "PrivateKey",
    listenport: "ListenPort",
    fwmark: "FwMark",
});

const CANONICAL_PEER_KEYS: Record<string, string> = Object.freeze({
    publickey: "PublicKey",
    presharedkey: "PresharedKey",
    allowedips: "AllowedIPs",
    endpoint: "Endpoint",
    persistentkeepalive: "PersistentKeepalive",
});

export function parseWireGuardAddresses(rawConfig: string): string[] {
    if (!rawConfig || typeof rawConfig !== "string") {
        throw new Error("A configuração WireGuard está vazia.");
    }
    const addresses: string[] = [];
    let currentSection = "";

    for (const rawLine of rawConfig.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith(";")) continue;
        const header = /^\[([^\]]+)\]$/.exec(line);
        if (header) {
            currentSection = header[1].trim().toLowerCase();
            continue;
        }
        if (currentSection !== "interface") continue;

        const match = /^Address\s*=\s*(.+)$/i.exec(line);
        if (!match) continue;

        const parts = match[1].split(",");
        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const slashIdx = trimmed.indexOf("/");
            let ipStr = trimmed;
            let prefix: number;

            if (slashIdx === -1) {
                const ver = net.isIP(ipStr);
                if (ver === 4) prefix = 32;
                else if (ver === 6) prefix = 128;
                else throw new Error(`Endereço IP inválido na configuração WireGuard: '${trimmed}'`);
            } else {
                ipStr = trimmed.slice(0, slashIdx).trim();
                const prefixStr = trimmed.slice(slashIdx + 1).trim();
                prefix = Number(prefixStr);
                const ver = net.isIP(ipStr);
                if (!Number.isInteger(prefix) || prefix < 0) {
                    throw new Error(`Prefixo CIDR inválido na configuração WireGuard: '${trimmed}'`);
                }
                if (ver === 4 && prefix > 32) {
                    throw new Error(`Prefixo IPv4 excede /32 na configuração WireGuard: '${trimmed}'`);
                }
                if (ver === 6 && prefix > 128) {
                    throw new Error(`Prefixo IPv6 excede /128 na configuração WireGuard: '${trimmed}'`);
                }
                if (ver === 0) {
                    throw new Error(`Endereço IP inválido na configuração WireGuard: '${trimmed}'`);
                }
            }
            addresses.push(`${ipStr}/${prefix}`);
        }
    }

    if (addresses.length === 0) {
        throw new Error("Nenhum endereço (Address) válido encontrado na seção [Interface] da configuração WireGuard.");
    }
    return addresses;
}

export function parseWireGuardDns(rawConfig: string): string[] {
    if (!rawConfig || typeof rawConfig !== "string") return [];
    const dnsSet = new Set<string>();
    let currentSection = "";

    for (const rawLine of rawConfig.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith(";")) continue;
        const header = /^\[([^\]]+)\]$/.exec(line);
        if (header) {
            currentSection = header[1].trim().toLowerCase();
            continue;
        }
        if (currentSection !== "interface") continue;

        const match = /^DNS\s*=\s*(.+)$/i.exec(line);
        if (!match) continue;

        const parts = match[1].split(/[,\s]+/);
        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const ver = net.isIP(trimmed);
            if (ver === 4 || ver === 6) {
                dnsSet.add(trimmed);
            } else {
                throw new Error(`Servidor DNS inválido na configuração WireGuard: '${trimmed}'`);
            }
        }
    }
    return Array.from(dnsSet);
}

export function buildWireGuardSetconf(rawConfig: string): string {
    if (!rawConfig || typeof rawConfig !== "string" || !rawConfig.trim()) {
        throw new Error("A configuração WireGuard está vazia.");
    }

    let currentSection = "";
    let privateKey: string | null = null;
    const interfaceEntries: Array<{ key: string; value: string }> = [];
    const peers: Array<Array<{ key: string; value: string }>> = [];
    let currentPeer: Array<{ key: string; value: string }> | null = null;

    for (const rawLine of rawConfig.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith(";")) continue;

        if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(line)) {
            throw new Error("Caractere de controle inválido detectado na configuração WireGuard.");
        }

        const header = /^\[([^\]]+)\]$/.exec(line);
        if (header) {
            const sectionName = header[1].trim().toLowerCase();
            if (sectionName === "interface") {
                currentSection = "interface";
                currentPeer = null;
            } else if (sectionName === "peer") {
                currentSection = "peer";
                currentPeer = [];
                peers.push(currentPeer);
            } else {
                currentSection = "";
                currentPeer = null;
            }
            continue;
        }

        const match = /^([a-zA-Z0-9_-]+)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;
        const key = match[1].trim();
        const value = match[2].trim();
        const lowerKey = key.toLowerCase();

        if (currentSection === "interface") {
            if (lowerKey === "privatekey") {
                if (!isValidWireGuardKey(value)) {
                    throw new Error("PrivateKey inválida na configuração WireGuard: esperada chave Base64 de 32 bytes.");
                }
                privateKey = value;
                interfaceEntries.push({ key: "PrivateKey", value });
            } else if (lowerKey in CANONICAL_INTERFACE_KEYS) {
                interfaceEntries.push({ key: CANONICAL_INTERFACE_KEYS[lowerKey], value });
            }
        } else if (currentSection === "peer" && currentPeer) {
            if (lowerKey === "publickey") {
                if (!isValidWireGuardKey(value)) {
                    throw new Error("PublicKey inválida na configuração WireGuard: esperada chave Base64 de 32 bytes.");
                }
                currentPeer.push({ key: "PublicKey", value });
            } else if (lowerKey === "endpoint") {
                const endpointMatch = /^(?:[^\s:[\]]+|\[[^\]]+\]):(\d{1,5})$/.exec(value);
                if (!endpointMatch || Number(endpointMatch[1]) < 1 || Number(endpointMatch[1]) > 65535) {
                    throw new Error(`Endpoint inválido na configuração WireGuard: '${value}'`);
                }
                currentPeer.push({ key: "Endpoint", value });
            } else if (lowerKey in CANONICAL_PEER_KEYS) {
                currentPeer.push({ key: CANONICAL_PEER_KEYS[lowerKey], value });
            }
        }
    }

    if (!privateKey) {
        throw new Error("A configuração WireGuard não contém uma PrivateKey válida na seção [Interface].");
    }
    if (peers.length === 0 || !peers.some(p => p.some(entry => entry.key === "PublicKey"))) {
        throw new Error("A configuração WireGuard não contém ao menos uma seção [Peer] com PublicKey válida.");
    }

    const output: string[] = ["[Interface]"];
    for (const entry of interfaceEntries) {
        output.push(`${entry.key} = ${entry.value}`);
    }
    for (const peer of peers) {
        output.push("");
        output.push("[Peer]");
        for (const entry of peer) {
            output.push(`${entry.key} = ${entry.value}`);
        }
    }
    output.push("");
    return output.join("\n");
}

export const formatLinuxConfig = buildWireGuardSetconf;

export function inspectLinuxNetworkSync(
    owner?: Pick<VpnOwnerRecord, "namespace" | "interfaceName"> | LinuxNetworkOwner | null
): LinuxNetworkInspection {
    if (!isLinux()) {
        return {
            active: false,
            owned: false,
            reliable: true,
            namespace: null,
            interfaceName: null,
            namespaceExists: false,
            interfaceExists: false,
            externalConflict: false,
            reason: null,
        };
    }

    const ownerNamespace = typeof owner?.namespace === "string" && owner.namespace.trim() ? owner.namespace.trim() : null;
    const ownerInterface = typeof owner?.interfaceName === "string" && owner.interfaceName.trim() ? owner.interfaceName.trim() : null;

    let knownNetns: string[] = [];
    let netnsInspectionReliable = true;
    try {
        const netnsDir = "/run/netns";
        if (fs.existsSync(netnsDir)) {
            knownNetns = fs.readdirSync(netnsDir);
        }
    } catch {
        netnsInspectionReliable = false;
    }

    let hostInterfaces: string[] = [];
    let hostInterfacesReliable = true;
    try {
        const netDir = "/sys/class/net";
        if (fs.existsSync(netDir)) {
            hostInterfaces = fs.readdirSync(netDir);
        }
    } catch {
        hostInterfacesReliable = false;
    }

    const reliable = netnsInspectionReliable && hostInterfacesReliable;
    if (!reliable) {
        return {
            active: false,
            owned: false,
            reliable: false,
            namespace: ownerNamespace,
            interfaceName: ownerInterface,
            namespaceExists: false,
            interfaceExists: false,
            externalConflict: false,
            reason: "Não foi possível inspecionar o estado da rede Linux; estado desconhecido.",
        };
    }

    const hasExternalInterface = hostInterfaces.some(ifName => isProtectedLinuxName(ifName));
    const hasExternalNetns = knownNetns.some(nsName => isProtectedLinuxName(nsName));
    const externalConflict = hasExternalInterface || hasExternalNetns;

    const namespaceExists = Boolean(ownerNamespace && knownNetns.includes(ownerNamespace));
    let interfaceExists = Boolean(ownerInterface && hostInterfaces.includes(ownerInterface));

    if (!interfaceExists && namespaceExists && ownerInterface && ownerNamespace) {
        const ipPath = findSystemBinary("ip");
        if (ipPath) {
            try {
                execFileSync(ipPath, ["-n", ownerNamespace, "link", "show", ownerInterface], {
                    stdio: ["ignore", "pipe", "ignore"],
                    timeout: 2000,
                });
                interfaceExists = true;
            } catch {
                // A normal user cannot always enter a root-owned namespace
                // just to inspect its links. The owner namespace/name remains
                // the authoritative contract for an already-adopted session.
            }
        }
    }

    // The WireGuard link moves out of /sys/class/net when it enters the
    // namespace. A matching owner namespace plus interface name therefore
    // proves the plugin resource even when an unprivileged inspection cannot
    // enter the namespace to enumerate the link.
    const ownerResourceActive = Boolean(ownerNamespace && ownerInterface && namespaceExists);

    if (externalConflict) {
        return {
            active: true,
            owned: ownerResourceActive,
            reliable: true,
            namespace: ownerNamespace,
            interfaceName: ownerInterface,
            namespaceExists,
            interfaceExists: interfaceExists || ownerResourceActive,
            externalConflict: true,
            reason: "Interface ou namespace externo 'discord-vpn' / 'wg-discord' detectado. Desative a VPN externa antes de iniciar a VPN do plugin.",
        };
    }

    const active = namespaceExists || interfaceExists;

    if (!active) {
        const orphaned = knownNetns.find(name => name.startsWith("gl-ns-"));
        if (orphaned) {
            return {
                active: true,
                owned: false,
                reliable: true,
                namespace: orphaned,
                interfaceName: null,
                namespaceExists: true,
                interfaceExists: false,
                externalConflict: false,
                reason: `Namespace residual do GoLiveBypass detectado ('${orphaned}'). Limpeza necessária.`,
            };
        }

        return {
            active: false,
            owned: false,
            reliable: true,
            namespace: ownerNamespace,
            interfaceName: ownerInterface,
            namespaceExists: false,
            interfaceExists: false,
            externalConflict: false,
            reason: null,
        };
    }

    return {
        active,
        owned: ownerResourceActive,
        reliable: true,
        namespace: ownerNamespace,
        interfaceName: ownerInterface,
        namespaceExists,
        interfaceExists: interfaceExists || ownerResourceActive,
        externalConflict: false,
        reason: ownerResourceActive ? null : "Recursos de rede Linux ativos encontrados sem owner correspondente.",
    };
}

export async function startLinuxNetwork(
    owner: LinuxNetworkOwner,
    rawConfig: string,
    dataDir: string,
    options?: LinuxStartOptions
): Promise<void> {
    if (!isLinux()) {
        throw new Error("Backend Linux só pode ser executado em sistemas Linux.");
    }

    const ipPath = findSystemBinary("ip");
    if (!ipPath) {
        throw new Error("Utilitário 'ip' (iproute2) não encontrado. Instale o pacote iproute2.");
    }
    const wgPath = findSystemBinary("wg");
    if (!wgPath) {
        throw new Error("Utilitário 'wg' (wireguard-tools) não encontrado. Instale o pacote wireguard-tools.");
    }
    const installPath = findSystemBinary("install");
    const mkdirPath = findSystemBinary("mkdir");

    const addresses = parseWireGuardAddresses(rawConfig);
    const dnsServers = parseWireGuardDns(rawConfig);
    const setconfContent = buildWireGuardSetconf(rawConfig);

    const randomSuffix = randomUUID().replace(/-/g, "");
    const namespace = options?.namespace || `gl-ns-${randomSuffix.slice(0, 10)}`;
    const interfaceName = options?.interfaceName || `gl-wg-${randomSuffix.slice(0, 8)}`;

    if (!isValidLinuxName(namespace, MAX_LINUX_NAMESPACE_LEN) || isProtectedLinuxName(namespace)) {
        throw new Error(`Nome de namespace Linux inválido ou protegido: '${namespace}'`);
    }
    if (!isValidLinuxName(interfaceName, MAX_LINUX_INTERFACE_LEN) || isProtectedLinuxName(interfaceName)) {
        throw new Error(`Nome de interface Linux inválido ou protegido: '${interfaceName}'`);
    }

    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tempConfigFile = path.join(dataDir, `wg-${randomSuffix.slice(0, 8)}.tmp`);
    fs.writeFileSync(tempConfigFile, setconfContent, { mode: 0o600 });

    let tempResolvFile: string | null = null;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const signal = options?.signal;

    try {
        // 1. Criar network namespace
        await execPrivileged(ipPath, ["netns", "add", namespace], { timeoutMs, signal });

        // 2. Criar interface WireGuard no namespace host
        await execPrivileged(ipPath, ["link", "add", interfaceName, "type", "wireguard"], { timeoutMs, signal });

        // 3. Configurar WireGuard ainda no host (socket permanece vinculado ao host para alcançar endpoint)
        await execPrivileged(wgPath, ["setconf", interfaceName, tempConfigFile], { timeoutMs, signal });

        // 4. Mover interface WireGuard para o namespace dedicado
        await execPrivileged(ipPath, ["link", "set", interfaceName, "netns", namespace], { timeoutMs, signal });

        // 5. Subir loopback no namespace
        await execPrivileged(ipPath, ["-n", namespace, "link", "set", "lo", "up"], { timeoutMs, signal });

        // 6. Adicionar endereços IP à interface dentro do namespace
        for (const addr of addresses) {
            await execPrivileged(ipPath, ["-n", namespace, "addr", "add", addr, "dev", interfaceName], { timeoutMs, signal });
        }

        // 7. Subir a interface WireGuard no namespace
        await execPrivileged(ipPath, ["-n", namespace, "link", "set", interfaceName, "up"], { timeoutMs, signal });

        // 8. Configurar rotas padrão no namespace (nunca no host)
        const hasIPv4 = addresses.some(a => net.isIP(a.split("/")[0]) === 4);
        const hasIPv6 = addresses.some(a => net.isIP(a.split("/")[0]) === 6);

        if (hasIPv4) {
            await execPrivileged(ipPath, ["-n", namespace, "route", "add", "default", "dev", interfaceName], { timeoutMs, signal });
        }
        if (hasIPv6) {
            await execPrivileged(ipPath, ["-n", namespace, "-6", "route", "add", "default", "dev", interfaceName], { timeoutMs, signal });
        }

        // 9. Configurar DNS privado em /etc/netns/<ns>/resolv.conf se houver DNS
        if (dnsServers.length > 0) {
            if (!installPath || !mkdirPath) {
                throw new Error("Os utilitários 'install' e 'mkdir' são necessários para configurar o DNS privado do namespace Linux.");
            }
            const resolvLines = dnsServers.map(ip => `nameserver ${ip}\n`).join("");
            tempResolvFile = path.join(dataDir, `resolv-${randomSuffix.slice(0, 8)}.tmp`);
            fs.writeFileSync(tempResolvFile, resolvLines, { mode: 0o600 });
            const netnsDir = `/etc/netns/${namespace}`;
            await execPrivileged(mkdirPath, ["-p", netnsDir], { timeoutMs, signal });
            await execPrivileged(installPath, ["-m", "600", tempResolvFile, path.join(netnsDir, "resolv.conf")], { timeoutMs, signal });
        }

        owner.namespace = namespace;
        owner.interfaceName = interfaceName;
    } catch (error) {
        try {
            await stopLinuxNetwork({ namespace, interfaceName }, { timeoutMs: 5000 });
        } catch {
            // Manter erro original da inicialização
        }
        throw error;
    } finally {
        try {
            if (fs.existsSync(tempConfigFile)) {
                fs.unlinkSync(tempConfigFile);
            }
        } catch {
            // ignore
        }
        if (tempResolvFile) {
            try {
                if (fs.existsSync(tempResolvFile)) {
                    fs.unlinkSync(tempResolvFile);
                }
            } catch {
                // ignore
            }
        }
    }
}

export async function stopLinuxNetwork(
    owner?: Pick<VpnOwnerRecord, "namespace" | "interfaceName"> | LinuxNetworkOwner | null,
    options?: LinuxStopOptions
): Promise<LinuxNetworkCleanupResult> {
    if (!isLinux()) {
        return { stopped: true, namespaceRemoved: false, interfaceRemoved: false, dnsRemoved: false };
    }

    const namespace = typeof owner?.namespace === "string" && owner.namespace.trim() ? owner.namespace.trim() : null;
    const interfaceName = typeof owner?.interfaceName === "string" && owner.interfaceName.trim() ? owner.interfaceName.trim() : null;

    if (!namespace && !interfaceName) {
        return { stopped: true, namespaceRemoved: false, interfaceRemoved: false, dnsRemoved: false };
    }

    if (namespace && isProtectedLinuxName(namespace)) {
        throw new Error(`Recusando remover namespace externo protegido ('${namespace}').`);
    }
    if (interfaceName && isProtectedLinuxName(interfaceName)) {
        throw new Error(`Recusando remover interface externa protegida ('${interfaceName}').`);
    }

    if (namespace && !isValidLinuxName(namespace, MAX_LINUX_NAMESPACE_LEN)) {
        throw new Error(`Nome de namespace inválido para teardown: '${namespace}'.`);
    }
    if (interfaceName && !isValidLinuxName(interfaceName, MAX_LINUX_INTERFACE_LEN)) {
        throw new Error(`Nome de interface inválido para teardown: '${interfaceName}'.`);
    }

    const ipPath = findSystemBinary("ip");
    const rmPath = findSystemBinary("rm");
    const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const signal = options?.signal;

    let dnsRemoved = false;
    let interfaceRemoved = false;
    let namespaceRemoved = false;

    // 1. Remover /etc/netns/<ns>/resolv.conf e diretório
    if (namespace && rmPath) {
        try {
            const resolvPath = `/etc/netns/${namespace}/resolv.conf`;
            const netnsDir = `/etc/netns/${namespace}`;
            await execPrivileged(rmPath, ["-f", resolvPath], { timeoutMs, signal });
            await execPrivileged(rmPath, ["-rf", netnsDir], { timeoutMs, signal });
            dnsRemoved = true;
        } catch {
            // DNS pode não existir
        }
    }

    // 2. Remover interface se conhecida
    if (interfaceName && ipPath) {
        if (namespace) {
            try {
                await execPrivileged(ipPath, ["-n", namespace, "link", "del", interfaceName], { timeoutMs, signal });
                interfaceRemoved = true;
            } catch (err) {
                const msg = safeDiagnosticDetail(err);
                if (/Cannot find device|does not exist|No such device/i.test(msg)) {
                    interfaceRemoved = true;
                }
            }
        }
        try {
            await execPrivileged(ipPath, ["link", "del", interfaceName], { timeoutMs, signal });
            interfaceRemoved = true;
        } catch (err) {
            const msg = safeDiagnosticDetail(err);
            if (/Cannot find device|does not exist|No such device/i.test(msg)) {
                interfaceRemoved = true;
            }
        }
    }

    // 3. Remover namespace se conhecido
    if (namespace && ipPath) {
        try {
            await execPrivileged(ipPath, ["netns", "del", namespace], { timeoutMs, signal });
            namespaceRemoved = true;
        } catch (err) {
            const msg = safeDiagnosticDetail(err);
            if (/No such file or directory|does not exist|Cannot remove namespace file/i.test(msg)) {
                namespaceRemoved = true;
            } else {
                throw err;
            }
        }
    }

    // 4. Verificar se a remoção teve êxito
    const inspection = inspectLinuxNetworkSync(owner);
    if (namespace && inspection.namespaceExists) {
        throw new Error(`Falha ao remover namespace '${namespace}'; o namespace ainda existe no sistema.`);
    }
    if (interfaceName && inspection.interfaceExists) {
        throw new Error(`Falha ao remover interface '${interfaceName}'; a interface ainda existe no sistema.`);
    }

    return {
        stopped: true,
        namespaceRemoved,
        interfaceRemoved,
        dnsRemoved,
    };
}
