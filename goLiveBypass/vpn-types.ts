/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Contratos e regras sem efeitos colaterais do transporte VPN do plugin.
 *
 * Este arquivo deliberadamente não importa Electron, Vencord ou Node. Além de
 * deixar a parte mais sensível testável, isso evita que o estado do plugin seja
 * confundido com o estado da GUI ou do standalone.
 */

export const VPN_SCHEMA_VERSION = 1;
export const VPN_OWNER_KIND = "golivebypass-plugin-vpn";
export const VPN_SERVICE_NAMES = ["wiresock-client-service", "wiresock-pro-client-service"] as const;

export type VpnMode = "proton" | "custom";
export type VpnPlatform = "windows" | "linux" | "unsupported";
/**
 * Onde a sessão Proton fica: `safe-storage` (armazenamento seguro do sistema),
 * `file` (arquivo privado, como no Windows) ou `memory-only` (nada em disco: a
 * sessão vale só enquanto o Discord estiver aberto).
 */
export type ProtonSessionStorage = "safe-storage" | "file" | "memory-only";
export type VpnState =
    | "inactive"
    | "authorizing"
    | "preparing"
    | "starting"
    | "restart_pending"
    | "active"
    | "stopping"
    | "blocked_external"
    | "dependency_missing"
    | "recovery_required";

export function normalizeProtonUsername(value: string): string {
    return value.trim().replace(/@(protonmail\.com|proton\.me|pm\.me)$/i, "");
}

export function protonUsernamesMatch(expected: string, actual: string): boolean {
    return normalizeProtonUsername(expected).toLowerCase() === normalizeProtonUsername(actual).toLowerCase();
}

export interface VpnSettings {
    mode: VpnMode;
    customConfigPath: string;
    protonUsername: string;
    protonCountry: string;
    protonFreeOnly: boolean;
    protonAutoPing: boolean;
}

export interface VpnOwnerRecord {
    kind: typeof VPN_OWNER_KIND;
    pid: number;
    generation: number;
    profilePath: string;
    configPath: string;
    probePath?: string;
    namespace?: string;
    interfaceName?: string;
    restarting?: boolean;
    createdAt: number;
}

export interface VpnDiagnostic {
    at: string;
    kind: "wireguard" | "network" | "route" | "ownership" | "dependency";
    ok: boolean;
    detail: string;
}

export interface VpnStatus {
    state: VpnState;
    platform: VpnPlatform;
    architecture: string;
    owned: boolean;
    active: boolean;
    generation: number;
    discordPid: number | null;
    profilePath: string | null;
    configPath: string | null;
    namespace?: string | null;
    interfaceName?: string | null;
    requiresRelaunch?: boolean;
    dependencies?: string[];
    externalReason: string | null;
    lastDiagnostic: VpnDiagnostic | null;
    message: string;
    sessionStorage?: ProtonSessionStorage;
}

export type VpnOperationCode =
    | "AUTHORIZATION_CANCELLED"
    | "AUTHORIZATION_FAILED"
    | "AUTHORIZATION_TIMEOUT";

export interface VpnOperationResult {
    success: boolean;
    state: VpnState;
    code?: VpnOperationCode;
    message?: string;
    error?: string;
    /** Ativação automática do boot recusada de propósito: não é falha para o usuário. */
    suppressed?: boolean;
}

export interface WireGuardConfigValidation {
    valid: boolean;
    error?: string;
}

export const DEFAULT_VPN_SETTINGS: Readonly<VpnSettings> = Object.freeze({
    mode: "proton",
    customConfigPath: "",
    protonUsername: "",
    protonCountry: "",
    protonFreeOnly: true,
    protonAutoPing: true,
});

export function normalizeVpnSettings(raw: unknown): VpnSettings {
    const value = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const mode = value.mode === "custom" ? "custom" : "proton";
    const text = (key: string, max: number) => {
        const candidate = typeof value[key] === "string" ? value[key].trim() : "";
        return candidate.slice(0, max);
    };
    const country = text("protonCountry", 128)
        .split(",")
        .map(part => part.trim().toUpperCase())
        .filter(part => /^[A-Z]{2}$/.test(part))
        .join(",");

    return {
        mode,
        customConfigPath: text("customConfigPath", 2048),
        protonUsername: text("protonUsername", 320),
        protonCountry: country,
        protonFreeOnly: value.protonFreeOnly !== false,
        protonAutoPing: value.protonAutoPing !== false,
    };
}

