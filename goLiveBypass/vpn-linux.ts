/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
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

// Explica falhas de elevação que o usuário pode resolver, em vez de devolver o texto cru do
// pkexec ("Error executing command as another user: Request dismissed", que não diz nada).
export function linuxAuthorizationGuidance(detail: string, filePath = ""): string | null {
    if (/Request dismissed|No authentication agent|no agent|not authorized|dismissed|authentication agent/i.test(detail)) {
        return "O polkit não conseguiu pedir autorização (diálogo recusado ou sem agente de autenticação). Instale ou inicie um agente do polkit (polkit-gnome, lxqt-policykit, kde-polkit ou o do seu ambiente) e tente de novo.";
    }
    if (/pkexec/i.test(filePath) && /expirou após \d+ms/i.test(detail)) {
        return "O pedido de autorização não foi respondido a tempo. Responda o diálogo do polkit (ou configure um agente de autenticação) e tente de novo.";
    }
    return null;
}

// Espera um arquivo aparecer (usado pela confirmação do relaunch). Devolve false no timeout.
export async function waitForFile(filePath: string, timeoutMs: number, pollMs = 100): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            if (fs.existsSync(filePath)) return true;
        } catch {
            // segue tentando: um erro de leitura agora não é motivo para desistir da confirmação
        }
        if (Date.now() >= deadline) return false;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, pollMs);
        await promise;
    }
}
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
    wireGuardModule: LinuxWireGuardModuleState;
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
        modprobe: string | null;
        pkexec: string | null;
        systemdRun: string | null;
        flatpakSpawn: string | null;
        install: string | null;
        mkdir: string | null;
        rm: string | null;
    };
}
export type LinuxAuthorizationCode = "AUTHORIZED" | "CANCELLED" | "TIMEOUT" | "FAILED";
export type LinuxWireGuardModuleState = "loaded" | "available" | "missing";

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
    // Só para testes: por padrão vem de linuxKernelHasIPv6().
    ipv6Available?: boolean;
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

// Binários que, no Flatpak, existem só no host e rodam por flatpak-spawn --host. O pkexec
// faltava aqui desde que a lista nasceu: no sandbox ele nunca era achado e o plugin ficava em
// dependency_missing ("pkexec não encontrado") mesmo com o polkit instalado no host.
const FLATPAK_HOST_BINARIES = new Set([
    "pkexec",
    "ip",
    "wg",
    "modprobe",
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
    if (isFlatpak(env) && FLATPAK_HOST_BINARIES.has(name)) return resolveFlatpakHostBinary(name, env);
    return null;
}

// O caminho do binário no HOST, visto de dentro do Flatpak. Assumir /usr/bin/<nome> falhava
// no Debian/Ubuntu, onde modprobe (e às vezes ip) ficam em /usr/sbin: o `flatpak-spawn --host
// /usr/bin/modprobe -n` dava erro, o módulo virava "missing" e o painel acusava "kernel sem
// módulos" com o WireGuard carregado. Pergunta ao host uma vez por binário (o painel consulta
// as dependências a cada poucos segundos) e só guarda respostas válidas.
const FLATPAK_HOST_LOOKUP_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const flatpakHostBinaryCache = new Map<string, string>();

export function resetFlatpakHostBinaryCache(): void {
    flatpakHostBinaryCache.clear();
}

export function parseFlatpakHostBinaryLookup(output: string): string | null {
    const candidate = output.trim().split("\n")[0]?.trim() ?? "";
    return path.isAbsolute(candidate) && !/[\0\r]/.test(candidate) ? candidate : null;
}

function resolveFlatpakHostBinary(name: string, env: NodeJS.ProcessEnv): string {
    const cached = flatpakHostBinaryCache.get(name);
    if (cached) return cached;
    // "flatpak-spawn" não está na lista do host: a busca acima o acha dentro do sandbox.
    const flatpakSpawn = findSystemBinary("flatpak-spawn", env);
    if (flatpakSpawn) {
        try {
            const output = execFileSync(flatpakSpawn, [
                "--host", "/bin/sh", "-c",
                `PATH="$PATH:${FLATPAK_HOST_LOOKUP_PATH}"; command -v -- "$1"`,
                "sh", name,
            ], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
            const resolved = parseFlatpakHostBinaryLookup(output);
            if (resolved) {
                flatpakHostBinaryCache.set(name, resolved);
                return resolved;
            }
        } catch {
            // Sem permissão de portal ou host lento: fica o palpite antigo, sem cache, e o
            // preflight continua apontando o erro do portal quando o comando rodar.
        }
    }
    return `/usr/bin/${name}`;
}

// Variáveis que, dentro do Flatpak, apontam para o sandbox (~/.var/app/<id>/..., /app/...).
// Repassadas ao `flatpak run` do HOST no relaunch, o XDG_DATA_HOME fazia o flatpak procurar a
// instalação e os overrides do usuário em ~/.var/app/<id>/data/flatpak: o cliente relançado
// perdia as permissões (pasta do Vencord, talk-name do flatpak-spawn) ou nem subia.
const FLATPAK_SANDBOX_ENV_KEYS = Object.freeze([
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_DIRS",
]);

// Ambiente do cliente relançado. Antes era uma lista fixa (DISPLAY, PATH, XDG_*...), e tudo o
// que o lançador da distro exporta ficava de fora. No NixOS o `vesktop` é um wrapper que exporta
// CHROME_DEVEL_SANDBOX e as variáveis do GTK/GSettings antes de executar o Electron "unwrapped":
// sem elas o Electron relançado morria com SIGILL logo no início (coredump de usuário), e o
// mesmo binário com o ambiente do processo abria normal. O ambiente do processo atual já é o
// que o lançador montou, então ele vai inteiro, menos:
//   - nomes com cara de segredo: as variáveis passam pela linha de comando do launcher e do
//     systemd-run, visível a outros usuários por um instante;
//   - a marca do namespace, que só o relaunch PARA DENTRO grava (o de saída não pode herdar);
//   - ELECTRON_RUN_AS_NODE, que transformaria o cliente em um node puro;
//   - valores com quebra de linha/NUL ou grandes demais, e nomes inválidos para o launcher.
// XAUTHORITY e DBUS_SESSION_BUS_ADDRESS têm "AUTH"/"SESSION" no nome mas são necessários.
const RELAUNCH_SECRET_NAME = /TOKEN|SECRET|PASSW(?:OR)?D|PASSPHRASE|CREDENTIAL|COOKIE|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY|SESSION_?KEY|AUTH_?(?:TOKEN|SOCK|INFO|KEY)|BEARER/i;
const RELAUNCH_DROPPED_NAMES = new Set([GOLIVE_PLUGIN_LINUX_NAMESPACE, "ELECTRON_RUN_AS_NODE", "_"]);
const RELAUNCH_MAX_VALUE = 32 * 1024;

export function relaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string" || value.length === 0 || value.length > RELAUNCH_MAX_VALUE) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\0\r\n]/.test(value)) continue;
        if (RELAUNCH_DROPPED_NAMES.has(key) || RELAUNCH_SECRET_NAME.test(key)) continue;
        result[key] = value;
    }
    return result;
}

