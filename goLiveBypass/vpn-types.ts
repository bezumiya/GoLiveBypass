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

/** Como o perfil ativo foi escolhido — o painel usa isto para não chamar de "manual" o que veio do botão. */
export type VpnRouteSource = "auto" | "manual" | "custom" | "imported";

/**
 * Identidade da rota que o perfil ativo usa. Existe para o painel conseguir mostrar
 * "ativa em X" mesmo quando o catálogo Proton não está carregado nesta sessão (o
 * catálogo depende da sessão/medição; o perfil ativo, não).
 */
export interface VpnRouteInfo {
    mode: VpnMode;
    /** Servidor Proton quando conhecido (ex.: "NL#2"); null em modo custom ou perfil anterior a este registro. */
    server: string | null;
    /** Endpoint WireGuard lido do próprio perfil ativo (host:porta). */
    endpoint: string | null;
    /** Quando este perfil foi aplicado (epoch ms); null quando só o registro antigo existe. */
    appliedAt: number | null;
    source: VpnRouteSource | null;
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
    /** Conflito Windows comprovadamente do GoLiveBypass; ativação explícita pode retomá-lo. */
    managedConflict?: boolean;
    externalReason: string | null;
    lastDiagnostic: VpnDiagnostic | null;
    message: string;
    sessionStorage?: ProtonSessionStorage;
    /** Rota do perfil ativo; null quando não há perfil gravado. */
    route?: VpnRouteInfo | null;
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

    const lines = raw.split(/\r?\n/)
        .filter(line => !/^\s*(?:#@ws:)?AllowedApps\s*=/i.test(line))
        .map(line => /^\s*DNS\s*=/i.test(line) ? "" : line);
    // O WireSock só lê AllowedApps dentro de [Peer]; em [Interface] a linha é ignorada e o
    // túnel vale para o computador inteiro. Vai no fim da primeira seção [Peer].
    const peer = lines.findIndex(line => /^\s*\[Peer\]\s*$/i.test(line));
    let end = peer < 0 ? -1 : lines.findIndex((line, i) => i > peer && /^\s*\[/.test(line));
    if (end < 0) end = lines.length;
    while (end - 1 > peer && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, `#@ws:AllowedApps = ${allowedApps}`);
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
    // Alguns provedores (Proton, entre outros) anunciam a rota padrão como as duas
    // metades 0.0.0.0/1 + 128.0.0.0/1 em vez de 0.0.0.0/0 — é a mesma rota.
    const hasDefaultV4 = allowedIps.includes("0.0.0.0/0")
        || (allowedIps.includes("0.0.0.0/1") && allowedIps.includes("128.0.0.0/1"));
    const hasDefaultV6 = allowedIps.includes("::/0")
        || (allowedIps.includes("::/1") && allowedIps.includes("8000::/1"));
    if (!hasDefaultV4 && !hasDefaultV6)
        return { valid: false, error: "A configuração precisa anunciar uma rota padrão em AllowedIPs: 0.0.0.0/0 (ou as metades 0.0.0.0/1 + 128.0.0.0/1) ou ::/0." };
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

/** Lê `Endpoint = host:porta` do perfil WireGuard, sem interpretar o resto do arquivo. */
export function readWireGuardEndpoint(raw: string): string | null {
    const endpoint = configValue(raw, "peer", "Endpoint");
    if (!endpoint) return null;
    const cleaned = endpoint.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 120);
    return cleaned || null;
}

/**
 * Texto curto da rota para a UI. Não promete localização geográfica: mostra o servidor
 * quando ele foi registrado e sempre o endpoint que está no perfil ativo.
 */
export function formatVpnRouteSummary(route: VpnRouteInfo | null | undefined): string | null {
    if (!route) return null;
    const parts: string[] = [];
    if (route.server) parts.push(route.server);
    else parts.push(route.mode === "custom" ? "arquivo .conf personalizado" : "perfil Proton");
    if (route.endpoint) parts.push(route.endpoint);
    return parts.join(" · ");
}

/**
 * Rótulo de "Estado da rota" a partir do estado real do túnel — antes ele vinha só do
 * fluxo de otimização e dizia "pronta para otimizar" com o túnel já ativo.
 */
export function vpnRouteStateLabel(input: {
    status: { state?: VpnState | string | null; active?: boolean } | null | undefined;
    optimizing: boolean;
    optimizationNotice: string;
}): string {
    if (input.optimizing) return "otimizando a rota automaticamente";
    const status = input.status;
    if (!status) return input.optimizationNotice;
    if (status.active || status.state === "active") return "ativa";
    switch (status.state) {
        case "authorizing": return "aguardando autorização";
        case "preparing": return "preparando o túnel";
        case "starting": return "iniciando o túnel";
        case "restart_pending": return "reinicie o Discord para concluir";
        case "stopping": return "desativando";
        case "blocked_external": return "bloqueada por outro WireSock ativo";
        case "dependency_missing": return "dependências do sistema ausentes";
        case "recovery_required": return "recuperação necessária";
        default: return input.optimizationNotice;
    }
}