export function formatAllowedApps(paths: string[]): string {
    const unique = new Map<string, string>();
    for (const raw of paths) {
        const value = raw.trim();
        if (!value) continue;
        if (/[\r\n,]/.test(value)) {
            throw new Error(`Caminho incompatível com AllowedApps: ${value.replace(/[\r\n]/g, " ")}`);
        }
        const key = value.toLowerCase();
        if (!unique.has(key)) unique.set(key, value);
    }
    if (unique.size === 0) throw new Error("Nenhum executável do Discord foi encontrado para o filtro WireSock.");
    return [...unique.values()].join(", ");
}

export function sanitizeWireGuardConfig(raw: string, allowedApps: string): string {
    if (!raw.trim()) throw new Error("A configuração WireGuard está vazia.");
    if (!allowedApps.trim()) throw new Error("AllowedApps não pode ficar vazio.");

    const lines = raw.split(/\r?\n/).map(line => {
        if (/^\s*DNS\s*=/i.test(line)) return "";
        if (/^\s*(?:#@ws:)?AllowedApps\s*=/i.test(line)) return `#@ws:AllowedApps = ${allowedApps}`;
        return line;
    });
    if (!lines.some(line => /^\s*#@ws:AllowedApps\s*=/i.test(line)))
        lines.push(`#@ws:AllowedApps = ${allowedApps}`);
    return lines.join("\r\n");
}

export function isValidWireGuardKey(value: string): boolean {
    const key = value.trim();
    return /^[A-Za-z0-9+/]{43}=$/.test(key);
}

function configValue(raw: string, section: string, key: string): string {
    let current = "";
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        const header = /^\[([^\]]+)\]$/.exec(trimmed);
        if (header) { current = header[1].trim().toLowerCase(); continue; }
        if (current !== section.toLowerCase()) continue;
        const match = new RegExp(`^${key}\\s*=\\s*(.+)$`, "i").exec(trimmed);
        if (match) return match[1].trim();
    }
    return "";
}

export function validateWireGuardConfig(raw: string): WireGuardConfigValidation {
    const text = raw.trim();
    if (!text) return { valid: false, error: "A configuração WireGuard está vazia." };
    if (!/^\s*\[Interface\]\s*$/im.test(text)) return { valid: false, error: "A configuração não contém a seção [Interface]." };
    if (!/^\s*\[Peer\]\s*$/im.test(text)) return { valid: false, error: "A configuração não contém a seção [Peer]." };
    const privateKey = configValue(text, "interface", "PrivateKey");
    if (!privateKey) return { valid: false, error: "A configuração não contém PrivateKey." };
    if (!isValidWireGuardKey(privateKey)) return { valid: false, error: "PrivateKey inválida: esperada uma chave WireGuard Base64 de 32 bytes." };
    if (!configValue(text, "interface", "Address")) return { valid: false, error: "A configuração não contém Address." };
    const publicKey = configValue(text, "peer", "PublicKey");
    if (!publicKey) return { valid: false, error: "A configuração não contém PublicKey." };
    if (!isValidWireGuardKey(publicKey)) return { valid: false, error: "PublicKey inválida: esperada uma chave WireGuard Base64 de 32 bytes." };
    const allowedIps = configValue(text, "peer", "AllowedIPs").split(",").map(value => value.trim());
    if (!allowedIps.includes("0.0.0.0/0") && !allowedIps.includes("::/0"))
        return { valid: false, error: "A configuração precisa anunciar uma rota padrão em AllowedIPs." };
    const endpoint = configValue(text, "peer", "Endpoint");
    const endpointMatch = /^(?:[^\s:[\]]+|\[[^\]]+\]):(\d{1,5})$/.exec(endpoint);
    if (!endpointMatch || Number(endpointMatch[1]) < 1 || Number(endpointMatch[1]) > 65535)
        return { valid: false, error: "A configuração não contém um Endpoint válido." };
    return { valid: true };
}

export function isSupportedWindowsArchitecture(platform: string, arch: string): boolean {
    return platform === "win32" && arch === "x64";
}

export function isSupportedLinuxArchitecture(platform: string, arch: string): boolean {
    return platform === "linux" && arch === "x64";
}

export function isSupportedVpnArchitecture(platform: string, arch: string): boolean {
    return isSupportedWindowsArchitecture(platform, arch) || isSupportedLinuxArchitecture(platform, arch);
}

export function safeDiagnosticDetail(value: unknown, max = 300): string {
    return String(value instanceof Error ? value.message : value ?? "")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/(PrivateKey\s*=\s*)\S+/gi, "$1<redacted>")
        .replace(/(password|token|secret|authorization)\s*[:=]\s*\S+/gi, "$1=<redacted>")
        .slice(0, max);
}