// Caminhos que só existem dentro do sandbox. No E2E o DBUS_SESSION_BUS_ADDRESS do sandbox
// (unix:path=/run/flatpak/bus) fazia o zypak-helper do cliente relançado morrer sem barramento;
// PULSE_SERVER e XAUTHORITY também apontam para /run/flatpak/ e não valem no host.
const FLATPAK_SANDBOX_PATH = /(?:^|[=:\s'"])(?:\/run\/flatpak\/|\/app\/|[^\s:'"]*\/\.var\/app\/)/;

export function hostEnvironmentFromFlatpak(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const host: NodeJS.ProcessEnv = { ...env };
    for (const key of FLATPAK_SANDBOX_ENV_KEYS) delete host[key];
    for (const [key, value] of Object.entries(host)) {
        if (typeof value === "string" && FLATPAK_SANDBOX_PATH.test(value)) delete host[key];
    }
    // O barramento de sessão do host fica no mesmo XDG_RUNTIME_DIR (é o padrão do
    // systemd/dbus); sem endereço, o zypak do flatpak relançado não sobe.
    if (!host.DBUS_SESSION_BUS_ADDRESS && host.XDG_RUNTIME_DIR) {
        host.DBUS_SESSION_BUS_ADDRESS = `unix:path=${host.XDG_RUNTIME_DIR}/bus`;
    }
    // O PATH do sandbox (/app/bin:/usr/bin) não descreve o host.
    host.PATH = FLATPAK_HOST_LOOKUP_PATH;
    return host;
}

export function isLinux(platform: string = process.platform): boolean {
    return platform === "linux";
}

export function isFlatpak(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env.FLATPAK_ID || env.FLATPAK_SANDBOX_DIR || fs.existsSync("/.flatpak-info"));
}

// O nome do pacote muda de distribuição para distribuição: "polkit" existe no Fedora e no
// Arch, mas no Debian/Ubuntu o pacote se chama policykit-1 (que hoje entrega polkitd e pkexec
// separados). A mensagem genérica ("instale o pacote polkit") mandava o usuário do Ubuntu
// procurar um pacote que não existe e deixava o painel sem ação possível (relato com kernel
// 6.8.0-139-generic). Mesma ideia do linux_dependency_plan() do standalone, sem executar
// nada: lê /etc/os-release e escreve o comando que a pessoa consegue copiar.
export type LinuxDistroFamily = "debian" | "fedora" | "arch" | "unknown";

const LINUX_DISTRO_FAMILY_BY_ID: Record<string, LinuxDistroFamily> = {
    debian: "debian", ubuntu: "debian", linuxmint: "debian", pop: "debian", raspbian: "debian", kali: "debian",
    fedora: "fedora", rhel: "fedora", centos: "fedora", rocky: "fedora", almalinux: "fedora",
    arch: "arch", manjaro: "arch", endeavouros: "arch", cachyos: "arch", garuda: "arch",
};

export function identifyLinuxDistroFamily(osRelease?: string | null): LinuxDistroFamily {
    if (!osRelease) return "unknown";
    const fields = new Map<string, string>();
    for (const line of osRelease.split("\n")) {
        const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (match) fields.set(match[1], match[2].replace(/^"|"$/g, "").trim());
    }
    for (const token of [fields.get("ID") ?? "", ...(fields.get("ID_LIKE") ?? "").split(/\s+/)]) {
        const family = LINUX_DISTRO_FAMILY_BY_ID[token.toLowerCase()];
        if (family) return family;
    }
    return "unknown";
}

// /etc/os-release não muda durante a sessão; a leitura entra no cache como a do módulo
// WireGuard, porque o painel consulta as dependências a cada poucos segundos.
let linuxDistroFamilyCache: LinuxDistroFamily | null = null;

export function resetLinuxDistroFamilyCache(): void {
    linuxDistroFamilyCache = null;
}

export function linuxDistroFamily(): LinuxDistroFamily {
    if (linuxDistroFamilyCache) return linuxDistroFamilyCache;
    let raw: string | null = null;
    try {
        raw = fs.readFileSync("/etc/os-release", "utf8");
    } catch {
        // Container/sandbox sem os-release: fica a mensagem genérica.
        raw = null;
    }
    linuxDistroFamilyCache = identifyLinuxDistroFamily(raw);
    return linuxDistroFamilyCache;
}

// Comando copiavel para instalar o pkexec. Vazio quando a familia nao e conhecida: melhor nao
// mandar o usuario de uma distribuicao desconhecida rodar o gerenciador de pacotes errado.
export function polkitInstallCommand(family: LinuxDistroFamily): string {
    switch (family) {
        case "debian": return "sudo apt install policykit-1";
        case "fedora": return "sudo dnf install polkit";
        case "arch": return "sudo pacman -S polkit";
        default: return "";
    }
}

export function kernelModulesInstallCommand(family: LinuxDistroFamily, kernelRelease: string): string {
    // Só o Debian/Ubuntu empacota módulos por versão de kernel (linux-modules-<release>); nas
    // outras famílias eles vêm junto do kernel e a ação útil continua sendo reiniciar.
    if (family !== "debian") return "";
    const release = kernelRelease.trim();
    return `sudo apt install linux-modules-${release || "$(uname -r)"}`;
}

export function pkexecMissingIssue(family: LinuxDistroFamily = linuxDistroFamily()): string {
    const command = polkitInstallCommand(family);
    return command
        ? `Utilitário 'pkexec' (polkit) não encontrado. Instale o polkit (${command}) para autorização administrativa.`
        : "Utilitário 'pkexec' (polkit) não encontrado. Instale o pacote polkit da sua distribuição para autorização administrativa.";
}

export function formatLinuxWireGuardModuleIssue(
    state: LinuxWireGuardModuleState,
    kernelRelease: string,
    modulesDirectoryAvailable: boolean,
    family: LinuxDistroFamily = linuxDistroFamily(),
): string | null {
    if (state !== "missing") return null;
    const release = kernelRelease.trim() || "atual";
    if (!modulesDirectoryAvailable) {
        const base = `O kernel Linux em execução (${release}) não possui os módulos instalados. Reinicie no kernel instalado ou instale os módulos correspondentes antes de ativar.`;
        const command = kernelModulesInstallCommand(family, release);
        return command ? `${base} No Debian/Ubuntu: ${command} e reinicie.` : base;
    }
    return `O módulo WireGuard não está disponível no kernel Linux em execução (${release}). Instale ou ative o módulo WireGuard antes de ativar.`;
}

// O modulo WireGuard so muda de estado quando alguem roda modprobe, mas o painel consulta as
// dependencias a cada poucos segundos e cada consulta spawna `modprobe -n -v` DE FORMA SINCRONA
// na main thread do Electron (ate 2s de travamento por consulta, dentro do cliente). Por isso o
// resultado fica em cache curto e e invalidado quando uma ativacao roda modprobe de verdade.
const WIREGUARD_MODULE_CACHE_MS = 30_000;
const WIREGUARD_MODULE_PATH = "/sys/module/wireguard";

let wireGuardModuleCache: { key: string; state: LinuxWireGuardModuleState; at: number } | null = null;

export function resetLinuxWireGuardModuleCache(): void {
    wireGuardModuleCache = null;
}

export function wireGuardModuleLoadFailureMessage(): string {
    const release = os.release().trim() || "atual";
    return `O módulo WireGuard não carregou no kernel em execução (${release}). Ative ou instale o módulo (ex.: wireguard-dkms, ou o pacote de módulos do seu kernel) e tente de novo.`;
}

// Checagem que entra na MESMA sequencia elevada do modprobe: `modprobe` pode sair com 0 sem
// carregar nada (modulo de outro kernel, assinatura recusada, embutido sem suporte) e o erro
// que sobra e o `ip: Unknown device type`, que nao diz o que fazer (relato do beta-22 no Linux).
export function linuxWireGuardModuleCheckCommand(
    shellPath: string,
    modulePath: string = WIREGUARD_MODULE_PATH,
): LinuxPrivilegedCommand {
    return [
        shellPath,
        ["-c", `test -e ${shellQuote(modulePath)} || { printf '%s\\n' ${shellQuote(wireGuardModuleLoadFailureMessage())} >&2; exit 1; }`],
    ];
}

function detectLinuxWireGuardModuleState(env: NodeJS.ProcessEnv): LinuxWireGuardModuleState {
    if (fs.existsSync(WIREGUARD_MODULE_PATH)) return "loaded";

    const modprobe = findSystemBinary("modprobe", env);
    if (!modprobe) return "missing";
    try {
        if (isFlatpak(env)) {
            const flatpakSpawn = findSystemBinary("flatpak-spawn", env);
            if (!flatpakSpawn) return "missing";
            execFileSync(flatpakSpawn, ["--host", modprobe, "-n", "-v", "wireguard"], {
                stdio: "ignore",
                timeout: 2000,
            });
        } else {
            execFileSync(modprobe, ["-n", "-v", "wireguard"], {
                stdio: "ignore",
                timeout: 2000,
            });
        }
        return "available";
    } catch {
        return "missing";
    }
}

export function linuxWireGuardModuleState(env: NodeJS.ProcessEnv = process.env): LinuxWireGuardModuleState {
    if (!isLinux()) return "missing";

    const key = `${isFlatpak(env) ? "flatpak" : "host"}|${findSystemBinary("modprobe", env) ?? ""}`;
    const now = Date.now();
    const cached = wireGuardModuleCache;
    if (cached && cached.key === key && now - cached.at < WIREGUARD_MODULE_CACHE_MS) {
        return cached.state;
    }

    const state = detectLinuxWireGuardModuleState(env);
    wireGuardModuleCache = { key, state, at: now };
    return state;
}

// Com o IPv6 fora do kernel (`ipv6.disable=1` no boot, ou o módulo ipv6 bloqueado) a família
// IPv6 não é registrada: `ip addr add <ipv6>` e `ip -6 route` respondem "RTNETLINK answers:
// Operation not supported" e derrubavam a ativação inteira, embora o módulo WireGuard tivesse
// carregado (#404, reproduzido com ipv6.disable=1). O /proc/net/if_inet6 só existe quando a
// pilha IPv6 está no kernel; desligar só por sysctl (disable_ipv6) não o remove e não afeta o
// namespace novo do plugin.
const IPV6_PROC_PATH = "/proc/net/if_inet6";

export function linuxKernelHasIPv6(procPath: string = IPV6_PROC_PATH): boolean {
    return fs.existsSync(procPath);
}

export interface LinuxAddressPlan {
    addresses: string[];
    dnsServers: string[];
    skippedAddresses: string[];
    skippedDnsServers: string[];
}

// Sem IPv6 no kernel não existe tráfego IPv6 para escapar do túnel, então descartar o endereço,
// a rota e o DNS IPv6 do perfil não abre vazamento; o AllowedIPs `::/0` continua no peer (o
// `wg setconf` aceita mesmo sem IPv6). Um perfil só IPv6 não tem como funcionar e falha com a causa.
export function linuxAddressPlan(addresses: string[], dnsServers: string[], ipv6Available: boolean): LinuxAddressPlan {
    if (ipv6Available) return { addresses, dnsServers, skippedAddresses: [], skippedDnsServers: [] };
    const isIPv6 = (value: string) => net.isIP(value.split("/")[0]) === 6;
    const kept = addresses.filter(address => !isIPv6(address));
    if (kept.length === 0) {
        throw new Error("O perfil WireGuard só tem endereço IPv6, mas o IPv6 está desligado no kernel (ex.: ipv6.disable=1). Use um perfil com endereço IPv4 ou reative o IPv6.");
    }
    return {
        addresses: kept,
        dnsServers: dnsServers.filter(server => !isIPv6(server)),
        skippedAddresses: addresses.filter(isIPv6),
        skippedDnsServers: dnsServers.filter(isIPv6),
    };
}

export function linuxWireGuardModuleIssue(env: NodeJS.ProcessEnv = process.env): string | null {
    if (!isLinux()) return null;
    const release = os.release().trim() || "atual";
    const state = linuxWireGuardModuleState(env);
    const modulesDirectoryAvailable = fs.existsSync(`/lib/modules/${release}`)
        || fs.existsSync(`/usr/lib/modules/${release}`);
    return formatLinuxWireGuardModuleIssue(state, release, modulesDirectoryAvailable);
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

// Namespaces de rede nomeados do HOST (nome -> inode do nsfs). O /run/netns não existe dentro
// do sandbox do Flatpak: o cliente relançado estava no namespace e com o túnel funcionando, mas
// o plugin não via o próprio namespace, concluía "relaunch não confirmado" e ficava em
// recovery_required depois de toda ativação. O inode do nsfs é global no kernel, então
// compará-lo com /proc/self/ns/net vale dentro e fora do sandbox; no Flatpak a tabela vem do
// host numa chamada só, em cache curto (o painel consulta o status a cada poucos segundos).
export const NETNS_RUN_DIR = "/run/netns";
const FLATPAK_NETNS_CACHE_MS = 5000;
let flatpakNetnsCache: { at: number; table: LinuxNetnsTable } | null = null;

export interface LinuxNetnsTable {
    reliable: boolean;
    entries: Map<string, number>;
}

export function resetFlatpakNetnsCache(): void {
    flatpakNetnsCache = null;
}

export function parseHostNetnsListing(output: string): Map<string, number> {
    const entries = new Map<string, number>();
    for (const line of output.split("\n")) {
        const match = /^(\d+) ([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(line.trim());
        if (match) entries.set(match[2], Number(match[1]));
    }
    return entries;
}

export function readLinuxNetnsTable(env: NodeJS.ProcessEnv = process.env, netnsDir: string = NETNS_RUN_DIR): LinuxNetnsTable {
    if (fs.existsSync(netnsDir) || !isFlatpak(env)) {
        const entries = new Map<string, number>();
        try {
            if (fs.existsSync(netnsDir)) {
                for (const name of fs.readdirSync(netnsDir)) {
                    let inode = 0;
                    try { inode = fs.statSync(path.join(netnsDir, name)).ino; } catch { /* sem acesso: nome conta, inode não */ }
                    entries.set(name, inode);
                }
            }
            return { reliable: true, entries };
        } catch {
            return { reliable: false, entries };
        }
    }
    const now = Date.now();
    if (flatpakNetnsCache && now - flatpakNetnsCache.at < FLATPAK_NETNS_CACHE_MS) return flatpakNetnsCache.table;
    const flatpakSpawn = findSystemBinary("flatpak-spawn", env);
    if (flatpakSpawn) {
        try {
            const output = execFileSync(flatpakSpawn, [
                "--host", "/bin/sh", "-c",
                `for n in ${netnsDir}/*; do [ -e "$n" ] || continue; printf '%s %s\\n' "$(stat -L -c %i -- "$n")" "\${n##*/}"; done`,
            ], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
            const table = { reliable: true, entries: parseHostNetnsListing(output) };
            flatpakNetnsCache = { at: now, table };
            return table;
        } catch {
            // Sem portal (talk-name) ou host lento: mantém a leitura antiga (vazia) sem guardar,
            // para não trocar o dependency_missing de quem ainda não liberou o flatpak-spawn.
        }
    }
    return { reliable: true, entries: new Map() };
}

export function isProcessInNamespace(namespace?: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!isLinux()) return false;
    const envNamespace = typeof env[GOLIVE_PLUGIN_LINUX_NAMESPACE] === "string"
        ? env[GOLIVE_PLUGIN_LINUX_NAMESPACE]!.trim()
        : "";
    const targetNamespace = namespace?.trim() || envNamespace;
    if (!targetNamespace || (envNamespace && envNamespace !== targetNamespace)) return false;
    try {
        const selfNsPath = "/proc/self/ns/net";
        if (!fs.existsSync(selfNsPath)) return false;
        const inode = readLinuxNetnsTable(env).entries.get(targetNamespace);
        return typeof inode === "number" && inode > 0 && inode === fs.statSync(selfNsPath).ino;
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
            throw new Error(pkexecMissingIssue());
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

class LinuxAuthorizationError extends Error {
    constructor(message: string, readonly exitCode: number | null) {
        super(message);
        this.name = "LinuxAuthorizationError";
    }
}

export type LinuxPrivilegedCommand = readonly [file: string, args: readonly string[]];

// Falha de um passo identificado da sequência elevada; o `step` permite ao chamador saber se
// foi o modprobe/checagem do módulo ou um comando posterior.
export class LinuxPrivilegedStepError extends Error {
    constructor(message: string, readonly step: number) {
        super(message);
        this.name = "LinuxPrivilegedStepError";
    }
}

// O script escreve "__GOLIVE_STEP__<n>" antes de cada comando e, com `set -e`, para no que
// falhou: é o ÚLTIMO marcador que aponta o culpado. Pegar o primeiro culpava sempre o modprobe
// ou o `ip netns add` (#404: o erro real era o `ip addr add` IPv6, vários passos depois).
export function failedPrivilegedStep(stderr: string, commandCount: number): number {
    let step = -1;
    for (const match of stderr.matchAll(/__GOLIVE_STEP__(\d+)/g)) step = Number(match[1]);
    return Number.isInteger(step) && step >= 0 && step < commandCount ? step : -1;
}

// Nome curto para a mensagem ("ip addr add", "ip -6 route", "wg setconf"): só o binário dizia
// "ip" para uma dúzia de passos diferentes. Pula o `-n <namespace>` e para antes de caminhos e
// de argumentos com espaço (o script do `sh -c`), para não levar arquivo temporário ao log.
export function describeLinuxPrivilegedCommand(command: LinuxPrivilegedCommand): string {
    const args = [...command[1]];
    if (args[0] === "-n") args.splice(0, 2);
    const words: string[] = [];
    for (const arg of args) {
        if (words.length >= 2 || arg.startsWith("/") || /\s/.test(arg)) break;
        words.push(arg);
    }
    return [path.basename(command[0]), ...words].join(" ");
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function buildLinuxPrivilegedScript(
    commands: readonly LinuxPrivilegedCommand[],
    rollback: readonly LinuxPrivilegedCommand[] = [],
): string {
    if (commands.length === 0) throw new Error("Nenhum comando privilegiado foi informado.");
    const render = (command: LinuxPrivilegedCommand): string =>
        [command[0], ...command[1]].map(shellQuote).join(" ");
    const lines = ["set -e"];
    if (rollback.length > 0) {
        lines.push("cleanup() {");
        for (const command of rollback) {
            lines.push(`    ${render(command)} >/dev/null 2>&1 || true`);
        }
        lines.push("}");
        lines.push("trap cleanup 0");
        lines.push("trap 'cleanup; exit 143' HUP INT TERM");
    }
    commands.forEach((command, index) => {
        lines.push(`printf '%s\\n' ${shellQuote(`__GOLIVE_STEP__${index}`)} >&2`);
        lines.push(render(command));
    });
    if (rollback.length > 0) lines.push("trap - 0 HUP INT TERM");
    return `${lines.join("\n")}\n`;
}

// O timeout do pkexec não pode virar só "Comando expirou após 15000ms: /usr/bin/pkexec": quando
// o polkit está esperando o usuário (ou não tem agente), a mensagem precisa dizer o que fazer.
// Era esse texto cru que aparecia no relato #313 e no log local do E2E.
async function runPrivilegedCommand(
    spec: CommandSpec,
    options?: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
    try {
        return await runCommandAsync(spec, options);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const guidance = linuxAuthorizationGuidance(detail, spec.file);
        if (!guidance) throw error;
        throw new Error(`${detail} ${guidance}`);
    }
}

async function execPrivilegedSequence(
    commands: readonly LinuxPrivilegedCommand[],
    options?: {
        timeoutMs?: number;
        signal?: AbortSignal;
        env?: NodeJS.ProcessEnv;
        rollback?: readonly LinuxPrivilegedCommand[];
    },
): Promise<CommandResult> {
    const env = options?.env || process.env;
    const shellPath = findSystemBinary("sh", env) || "/bin/sh";
    const inNamespace = isProcessInNamespace(undefined, env);
    const script = buildLinuxPrivilegedScript(commands, options?.rollback);
    const spec = resolveCommandInvocation(shellPath, ["-c", script], {
        elevated: true,
        inNamespace,
        isFlatpakEnv: isFlatpak(env),
        env,
    });
    let result = await runPrivilegedCommand(spec, options).finally(resetFlatpakNetnsCache);
    const initialFailure = result.exitCode === null || result.exitCode === 0
        ? null
        : new LinuxAuthorizationError(
            safeDiagnosticDetail(result.stderr || result.stdout || `Exit code ${result.exitCode}`),
            result.exitCode,
        );
    if (initialFailure && shouldUseTerminalAuthorizationFallback(initialFailure)) {
        const pkexec = findSystemBinary("pkexec", env);
        const terminalSpec = pkexec
            ? resolveTerminalAuthorizationSpec(pkexec, shellPath, env, ["-c", script])
            : null;
        if (terminalSpec) result = await runPrivilegedCommand(terminalSpec, options).finally(resetFlatpakNetnsCache);
    }
    if (result.exitCode !== 0) {
        const step = failedPrivilegedStep(result.stderr, commands.length);
        const failedCommand = step >= 0 ? commands[step] : null;
        const detail = safeDiagnosticDetail(
            result.stderr.replace(/__GOLIVE_STEP__\d+/g, "").trim()
                || result.stdout
                || `Exit code ${result.exitCode}`,
        );
        const guidance = linuxAuthorizationGuidance(detail, spec.file);
        if (result.exitCode === 126) {
            throw new LinuxAuthorizationError(`A autorização administrativa foi cancelada.${guidance ? ` ${guidance}` : ""}`, result.exitCode);
        }
        throw new LinuxPrivilegedStepError(
            `Falha ao executar ${failedCommand ? describeLinuxPrivilegedCommand(failedCommand) : "comando privilegiado"}: ${detail}${guidance ? ` ${guidance}` : ""}`,
            step,
        );
    }
    return result;
}

export function linuxAuthorizationErrorCode(error: unknown): LinuxAuthorizationCode | null {
    return error instanceof LinuxAuthorizationError ? classifyLinuxAuthorizationError(error) : null;
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

function resolveTerminalAuthorizationSpec(
    pkexec: string,
    commandPath: string,
    env: NodeJS.ProcessEnv,
    commandArgs: string[] = [],
): CommandSpec | null {
    const elevatedArgs = [pkexec, commandPath, ...commandArgs];
    for (const name of AUTHORIZATION_TERMINALS) {
        const terminal = findSystemBinary(name, env);
        if (!terminal) continue;

        const terminalArgs = name === "alacritty"
            ? ["--title", AUTHORIZATION_TERMINAL_TITLE, "--command", ...elevatedArgs]
            : name === "foot"
                ? [`--title=${AUTHORIZATION_TERMINAL_TITLE}`, ...elevatedArgs]
                : name === "kitty"
                    ? ["--title", AUTHORIZATION_TERMINAL_TITLE, ...elevatedArgs]
                    : name === "xterm"
                        ? ["-T", AUTHORIZATION_TERMINAL_TITLE, "-e", ...elevatedArgs]
                        : name === "gnome-terminal"
                            ? ["--wait", `--title=${AUTHORIZATION_TERMINAL_TITLE}`, "--", ...elevatedArgs]
                            : ["--wait", "--title", AUTHORIZATION_TERMINAL_TITLE, "-e", ...elevatedArgs];

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
        issues.push(pkexecMissingIssue());
    }
    const moduleIssue = linuxWireGuardModuleIssue(env);
    if (moduleIssue) {
        issues.push(moduleIssue);
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
    const modprobePath = findSystemBinary("modprobe", env);
    const pkexecPath = findSystemBinary("pkexec", env);
    const systemdRunPath = findSystemBinary("systemd-run", env);
    const flatpakSpawnPath = findSystemBinary("flatpak-spawn", env);
    const installPath = findSystemBinary("install", env);
    const mkdirPath = findSystemBinary("mkdir", env);
    const rmPath = findSystemBinary("rm", env);

    const hasIp = Boolean(ipPath);
    const hasWg = Boolean(wgPath);
    const wireGuardModule = linuxWireGuardModuleState(env);
    const moduleIssue = linuxWireGuardModuleIssue(env);
    const hasPkexec = Boolean(pkexecPath);
    const hasFlatpakSpawn = Boolean(flatpakSpawnPath);
    const hasSystemdRun = Boolean(systemdRunPath);

    const issues = linuxDependencyIssues(env);
    const missing: string[] = [];
    if (!hasIp) missing.push("ip");
    if (!hasWg) missing.push("wg");
    if (moduleIssue) missing.push("wireguard-kernel-module");
    if (!hasPkexec) missing.push("pkexec");
    if (isFlat && !hasFlatpakSpawn) missing.push("flatpak-spawn");
    if (!isFlat && inNs && !hasSystemdRun) missing.push("systemd-run");

    let elevationOk = hasPkexec;
    let authError: string | undefined;

    if (prompt && hasPkexec && isLinuxEnv && !moduleIssue) {
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
        wireGuardModule,
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
            modprobe: modprobePath,
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

    // No Flatpak a lista vem do host (o /run/netns não existe no sandbox).
    const netnsTable = readLinuxNetnsTable();
    const knownNetns = [...netnsTable.entries.keys()];
    const netnsInspectionReliable = netnsTable.reliable;

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
    const modprobePath = findSystemBinary("modprobe");
    const moduleState = linuxWireGuardModuleState();
    const moduleIssue = linuxWireGuardModuleIssue();
    if (moduleIssue) throw new Error(moduleIssue);
    const installPath = findSystemBinary("install");
    const mkdirPath = findSystemBinary("mkdir");
    const rmPath = findSystemBinary("rm");

    const ipv6Available = options?.ipv6Available ?? linuxKernelHasIPv6();
    const { addresses, dnsServers, skippedAddresses, skippedDnsServers } = linuxAddressPlan(
        parseWireGuardAddresses(rawConfig),
        parseWireGuardDns(rawConfig),
        ipv6Available,
    );
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
    const timeoutMs = options?.timeoutMs ?? DEFAULT_AUTH_PROMPT_TIMEOUT_MS;
    const signal = options?.signal;

    options?.log?.("info", "linux.network.started", { phase: "preparing" });
    if (skippedAddresses.length > 0 || skippedDnsServers.length > 0) {
        options?.log?.("info", "linux.network.ipv6_unavailable", {
            skipped_addresses: skippedAddresses.length,
            skipped_dns: skippedDnsServers.length,
        });
    }
    try {
        const commands: LinuxPrivilegedCommand[] = [];
        if (moduleState === "available") {
            if (!modprobePath) throw new Error("Utilitário 'modprobe' não encontrado para carregar o módulo WireGuard.");
            commands.push([modprobePath, ["wireguard"]]);
            // Confirma a carga na MESMA sequência elevada: sem isto, o módulo não subir termina
            // no erro críptico do `ip` ("Unknown device type") em vez de dizer o que fazer.
            commands.push(linuxWireGuardModuleCheckCommand(findSystemBinary("sh") || "/bin/sh"));
        }
        const moduleStepCount = commands.length;

        // A sequência inteira roda sob uma única autorização; o rollback permanece dentro do
        // mesmo processo root para não abrir uma segunda janela de senha em caso de falha.
        commands.push(
            [ipPath, ["netns", "add", namespace]],
            [ipPath, ["link", "add", interfaceName, "type", "wireguard"]],
            [wgPath, ["setconf", interfaceName, tempConfigFile]],
            [ipPath, ["link", "set", interfaceName, "netns", namespace]],
            [ipPath, ["-n", namespace, "link", "set", "lo", "up"]],
        );
        for (const addr of addresses) {
            commands.push([ipPath, ["-n", namespace, "addr", "add", addr, "dev", interfaceName]]);
        }
        commands.push(
            [ipPath, ["-n", namespace, "link", "set", interfaceName, "up"]],
        );

        // Rotas padrão ficam exclusivamente dentro do namespace.
        const hasIPv4 = addresses.some(a => net.isIP(a.split("/")[0]) === 4);
        const hasIPv6 = addresses.some(a => net.isIP(a.split("/")[0]) === 6);
        if (hasIPv4) {
            commands.push([ipPath, ["-n", namespace, "route", "add", "default", "dev", interfaceName]]);
        }
        if (hasIPv6) {
            commands.push([ipPath, ["-n", namespace, "-6", "route", "add", "default", "dev", interfaceName]]);
        }

        if (dnsServers.length > 0) {
            if (!installPath || !mkdirPath || !rmPath) {
                throw new Error("Os utilitários 'install', 'mkdir' e 'rm' são necessários para configurar o DNS privado do namespace Linux.");
            }
            const resolvLines = dnsServers.map(ip => `nameserver ${ip}\n`).join("");
            tempResolvFile = path.join(dataDir, `resolv-${randomSuffix.slice(0, 8)}.tmp`);
            fs.writeFileSync(tempResolvFile, resolvLines, { mode: 0o600 });
            const netnsDir = `/etc/netns/${namespace}`;
            // 644 como qualquer /etc/resolv.conf: o netns-launcher monta este arquivo sobre o
            // /etc/resolv.conf do cliente relançado, que roda como o usuário. Com 600 (root) o
            // Discord não conseguia ler o próprio DNS e todo nome falhava (ERR_NAME_NOT_RESOLVED)
            // embora a rota pelo túnel funcionasse. O conteúdo é só a lista de servidores DNS.
            commands.push(
                [mkdirPath, ["-p", netnsDir]],
                [installPath, ["-m", "644", tempResolvFile, path.join(netnsDir, "resolv.conf")]],
            );
        }

        const rollback: LinuxPrivilegedCommand[] = [
            [ipPath, ["-n", namespace, "link", "del", interfaceName]],
            [ipPath, ["link", "del", interfaceName]],
            [ipPath, ["netns", "del", namespace]],
        ];
        if (tempResolvFile && rmPath) {
            rollback.unshift([rmPath, ["-rf", `/etc/netns/${namespace}`]]);
        }
        try {
            await execPrivilegedSequence(commands, { timeoutMs, signal, rollback });
        } catch (error) {
            // Depois de rodar modprobe, o "available" em cache ficou velho: a proxima consulta
            // (painel/watchdog) precisa ver o estado real.
            resetLinuxWireGuardModuleCache();
            // Só a falha do próprio modprobe/checagem vira "módulo não carregou". Antes, qualquer
            // erro com o módulo ainda descarregado virava essa mensagem, inclusive o prazo do
            // polkit estourando antes de o modprobe rodar (#404: 60.028 ms, exatamente o timeout),
            // e a orientação de responder o diálogo se perdia.
            const failedAtModuleStep = error instanceof LinuxPrivilegedStepError
                && error.step >= 0
                && error.step < moduleStepCount;
            if (failedAtModuleStep && linuxWireGuardModuleState() !== "loaded") {
                throw new Error(wireGuardModuleLoadFailureMessage());
            }
            throw error;
        }
        resetLinuxWireGuardModuleCache();
        options?.log?.("info", "linux.network.phase", { phase: "namespace" });
        options?.log?.("info", "linux.network.phase", { phase: "interface" });
        options?.log?.("info", "linux.network.phase", { phase: "routes" });

        owner.namespace = namespace;
        owner.interfaceName = interfaceName;
        options?.log?.("info", "linux.network.ready", { phase: "active" });
    } catch (error) {
        options?.log?.("error", "linux.network.failed", { phase: "failed", error: safeDiagnosticDetail(error, 300) });
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

// Comandos da limpeza, para uma única sequência elevada. O que pode já não existir (DNS,
// interface dentro ou fora do namespace) é tolerado; o namespace só falha se continuar lá.
export function linuxCleanupCommands(paths: {
    namespace: string | null;
    interfaceName: string | null;
    ipPath: string | null;
    rmPath: string | null;
    shellPath: string;
    netnsDir?: string;
}): LinuxPrivilegedCommand[] {
    const { namespace, interfaceName, ipPath, rmPath, shellPath } = paths;
    const netnsDir = paths.netnsDir ?? NETNS_RUN_DIR;
    const commands: LinuxPrivilegedCommand[] = [];
    if (namespace && rmPath) {
        commands.push([shellPath, ["-c", '"$0" -rf -- "$1" 2>/dev/null || true', rmPath, `/etc/netns/${namespace}`]]);
    }
    if (interfaceName && ipPath) {
        if (namespace) {
            commands.push([shellPath, ["-c", '"$0" -n "$1" link del "$2" 2>/dev/null || true', ipPath, namespace, interfaceName]]);
        }
        commands.push([shellPath, ["-c", '"$0" link del "$1" 2>/dev/null || true', ipPath, interfaceName]]);
    }
    if (namespace && ipPath) {
        commands.push([shellPath, ["-c", '"$0" netns del "$1" || [ ! -e "$2/$1" ]', ipPath, namespace, netnsDir]]);
    }
    return commands;
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
    options?.log?.("info", "linux.network.cleanup_started", { phase: "cleanup" });

    const ipPath = findSystemBinary("ip");
    const rmPath = findSystemBinary("rm");
    const shellPath = findSystemBinary("sh") || "/bin/sh";
    // Uma autorização só, como na ativação: o prazo inclui digitar a senha.
    const timeoutMs = options?.timeoutMs ?? DEFAULT_AUTH_PROMPT_TIMEOUT_MS;
    const signal = options?.signal;

    // Antes eram cinco pkexec, um por comando: cinco pedidos de senha para restaurar, e ao
    // fechar o Discord (NixOS, polkit sem auth_admin_keep) cada um voltava "Not authorized" e o
    // namespace ficava para trás. Agora vai tudo numa sequência elevada; o que pode não existir
    // é tolerado como antes, e a inspeção abaixo é quem decide se sobrou algo.
    const commands = linuxCleanupCommands({ namespace, interfaceName, ipPath, rmPath, shellPath });
    if (commands.length > 0) await execPrivilegedSequence(commands, { timeoutMs, signal });

    // Verificar se a remoção teve êxito
    const inspection = inspectLinuxNetworkSync(owner);
    const dnsRemoved = Boolean(namespace && rmPath);
    const interfaceRemoved = Boolean(interfaceName && ipPath && !inspection.interfaceExists);
    const namespaceRemoved = Boolean(namespace && ipPath && !inspection.namespaceExists);
    if (namespace && inspection.namespaceExists) {
        throw new Error(`Falha ao remover namespace '${namespace}'; o namespace ainda existe no sistema.`);
    }
    if (interfaceName && inspection.interfaceExists) {
        throw new Error(`Falha ao remover interface '${interfaceName}'; a interface ainda existe no sistema.`);
    }

    options?.log?.("info", "linux.network.cleanup_completed", {
        phase: "restored",
        namespace_removed: namespaceRemoved,
        interface_removed: interfaceRemoved,
        dns_removed: dnsRemoved,
    });
    return {
        stopped: true,
        namespaceRemoved,
        interfaceRemoved,
        dnsRemoved,
    };
}
