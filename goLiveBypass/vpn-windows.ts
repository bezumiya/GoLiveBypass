/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile, execFileSync } from "child_process";
import crypto from "crypto";
import { promises as dns } from "dns";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";

import {
    formatAllowedApps,
    safeDiagnosticDetail,
    sanitizeWireGuardConfig,
    validateWireGuardConfig,
    VPN_SERVICE_NAMES,
    type WireGuardConfigValidation,
} from "./vpn-types";
import { parseWireSockSnapshot, type WireSockSnapshot } from "./vpn-snapshot";
import { runWireSockSnapshotOutsideMainThread } from "./vpn-snapshot-worker";

// 3.8.2.1 corrige o checksum TCP de fragmentos IPv4 recebidos (wiresock/WireSockUI#168);
// também é o mínimo aceito, então uma instalação anterior é trocada pelo instalador fixado.
export const WIRESOCK_VERSION = "3.8.2.1";
const WIRESOCK_DOWNLOAD = `https://wiresock.net/_api/download-release.php?product=wiresock-secure-connect-sdk&platform=x64&version=${WIRESOCK_VERSION}&channel=winget`;
const WIRESOCK_INSTALLER_SHA256 = "3fa1ca6e595ff64ee638ccda8c14c8c5c6b65099130c4345f94464bcc3a0469c";
const WIRESOCK_DRIVER_NAMES = ["ndiswgc", "ndiswg", "NDISRD"] as const;
const WIRESOCK_EXECUTABLE = "wiresock-client.exe";
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export type WireSockLogger = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;

export interface WireSockCandidate {
    executable: string;
    booster: string;
    executableVersion: string;
    boosterVersion: string;
}

export interface WireSockInspection {
    active: boolean;
    owned: boolean;
    reliable: boolean;
    services: string[];
    processIds: number[];
    reason: string | null;
    /** Origem agregada dos recursos ativos: só faz sentido com `reliable && active`. */
    origin: WireSockOrigin;
    /** Serviços ativos cuja config aponta para o GoLiveBypass (plugin ou GUI). */
    managedServices: string[];
    /** PIDs ativos cuja config aponta para o GoLiveBypass (plugin ou GUI). */
    managedProcessIds: number[];
}

/**
 * Origem agregada dos recursos WireSock ativos. `managed` cobre apenas configs
 * comprovadamente do GoLiveBypass (plugin ou GUI); `mixed` mistura gerenciado com
 * externo/desconhecido e nunca autoriza encerrar nada; `unknown` é leitura
 * inconclusiva.
 */
export type WireSockOrigin = "plugin" | "gui" | "managed" | "external" | "mixed" | "unknown";

const UNKNOWN_WIRESOCK_STATE = "Não foi possível confirmar o estado do WireSock; estado desconhecido.";

export interface WireSockCleanupResult {
    stopped: boolean;
    servicesResidual: string[];
    processResidual: number[];
    networkLockReset: boolean;
    dnsCleared: boolean;
    dnsFlushed: boolean;
    error?: string;
}

export interface WireSockStartResult {
    executable: string;
    configPath: string;
    allowedApps: string;
}

export interface WindowsNetworkDiagnostic {
    ok: boolean;
    dnsOk: boolean;
    httpsOk: boolean;
    detail: string;
}

function logError(error: unknown): string {
    const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown; code?: unknown } | null;
    return safeDiagnosticDetail(value?.stderr || value?.stdout || value?.message || error, 500);
}

function isWindows(): boolean {
    return process.platform === "win32";
}

function quotePowerShell(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function normalizedPath(value: string): string {
    return value.trim().replace(/^"|"$/g, "").replace(/[\\/]+/g, "\\").toLowerCase();
}

function containsConfig(commandLine: string | null, configPath: string): boolean {
    if (!commandLine) return false;
    return normalizedPath(commandLine).includes(normalizedPath(configPath));
}

/**
 * Separa uma linha de comando do Windows preservando argumentos entre aspas. Os caminhos
 * gerados pelo GoLiveBypass não contêm aspas literais; por isso basta tratar `"` como
 * delimitador e espaços fora delas como separadores.
 */
function commandTokens(commandLine: string): string[] {
    const tokens: string[] = [];
    let token = "";
    let quoted = false;
    for (const character of commandLine.trim()) {
        if (character === '"') {
            quoted = !quoted;
            continue;
        }
        if (/\s/.test(character) && !quoted) {
            if (token) {
                tokens.push(token);
                token = "";
            }
            continue;
        }
        token += character;
    }
    if (token) tokens.push(token);
    return tokens;
}

/**
 * Extrai o argumento do flag `-config`/`--config` da linha de comando. Comparar por flag
 * (e não por substring da linha inteira) impede que `-allowed-apps`, caminhos de log ou
 * `wiresock-discord.conf.bak` sejam confundidos com a config aplicada.
 */
function configArgument(commandLine: string | null): string | null {
    if (!commandLine) return null;
    const tokens = commandTokens(commandLine);
    for (let index = 0; index < tokens.length - 1; index++) {
        const flag = tokens[index].toLowerCase();
        if (flag === "-config" || flag === "--config") return normalizedPath(tokens[index + 1]);
    }
    return null;
}

/**
 * Compara o argumento de config normalizado por igualdade, não por substring de
 * diretório: `wiresock-discord.conf.bak` ou um perfil do usuário colocado dentro da
 * pasta GoLiveBypass não podem ser confundidos com a config aplicada.
 */
function configArgumentEquals(commandLine: string | null, configPath: string): boolean {
    const argument = configArgument(commandLine);
    return argument !== null && argument === normalizedPath(configPath);
}

function serviceExists(name: string): boolean {
    if (!isWindows()) return false;
    try {
        execFileSync("sc.exe", ["query", name], { stdio: "ignore", windowsHide: true, timeout: 5000 });
        return true;
    } catch (error) {
        const code = Number((error as { status?: unknown })?.status);
        return code !== 1060;
    }
}

function serviceRunningFromCim(name: string): boolean | null {
    try {
        const script = `$s=Get-CimInstance Win32_Service -Filter "Name='${name.replace(/'/g, "''")}'"; if($s){$s.State}`;
        const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        });
        const value = output.trim();
        if (!value) return null;
        if (/^Running$/i.test(value)) return true;
        if (/^Stopped$/i.test(value)) return false;
        return null;
    } catch {
        return null;
    }
}

function serviceRunningFromSc(name: string): boolean | null {
    try {
        const output = execFileSync("sc.exe", ["query", name], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        });
        if (/STATE\s*:\s*\d+\s+RUNNING/i.test(output)) return true;
        if (/STATE\s*:\s*\d+\s+STOPPED/i.test(output)) return false;
        if (/STATE\s*:\s*\d+\s+(?:START_PENDING|STOP_PENDING|PAUSED|PAUSE_PENDING|CONTINUE_PENDING)/i.test(output)) return null;
        return null;
    } catch (error) {
        return Number((error as { status?: unknown })?.status) === 1060 ? false : null;
    }
}

function serviceRunning(name: string): boolean | null {
    if (!isWindows()) return false;
    const cimState = serviceRunningFromCim(name);
    if (cimState !== null) return cimState;
    return serviceRunningFromSc(name);
}

function serviceCommand(name: string): string | null {
    if (!isWindows() || !serviceExists(name)) return null;
    try {
        const script = `$s=Get-CimInstance Win32_Service -Filter "Name='${name.replace(/'/g, "''")}'"; if($s){$s.PathName}`;
        return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        }).trim() || null;
    } catch {
        return null;
    }
}

// A inspeção completa custava ~1,6s NA THREAD PRINCIPAL do Discord (medido na VM: sete
// spawns de PowerShell, seis deles Get-CimInstance, ~220ms só para criar cada processo), e o
// watchdog repete isso a cada 15s -- e até seis vezes seguidas quando confirma uma leitura
// transitória. Com a janela do Discord chegando a não responder por mais de 1s nas amostras
// de recon4, uma única sessão do PowerShell passou a responder tudo o que a inspeção precisa
// (estado, PathName e ProcessId dos serviços do WireSock + a lista de processos próprios).
// A checagem de slot e a limpeza seguem com os helpers baratos (sc.exe).
function wireSockSnapshotScript(names: readonly string[]): string {
    const list = names.map(name => quotePowerShell(name)).join(",");
    return `$names=@(${list})
$svc=@()
foreach($n in $names){
  $s=Get-CimInstance Win32_Service -Filter "Name='$n'" -ErrorAction SilentlyContinue
  if($s){ $svc += [PSCustomObject]@{ name=$s.Name; state=$s.State; command=$s.PathName; processId=[int]$s.ProcessId } }
  else { $svc += [PSCustomObject]@{ name=$n; state='Missing'; command=$null; processId=0 } }
}
$procs=@(Get-CimInstance Win32_Process -Filter "Name='wiresock-client.exe'" -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ pid=[int]$_.ProcessId; commandLine=$_.CommandLine } })
[PSCustomObject]@{ services=$svc; processes=$procs } | ConvertTo-Json -Compress -Depth 4`;
}

function readWireSockSnapshot(names: readonly string[]): WireSockSnapshot | null {
    const script = wireSockSnapshotScript(names);
    try {
        const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 8000,
        }).trim();
        if (!output) return null;
        return parseWireSockSnapshot(output, names);
    } catch {
        return null;
    }
}

function readWireSockSnapshotInProcessAsync(script: string, names: readonly string[]): Promise<WireSockSnapshot | null> {
    const { promise, resolve } = Promise.withResolvers<WireSockSnapshot | null>();
    try {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf8", windowsHide: true, timeout: 8000,
        }, (error, stdout) => {
            if (error || !stdout) {
                resolve(null);
                return;
            }
            try {
                const output = String(stdout).trim();
                resolve(output ? parseWireSockSnapshot(output, names) : null);
            } catch {
                resolve(null);
            }
        });
    } catch {
        resolve(null);
    }
    return promise;
}
function assertPluginServiceSlot(configPath: string): void {
    const name = VPN_SERVICE_NAMES[0];
    if (!serviceExists(name)) return;
    // Um registro parado não controla tráfego e pode ser retargeteado pelo
    // script de inicialização abaixo; o bloqueio continua valendo para um
    // serviço realmente ativo fora do perfil do plugin.
    const running = serviceRunning(name);
    if (running === null) throw new Error("Não foi possível confirmar o estado do serviço WireSock; operação interrompida por segurança.");
    if (!running) return;
    const command = serviceCommand(name);
    if (!command || !configArgumentEquals(command, configPath))
        throw new Error("O serviço WireSock já está registrado com outro perfil (possivelmente pela GUI ou por outro plugin). Desative-o antes de usar a VPN do plugin.");
}

export function inspectWireSock(configPath?: string, guiConfigPath?: string, snapshotOverride?: WireSockSnapshot | null): WireSockInspection {
    if (!isWindows())
        return { active: false, owned: false, reliable: true, services: [], processIds: [], reason: null, origin: "unknown", managedServices: [], managedProcessIds: [] };
    const snapshot = snapshotOverride === undefined ? readWireSockSnapshot(VPN_SERVICE_NAMES) : snapshotOverride;
    if (!snapshot) {
        // Sem o snapshot a leitura já é desconhecida de qualquer forma: os processos não têm
        // fonte barata. O sc.exe (~9ms, sem PowerShell) ainda diz quais serviços estão de pé,
        // o que é tudo o que a mensagem de estado desconhecido reporta.
        return {
            // Uma leitura incompleta não prova nem presença nem ausência. Não
            // a exponha como ativa, pois isso faria o controller classificá-la
            // incorretamente como um WireSock externo.
            active: false,
            owned: false,
            reliable: false,
            services: VPN_SERVICE_NAMES.filter(name => serviceRunningFromSc(name) === true),
            processIds: [],
            reason: UNKNOWN_WIRESOCK_STATE,
            origin: "unknown",
            managedServices: [],
            managedProcessIds: [],
        };
    }
    const serviceStates = snapshot.services.map(service => ({ name: service.name, running: service.running }));
    const services = serviceStates.filter(service => service.running === true).map(service => service.name);
    const processes = snapshot.processes;
    const processIds = processes.map(process => process.pid);
    // A lista de processos veio do mesmo snapshot: se ela não existisse, `readWireSockSnapshot`
    // teria devolvido null. Sobra saber se cada nome de serviço respondeu um estado definitivo.
    const reliable = serviceStates.every(service => service.running !== null);
    if (!reliable) {
        return {
            active: false,
            owned: false,
            reliable: false,
            services,
            processIds,
            reason: UNKNOWN_WIRESOCK_STATE,
            origin: "unknown",
            managedServices: [],
            managedProcessIds: [],
        };
    }
    const active = services.length > 0 || processes.length > 0;
    if (!active)
        return { active: false, owned: false, reliable: true, services: [], processIds: [], reason: null, origin: "unknown", managedServices: [], managedProcessIds: [] };
    if (!configPath)
        return { active, owned: false, reliable: true, services, processIds, reason: "WireSock já está ativo fora do perfil do plugin.", origin: "unknown", managedServices: [], managedProcessIds: [] };

    const commandOf = (name: string) => snapshot.services.find(service => service.name === name)?.command ?? null;
    if (services.some(name => commandOf(name) === null)) {
        return {
            active: false,
            owned: false,
            reliable: false,
            services,
            processIds,
            reason: "Não foi possível confirmar o perfil do serviço WireSock; estado desconhecido.",
            origin: "unknown",
            managedServices: [],
            managedProcessIds: [],
        };
    }
    // Cada recurso ativo recebe uma origem comprovada pelo argumento de config. Um processo
    // sem linha de comando só herda a origem do serviço cujo ProcessId coincide com o PID;
    // fora disso a leitura inteira é desconhecida (nada pode ser encerrado com segurança).
    // O pool de rotas da GUI vive dentro da pasta dela e também é instância gerenciada.
    const guiPoolPrefix = guiConfigPath
        ? `${normalizedPath(path.win32.join(path.win32.dirname(guiConfigPath), "proton-route-pool"))}\\`
        : null;
    const isGuiConfig = (argument: string | null): boolean => {
        if (!argument || !guiConfigPath) return false;
        return argument === normalizedPath(guiConfigPath) || (guiPoolPrefix !== null && argument.startsWith(guiPoolPrefix));
    };
    const classify = (commandLine: string | null): "plugin" | "gui" | "external" | null => {
        const argument = configArgument(commandLine);
        if (argument !== null && argument === normalizedPath(configPath)) return "plugin";
        if (isGuiConfig(argument)) return "gui";
        if (commandLine && commandLine.trim().length > 0) return "external";
        return null;
    };
    const serviceOrigin = new Map<string, "plugin" | "gui" | "external">();
    for (const name of services) serviceOrigin.set(name, classify(commandOf(name)) ?? "external");
    const servicePidsOf = (origin: "plugin" | "gui") => new Set(snapshot.services
        .filter(service => service.running === true && serviceOrigin.get(service.name) === origin)
        .map(service => service.processId)
        .filter((pid): pid is number => pid !== null));
    const pluginServicePids = servicePidsOf("plugin");
    const guiServicePids = servicePidsOf("gui");
    const processOrigin = processes.map(process => {
        const direct = classify(process.commandLine);
        if (direct) return direct;
        if (pluginServicePids.has(process.pid)) return "plugin" as const;
        if (guiServicePids.has(process.pid)) return "gui" as const;
        return null;
    });
    if (processOrigin.some(origin => origin === null)) {
        return {
            active: false,
            owned: false,
            reliable: false,
            services,
            processIds,
            reason: "Não foi possível confirmar o perfil do processo WireSock; estado desconhecido.",
            origin: "unknown",
            managedServices: [],
            managedProcessIds: [],
        };
    }
    const ownServices = services.filter(name => serviceOrigin.get(name) === "plugin");
    const ownProcesses = processes.filter((_, index) => processOrigin[index] === "plugin");
    const managedServices = services.filter(name => serviceOrigin.get(name) === "gui");
    const managedProcesses = processes.filter((_, index) => processOrigin[index] === "gui");
    const managedProcessIds = managedProcesses.map(process => process.pid);
    const externalCount = (services.length - ownServices.length - managedServices.length)
        + (processes.length - ownProcesses.length - managedProcesses.length);
    const hasManaged = managedServices.length + managedProcessIds.length > 0;
    const hasOwn = ownServices.length + ownProcesses.length > 0;
    if (hasOwn && !hasManaged && externalCount === 0)
        return { active, owned: true, reliable: true, services, processIds, reason: null, origin: "plugin", managedServices: [], managedProcessIds: [] };

    let origin: WireSockOrigin;
    let reason: string;
    if (externalCount > 0 && (hasManaged || hasOwn)) {
        origin = "mixed";
        reason = hasOwn && !hasManaged
            ? "WireSock próprio e externo foram detectados ao mesmo tempo; a operação foi bloqueada."
            : "WireSock externo e uma instância GoLiveBypass estão ativos ao mesmo tempo; a operação foi bloqueada.";
    } else if (externalCount > 0) {
        origin = "external";
        reason = "WireSock externo já está ativo fora do GoLiveBypass.";
    } else if (hasOwn) {
        origin = "managed";
        reason = "WireSock próprio e da GUI GoLiveBypass estão ativos ao mesmo tempo.";
    } else {
        origin = "gui";
        reason = "Outra superfície do GoLiveBypass (GUI) está com o WireSock ativo.";
    }
    return { active, owned: false, reliable: true, services, processIds, reason, origin, managedServices, managedProcessIds };
}
export async function inspectWireSockAsync(configPath?: string, guiConfigPath?: string): Promise<WireSockInspection> {
    if (!isWindows()) return inspectWireSock(configPath, guiConfigPath);
    const names = VPN_SERVICE_NAMES;
    const run = await runWireSockSnapshotOutsideMainThread(wireSockSnapshotScript(names), 8000);
    if (run.ran) {
        const snapshot = run.stdout ? parseWireSockSnapshot(run.stdout, names) : null;
        return inspectWireSock(configPath, guiConfigPath, snapshot);
    }
    return inspectWireSock(configPath, guiConfigPath, await readWireSockSnapshotInProcessAsync(wireSockSnapshotScript(names), names));
}
export function wireSockSearchRoots(env: NodeJS.ProcessEnv = process.env): string[] {
    const programFiles = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"]
        .filter((value): value is string => Boolean(value));
    const roots = new Set<string>();
    for (const directory of programFiles) roots.add(path.join(directory, "WireSock Secure Connect"));
    if (env.LOCALAPPDATA) roots.add(path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages"));
    return [...roots];
}

function pairIfPresent(executable: string): { executable: string; booster: string } | null {
    const booster = path.join(path.dirname(executable), "wgbooster.dll");
    return fs.existsSync(executable) && fs.existsSync(booster) ? { executable, booster } : null;
}

function candidatePairs(env: NodeJS.ProcessEnv = process.env): Array<{ executable: string; booster: string }> {
    const pairs: Array<{ executable: string; booster: string }> = [];
    const seen = new Set<string>();
    const add = (executable: string) => {
        const pair = pairIfPresent(executable);
        const key = executable.toLowerCase();
        if (pair && !seen.has(key)) {
            seen.add(key);
            pairs.push(pair);
        }
    };
    for (const root of wireSockSearchRoots(env)) {
        for (const relative of [WIRESOCK_EXECUTABLE, path.join("sdk", WIRESOCK_EXECUTABLE)]) add(path.join(root, relative));
        if (!/Packages$/i.test(root)) continue;
        try {
            for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                if (!entry.isDirectory() || !/wiresock|ntkernel\.wiresock/i.test(entry.name)) continue;
                const packageRoot = path.join(root, entry.name);
                for (const layout of [packageRoot, path.join(packageRoot, "x64")]) {
                    add(path.join(layout, WIRESOCK_EXECUTABLE));
                    add(path.join(layout, "sdk", WIRESOCK_EXECUTABLE));
                }
            }
        } catch {}
    }
    return pairs;
}

function versionOf(file: string): string | null {
    try {
        const script = `(Get-Item -LiteralPath ${quotePowerShell(file)}).VersionInfo.FileVersion`;
        const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        }).trim();
        return /^\d+\.\d+\.\d+\.\d+$/.test(output) ? output : null;
    } catch {
        return null;
    }
}

function compareVersions(left: string, right: string): number {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let i = 0; i < 4; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? 1 : -1;
    }
    return 0;
}

export function selectWireSockCandidate(candidates: WireSockCandidate[]): WireSockCandidate | null {
    return candidates
        .filter(candidate => compareVersions(candidate.executableVersion, WIRESOCK_VERSION) >= 0)
        .filter(candidate => compareVersions(candidate.boosterVersion, WIRESOCK_VERSION) >= 0)
        .filter(candidate => candidate.executableVersion === candidate.boosterVersion)
        .sort((a, b) => compareVersions(b.executableVersion, a.executableVersion))[0] ?? null;
}

export function findWireSockCandidate(env: NodeJS.ProcessEnv = process.env): WireSockCandidate | null {
    if (!isWindows()) return null;
    const candidates = candidatePairs(env).flatMap(pair => {
        const executableVersion = versionOf(pair.executable);
        const boosterVersion = versionOf(pair.booster);
        return executableVersion && boosterVersion
            ? [{ ...pair, executableVersion, boosterVersion }]
            : [];
    });
    return selectWireSockCandidate(candidates);
}

function downloadInstaller(target: string, url = WIRESOCK_DOWNLOAD, redirects = 0): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:" || !/(^|\.)wiresock\.net$/i.test(parsed.hostname)) {
                reject(new Error("Redirecionamento para host não autorizado do instalador WireSock."));
                return;
            }
        } catch {
            reject(new Error("URL oficial do WireSock inválida."));
            return;
        }
        const request = https.get(url, response => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (redirects >= 3) { reject(new Error("Muitos redirecionamentos no instalador WireSock.")); return; }
                // O endpoint oficial pode apontar para o CDN do próprio wiresock.net.
                const next = new URL(response.headers.location, url).toString();
                void downloadInstaller(target, next, redirects + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Download WireSock retornou HTTP ${response.statusCode ?? "desconhecido"}.`));
                return;
            }
            const output = fs.createWriteStream(target, { flags: "wx" });
            let total = 0;
            let done = false;
            const fail = (error: Error) => {
                if (done) return;
                done = true;
                response.destroy();
                output.destroy();
                reject(error);
            };
            response.on("data", (chunk: Buffer) => {
                total += chunk.length;
                if (total > MAX_DOWNLOAD_BYTES) fail(new Error("O instalador WireSock excede o limite de tamanho."));
            });
            response.once("error", fail);
            output.once("error", fail);
            response.pipe(output);
            output.once("finish", () => output.close(error => {
                if (error) fail(error);
                else if (!done) {
                    done = true;
                    resolve();
                }
            }));
        });
        request.setTimeout(120_000, () => request.destroy(new Error("Timeout ao baixar o instalador WireSock.")));
        request.once("error", reject);
    });
}

function sha256(file: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Modos do setup oficial: `uninstall` e `repair` sao os proprios switches de manutencao
// do instalador e sao o que resolve a instalacao que o /quiet sozinho deixa pela metade.
const WIRESOCK_INSTALLER_ARGUMENTS = {
    install: ["/quiet", "/norestart"],
    uninstall: ["/uninstall", "/quiet", "/norestart"],
    repair: ["/repair", "/quiet", "/norestart"],
} as const;
export type WireSockInstallerMode = keyof typeof WIRESOCK_INSTALLER_ARGUMENTS;

export function wireSockInstallerArguments(mode: WireSockInstallerMode): string[] {
    return [...WIRESOCK_INSTALLER_ARGUMENTS[mode]];
}

function runElevatedInstaller(installer: string, mode: WireSockInstallerMode, timeoutMs = WIRESOCK_INSTALLER_TIMEOUT_MS): Promise<void> {
    const argumentsLiteral = wireSockInstallerArguments(mode).map(value => quotePowerShell(value)).join(",");
    const command = `try { $p=Start-Process -FilePath ${quotePowerShell(installer)} -ArgumentList @(${argumentsLiteral}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; if($null -eq $p){ exit 1223 }; exit [int]$p.ExitCode } catch { if($_.Exception.NativeErrorCode -eq 1223){ exit 1223 }; Write-Error $_; exit 1 }`;
    return new Promise((resolve, reject) => {
        const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
            windowsHide: true,
            timeout: timeoutMs,
        }, error => {
            if (!error) { resolve(); return; }
            // No estouro a arvore inteira e morta: um setup vivo continuaria
            // escrevendo no WireSock depois de o plugin desistir.
            if ((error as { killed?: boolean }).killed) {
                try { execFileSync("taskkill.exe", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true }); } catch {}
                reject(new Error(`O instalador WireSock (modo ${mode}) não terminou em ${Math.round(timeoutMs / 1000)} s e foi encerrado.`));
                return;
            }
            reject(error);
        });
        child.once("error", reject);
    });
}

// Tetos medidos no Windows 11 com o setup 3.4.8.1: desinstalar leva segundos e
// instalar/reparar menos de um minuto.
const WIRESOCK_INSTALLER_TIMEOUT_MS = 5 * 60_000;
const WIRESOCK_UNINSTALL_TIMEOUT_MS = 3 * 60_000;
const WIRESOCK_SETTLE_TIMEOUT_MS = 90_000;

/**
 * O setup pode sair antes da transacao do Windows Installer (medido: o `msiexec`
 * continuou rodando depois do `/quiet` devolver). Verificar na hora daria falso
 * negativo e a mensagem de "instalador terminou sem par compativel".
 */
async function waitForCompatibleWireSock(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const found = findWireSockCandidate();
        if (found) return found.executable;
        if (Date.now() >= deadline) return null;
        await wait(2000);
    }
}

// 1605 = produto nao instalado, 1614 = produto desinstalado.
const WIRESOCK_ABSENT_EXIT_CODES = new Set([0, 1605, 1614]);

export type WireSockInstallState = "compatible" | "stale" | "none";

export interface WireSockInstallStateProbe {
    compatiblePair: boolean;
    installDir: boolean;
    registered: boolean;
    driverService: boolean;
}

/**
 * "stale" e o estado perigoso: sobrou registro do Windows (ou driver, ou pasta) sem um par
 * cliente/booster utilizavel. Rodar o setup por cima disso cai em manutencao ("Modify Setup"),
 * que em /quiet nao instala e pode deixar o driver pela metade — foi assim que maquinas
 * ficaram sem internet depois de uma instalacao do plugin.
 */
export function classifyWireSockInstallState(probe: WireSockInstallStateProbe): WireSockInstallState {
    if (probe.compatiblePair) return "compatible";
    if (probe.installDir || probe.registered || probe.driverService) return "stale";
    return "none";
}

export function parseWireSockUninstallEntries(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw) as unknown;
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows.flatMap(row => {
            const name = (row as { name?: unknown })?.name;
            return typeof name === "string" && name.trim() ? [name.trim()] : [];
        });
    } catch {
        return [];
    }
}

export interface WireSockNetworkRestoreResult {
    ok: boolean;
    executed: boolean;
    networkLockReset: boolean;
    dnsFlushed: boolean;
    adapterRoutesCleared: boolean;
    residual: string[];
}

/**
 * Recuperacao de rede do fornecedor para a instalacao quebrada: `reset-network-lock` e o
 * comando que a documentacao do WireSock indica quando o lock de driver fica ligado depois
 * de uma saida anormal (enquanto ligado, nada sai). A rota default orfa do adaptador virtual e
 * o DNS sao o resto do mesmo estado. O script recusa se houver `wiresock-client` em execucao:
 * resetar o lock derrubaria a sessao de outro controlador.
 */
export function wireSockNetworkRestoreScript(clients: string[], resultPath: string): string {
    if (!resultPath || /["\r\n\0]/.test(resultPath)) throw new Error("Caminho WireSock inválido");
    const literals = clients.map(value => {
        if (!value || /["\r\n\0]/.test(value)) throw new Error("Caminho WireSock inválido");
        return quotePowerShell(value);
    });
    return `$ErrorActionPreference = 'Continue'
$resultPath = ${quotePowerShell(resultPath)}
$result = [PSCustomObject]@{ ok=$false; networkLockReset=$false; dnsFlushed=$false; adapterRoutesCleared=$false; residual=@() }
try {
  $running = @(Get-CimInstance Win32_Process -Filter "Name='wiresock-client.exe'" -ErrorAction Stop)
  if ($running.Count -gt 0) {
    $result.residual += 'WIRESOCK_RUNNING: ha um WireSock em execucao; o lock de rede nao foi tocado para nao derrubar um tunel ativo'
  } else {
    $client = $null
    foreach ($candidate in @(${literals.join(",")})) {
      if (Test-Path -LiteralPath $candidate) { $client = $candidate; break }
    }
    if ($client) {
      $null = & $client reset-network-lock
      if ($LASTEXITCODE -eq 0) { $result.networkLockReset = $true }
      else { $result.residual += "NETWORK_LOCK_FAILED: codigo=$LASTEXITCODE" }
    } else {
      $result.residual += 'WIRESOCK_CLIENT_MISSING: nenhum wiresock-client.exe conhecido; o lock de driver nao pode ser resetado'
    }
    foreach ($adapter in @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'ProTUN|WireSock|WireGuard' })) {
      $null = & netsh.exe interface ipv4 delete route 0.0.0.0/0 $adapter.Name
      $null = & netsh.exe interface ipv6 delete route ::/0 $adapter.Name
      $result.adapterRoutesCleared = $true
    }
    $null = & ipconfig.exe /flushdns
    $result.dnsFlushed = ($LASTEXITCODE -eq 0)
  }
  $result.ok = ($result.residual.Count -eq 0)
} catch {
  $result.residual += $_.Exception.Message
  $result.ok = $false
}
[IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json -Compress -Depth 4), [Text.UTF8Encoding]::new($false))`;
}

/** Qualquer `wiresock-client.exe` conhecido, inclusive de versão antiga: só o reset do lock usa. */
export function anyWireSockClientPath(env: NodeJS.ProcessEnv = process.env): string | null {
    for (const root of wireSockSearchRoots(env)) {
        for (const relative of [WIRESOCK_EXECUTABLE, path.join("sdk", WIRESOCK_EXECUTABLE)]) {
            const candidate = path.join(root, relative);
            try { if (fs.existsSync(candidate)) return candidate; } catch { /* raiz inacessível */ }
        }
    }
    return null;
}

export function wireSockResidueNeedsRestore(snapshot: { clientInstalled: boolean; driverService: boolean; adapterDefaultRoute: boolean }): boolean {
    return snapshot.adapterDefaultRoute || (snapshot.driverService && !snapshot.clientInstalled);
}

export function parseWireSockOrphanDefaultRoutes(output: string): boolean {
    return output.split(/\r?\n/).some(line =>
        /0\.0\.0\.0\/0/.test(line) && /(?:^|[\s|])(?:protun|wiresock|wireguard)(?:[\s|]|$)/i.test(line));
}

const EMPTY_NETWORK_RESTORE: WireSockNetworkRestoreResult = {
    ok: true, executed: false, networkLockReset: false, dnsFlushed: false, adapterRoutesCleared: false, residual: [],
};

/**
 * Rede de segurança da instalacao: se o setup falhar, a maquina nao pode ficar sem saida.
 * Roda o comando de recuperacao do fornecedor e limpa rota/DNS do adaptador virtual.
 */
export async function restoreWireSockNetwork(log: WireSockLogger, options: { force?: boolean } = {}): Promise<WireSockNetworkRestoreResult> {
    if (!isWindows()) return EMPTY_NETWORK_RESTORE;
    const client = anyWireSockClientPath();
    let driverService = false;
    let adapterDefaultRoute = false;
    try {
        driverService = isWireSockPacketFilterDriverInstalled();
        adapterDefaultRoute = parseWireSockOrphanDefaultRoutes(execFileSync("netsh", ["interface", "ipv4", "show", "route"], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10_000,
        }));
    } catch { /* leitura sem privilégio: segue sem resíduo comprovado */ }
    if (!options.force && !wireSockResidueNeedsRestore({ clientInstalled: Boolean(client), driverService, adapterDefaultRoute })) {
        log("info", "recuperacao de rede nao necessaria", { driverService, adapterDefaultRoute });
        return EMPTY_NETWORK_RESTORE;
    }
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "golive-plugin-restore-"));
    const resultPath = path.join(directory, "restore.json");
    try {
        const script = wireSockNetworkRestoreScript(client ? [client] : [], resultPath);
        await new Promise<void>((resolve, reject) => {
            const child = execFile("powershell.exe", elevatedPowerShellArgs(script), { windowsHide: false, timeout: 120_000 },
                error => error ? reject(error) : resolve());
            child.once("error", reject);
        });
        const parsed = JSON.parse(await fs.promises.readFile(resultPath, "utf8")) as Record<string, unknown>;
        const result: WireSockNetworkRestoreResult = {
            ok: parsed.ok === true,
            executed: true,
            networkLockReset: parsed.networkLockReset === true,
            dnsFlushed: parsed.dnsFlushed === true,
            adapterRoutesCleared: parsed.adapterRoutesCleared === true,
            residual: Array.isArray(parsed.residual) ? parsed.residual.filter((value): value is string => typeof value === "string") : [],
        };
        log(result.ok ? "info" : "warn", "recuperacao de rede apos a instalacao", { ...result });
        return result;
    } catch (error) {
        const residual = [logError(error)];
        log("warn", "recuperacao de rede nao confirmada", { residual });
        return { ...EMPTY_NETWORK_RESTORE, ok: false, executed: true, residual };
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
}

/** Mensagem honesta: o script dizer que deu certo nao prova que o Windows navega. */
export function wireSockInstallFailureHint(restore: WireSockNetworkRestoreResult): string {
    if (!restore.executed) return "";
    if (restore.ok && restore.networkLockReset) return "A rede do Windows foi restaurada depois da falha da instalação.";
    if (restore.networkLockReset) return `O bloqueio de rede do driver foi removido, mas a recuperação ficou inconclusiva (${restore.residual.join("; ") || "sem detalhes"}).`;
    return `A instalação falhou e não foi possível confirmar a rede (${restore.residual.join("; ") || "sem detalhes"}). Use "Restaurar rede" do painel do plugin; se persistir, repita Reparo em Programas e Recursos do "WireSock Secure Connect".`;
}

async function hasWireSockUninstallRegistration(): Promise<{ registered: boolean; entries: string[] }> {
    const script = "$roots=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); $found=@(); foreach($root in $roots){ try { Get-ItemProperty -Path $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and $_.DisplayName -match '(?i)wire\\s?sock|wglaunch' } | ForEach-Object { $found += [PSCustomObject]@{ name=[string]$_.DisplayName } } } catch {} }; ConvertTo-Json -Compress $found";
    try {
        const output = await new Promise<string>((resolve, reject) => {
            const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
                encoding: "utf8", windowsHide: true, timeout: 8000,
            }, (error, stdout) => error ? reject(error) : resolve(stdout));
            child.once("error", reject);
        });
        const entries = parseWireSockUninstallEntries(output);
        return { registered: entries.length > 0, entries };
    } catch {
        return { registered: false, entries: [] };
    }
}

async function detectWireSockInstallState(): Promise<WireSockInstallState> {
    const installDir = wireSockSearchRoots().some(root => {
        try { return fs.existsSync(root) || fs.existsSync(path.join(root, "sdk")); } catch { return false; }
    });
    const registration = await hasWireSockUninstallRegistration();
    return classifyWireSockInstallState({
        compatiblePair: false,
        installDir,
        registered: registration.registered,
        driverService: isWireSockPacketFilterDriverInstalled(),
    });
}

let installInFlight: Promise<string> | null = null;

export function ensureWireSockInstalled(log: WireSockLogger): Promise<string> {
    installInFlight ??= ensureWireSockInstalledOnce(log).finally(() => { installInFlight = null; });
    return installInFlight;
}

async function ensureWireSockInstalledOnce(log: WireSockLogger): Promise<string> {
    if (!isWindows()) throw new Error("A VPN do plugin nesta versão exige Windows x64.");
    if (process.arch !== "x64") throw new Error("A VPN do plugin nesta versão exige Windows x64.");
    const existing = findWireSockCandidate();
    if (existing) {
        log("info", "WireSock SDK compatível encontrado", { version: existing.executableVersion });
        return existing.executable;
    }

    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "golive-plugin-wiresock-"));
    const installer = path.join(temporary, "wiresock-sdk.exe");
    try {
        log("info", "baixando instalador oficial do WireSock", { version: WIRESOCK_VERSION });
        await downloadInstaller(installer);
        if (sha256(installer).toLowerCase() !== WIRESOCK_INSTALLER_SHA256)
            throw new Error("Hash do instalador WireSock não corresponde ao release oficial fixado.");
        const state = await detectWireSockInstallState();
        if (state === "stale") {
            log("warn", "instalacao anterior do WireSock esta pela metade; removendo antes de instalar", { state });
            try {
                await runElevatedInstaller(installer, "uninstall", WIRESOCK_UNINSTALL_TIMEOUT_MS);
            } catch (error) {
                const code = Number((error as { code?: unknown })?.code);
                if (code === 1223) throw new Error("A instalação do WireSock foi cancelada pelo usuário.");
                if (!WIRESOCK_ABSENT_EXIT_CODES.has(code)) log("warn", "desinstalacao anterior nao confirmada", { codigo: code, erro: logError(error) });
            }
        }
        log("info", "instalando WireSock com elevação do Windows");
        await runElevatedInstaller(installer, "install");
        let installed = await waitForCompatibleWireSock(WIRESOCK_SETTLE_TIMEOUT_MS);
        if (!installed) {
            // O setup entrou em manutencao e nao instalou (medido: /quiet devolve 0
            // em 3 s sobre uma instalacao registrada e nao escreve nada). O reparo e
            // o caminho que restaura o driver e o par no lugar.
            log("warn", "instalador terminou sem par compatível; tentando reparo", {});
            try {
                await runElevatedInstaller(installer, "repair");
            } catch (error) {
                const code = Number((error as { code?: unknown })?.code);
                if (code === 1223) throw new Error("A instalação do WireSock foi cancelada pelo usuário.");
                log("warn", "reparo do WireSock nao confirmado", { erro: logError(error) });
            }
            installed = await waitForCompatibleWireSock(WIRESOCK_SETTLE_TIMEOUT_MS);
        }
        if (!installed) throw new Error("O instalador WireSock terminou, mas não deixou uma instalação SDK compatível.");
        return installed;
    } catch (error) {
        const code = Number((error as { code?: unknown })?.code);
        if (code === 1223) throw new Error("A instalação do WireSock foi cancelada pelo usuário.");
        // O setup ja tocou o driver: a maquina nao pode ficar sem saida por causa disso.
        const restore = await restoreWireSockNetwork(log, { force: true });
        log("error", "instalacao do WireSock falhou", { erro: logError(error), restore: { ...restore } });
        const hint = wireSockInstallFailureHint(restore);
        throw new Error(`Não foi possível preparar o WireSock: ${logError(error)}${hint ? ` ${hint}` : ""}`);
    } finally {
        await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
}

export function validateWireGuardProfile(raw: string): WireGuardConfigValidation {
    return validateWireGuardConfig(raw);
}

function serviceScript(executable: string, configPath: string): string {
    const expected = `"${executable}" service -config "${configPath}" -log-level info -network-lock disabled`;
    return `$ErrorActionPreference='Stop'
try {
  $name='wiresock-client-service'
  $expected=${quotePowerShell(expected)}
  $service=Get-Service -Name $name -ErrorAction SilentlyContinue
  if($service -and $service.Status -ne 'Stopped') { Stop-Service -Name $name -Force; $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(20)) }
  if(-not $service) {
    & ${quotePowerShell(executable)} install -start-type 3 -config ${quotePowerShell(configPath)} -log-level info -network-lock disabled
    if($LASTEXITCODE -ne 0){ throw 'Falha ao instalar o serviço WireSock' }
  }
  $info=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if(-not $info){ throw 'Serviço WireSock não encontrado após instalação' }
  $change=Invoke-CimMethod -InputObject $info -MethodName Change -Arguments @{PathName=$expected;StartMode='Manual'}
  if($change.ReturnValue -ne 0){ throw "Falha ao atualizar o perfil do serviço: $($change.ReturnValue)" }
  $actual=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if($actual.PathName -cne $expected){ throw 'O serviço WireSock permaneceu com outra configuração' }
  Start-Service -Name $name
  (Get-Service -Name $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(20))
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
}

function elevatedPowerShellArgs(script: string): string[] {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const wrapper = `$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){ & powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}; exit $LASTEXITCODE }
$child=Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encoded}'
exit $child.ExitCode`;
    return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(wrapper, "utf16le").toString("base64")];
}

export async function startWireSockService(
    configPath: string,
    rawConfig: string,
    allowedAppPaths: string[],
    log: WireSockLogger,
): Promise<WireSockStartResult> {
    if (!isWindows() || process.arch !== "x64") throw new Error("A VPN do plugin nesta versão exige Windows x64.");
    const allowedApps = formatAllowedApps(allowedAppPaths);
    const validation = validateWireGuardProfile(rawConfig);
    if (!validation.valid) throw new Error(validation.error);

    const current = inspectWireSock(configPath);
    if (!current.reliable) throw new Error(current.reason || UNKNOWN_WIRESOCK_STATE);
    if (current.active && !current.owned) throw new Error(current.reason || "WireSock externo já está ativo.");
    assertPluginServiceSlot(configPath);
    const executable = await ensureWireSockInstalled(log);
    const target = path.resolve(configPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const sanitized = sanitizeWireGuardConfig(rawConfig, allowedApps);
    const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(staging, sanitized, "utf8");
    fs.renameSync(staging, target);

    try {
        execFileSync("powershell.exe", elevatedPowerShellArgs(serviceScript(executable, target)), {
            windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
        });
    } catch (error) {
        try { fs.rmSync(staging, { force: true }); } catch {}
        log("error", "falha ao iniciar o serviço WireSock", { erro: logError(error) });
        throw new Error("Não foi possível configurar/iniciar o serviço WireSock. Confira a permissão de administrador e os logs.");
    }

    const inspection = inspectWireSock(target);
    if (!inspection.reliable) {
        log("error", "WireSock não confirmou o perfil próprio após a ativação", { motivo: inspection.reason || UNKNOWN_WIRESOCK_STATE });
        throw new Error("O serviço WireSock não confirmou o perfil do plugin após a ativação.");
    }
    if (!inspection.active || !inspection.owned) {
        log("error", "WireSock não confirmou o perfil próprio após a ativação", { motivo: inspection.reason || "serviço ausente" });
        throw new Error("O serviço WireSock não confirmou o perfil do plugin após a ativação.");
    }
    // Sanitized profiles omit DNS; activation cannot reset another adapter's saved DNS.
    log("info", "serviço WireSock ativo com filtro por aplicativo", { config: target, allowedApps });
    return { executable, configPath: target, allowedApps };
}

function runAsAdministrator(file: string, args: string[], log: WireSockLogger): boolean {
    try {
        execFileSync(file, args, { stdio: "ignore", windowsHide: true, timeout: 30_000 });
        return true;
    } catch {
        try {
            const argumentList = args.map(arg => quotePowerShell(arg)).join(",");
            const script = `$p=Start-Process -FilePath ${quotePowerShell(file)} -ArgumentList @(${argumentList}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
            execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
                stdio: "ignore", windowsHide: false, timeout: 30_000,
            });
            return true;
        } catch (error) {
            log("warn", "operação elevada do WireSock falhou", { erro: logError(error) });
            return false;
        }
    }
}

function killProcesses(processIds: number[], label: string, log: WireSockLogger): void {
    for (const pid of processIds) {
        if (!runAsAdministrator("taskkill.exe", ["/F", "/T", "/PID", String(pid)], log))
            log("warn", `não consegui encerrar processo WireSock ${label}`, { pid });
    }
}

function killOwnProcesses(processIds: number[], log: WireSockLogger): void {
    killProcesses(processIds, "próprio", log);
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const WIRESOCK_INSPECTION_RETRIES = 6;

async function inspectWireSockUntilReliable(configPath: string, guiConfigPath?: string): Promise<WireSockInspection> {
    let inspection = inspectWireSock(configPath, guiConfigPath);
    for (let attempt = 1; !inspection.reliable && attempt < WIRESOCK_INSPECTION_RETRIES; attempt++) {
        await wait(500);
        inspection = inspectWireSock(configPath, guiConfigPath);
    }
    return inspection;
}

/**
 * Reconsulta uma leitura incompleta com orçamento fixo, reutilizando a worker persistente
 * usada pelas inspeções assíncronas. Uma resposta não confiável nunca vira `active` e, se
 * continuar incompleta, o chamador permanece em recuperação manual.
 */
export async function inspectWireSockUntilReliableAsync(configPath: string, guiConfigPath?: string): Promise<WireSockInspection> {
    let inspection = await inspectWireSockAsync(configPath, guiConfigPath);
    for (let attempt = 1; !inspection.reliable && attempt < WIRESOCK_INSPECTION_RETRIES; attempt++) {
        await wait(500);
        inspection = await inspectWireSockAsync(configPath, guiConfigPath);
    }
    return inspection;
}


export async function stopOwnedWireSock(
    configPath: string,
    log: WireSockLogger,
    confirmedInspection?: WireSockInspection,
    options?: { manual?: boolean },
): Promise<WireSockCleanupResult> {
    if (!isWindows()) return { stopped: true, servicesResidual: [], processResidual: [], networkLockReset: false, dnsCleared: false, dnsFlushed: false };
    // `manual` marca a Restaurar rede do usuário (#306): é a única ação que segue
    // com a leitura inconclusiva. Sem ele (watchdog, quit, boot, rollback de
    // ativação) uma inspeção desconhecida continua recusando a parada.
    const manual = options?.manual === true;
    const initial = confirmedInspection ?? inspectWireSock(configPath);
    if (!initial.reliable && !manual) {
        const error = initial.reason || UNKNOWN_WIRESOCK_STATE;
        log("warn", "limpeza adiada porque o estado do WireSock é desconhecido", { motivo: error });
        return { stopped: false, servicesResidual: initial.services, processResidual: initial.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
    }
    // Preservação de recurso comprovadamente alheio vale também na ação manual:
    // o caso que trava o usuário é a leitura desconhecida, não o externo provado.
    if (initial.active && !initial.owned) {
        const error = initial.reason || "WireSock externo detectado";
        log("warn", "limpeza recusada para preservar WireSock externo", { motivo: error });
        return { stopped: false, servicesResidual: initial.services, processResidual: initial.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
    }
    if (!initial.reliable && manual)
        log("warn", "restauração manual segue sem ownership comprovado", { motivo: initial.reason || UNKNOWN_WIRESOCK_STATE, servicos: initial.services, pids: initial.processIds });

    for (const name of initial.services) {
        // Serviços listados são os que a leitura confirmou em execução; na ação
        // manual a parada segue mesmo sem o argumento de configuração legível.
        if (manual || containsConfig(serviceCommand(name), configPath)) {
            if (!runAsAdministrator("sc.exe", ["stop", name], log))
                log("warn", "não consegui solicitar parada do serviço WireSock", { servico: name, modo: manual ? "manual" : "proprio" });
        }
    }
    if (manual && initial.processIds.length) killProcesses(initial.processIds, "da restauração manual", log);
    for (let attempt = 0; attempt < 2; attempt++) {
        await wait(500);
        const current = await inspectWireSockUntilReliable(configPath);
        if (!current.reliable) {
            if (!manual) {
                const error = current.reason || UNKNOWN_WIRESOCK_STATE;
                log("error", "limpeza interrompida porque o estado do WireSock ficou desconhecido", { motivo: error });
                return { stopped: false, servicesResidual: current.services, processResidual: current.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
            }
            // Leitura ainda inconclusiva na ação manual: encerra os processos e
            // serviços WireSock listados e tenta de novo; o veredito final abaixo
            // só afirma parada com leitura confiável.
            log("warn", "restauração manual com leitura inconclusiva; nova tentativa", { motivo: current.reason || UNKNOWN_WIRESOCK_STATE, servicos: current.services, pids: current.processIds });
            for (const name of current.services) {
                if (!runAsAdministrator("sc.exe", ["stop", name], log))
                    log("warn", "não consegui solicitar parada do serviço WireSock", { servico: name, modo: "manual" });
            }
            if (current.processIds.length) killProcesses(current.processIds, "da restauração manual", log);
            continue;
        }
        if (!current.active) break;
        if (!current.owned) {
            const error = current.reason || "WireSock externo apareceu durante a limpeza";
            log("error", "limpeza interrompida ao detectar WireSock externo", { motivo: error });
            return { stopped: false, servicesResidual: current.services, processResidual: current.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
        }
        killOwnProcesses(current.processIds, log);
    }

    // Profiles omit DNS and disable network-lock. Config/PID ownership cannot
    // authorize a global lock or DNS reset, including for an external adapter down.
    const networkLockReset = false;
    const dnsCleared = false;
    const residual = await inspectWireSockUntilReliable(configPath);
    const stopped = residual.reliable && !residual.active;
    let dnsFlushed = false;
    if (stopped && initial.active && initial.owned) {
        try {
            execFileSync("ipconfig.exe", ["/flushdns"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
            dnsFlushed = true;
        } catch (error) {
            log("warn", "flushdns falhou", { erro: logError(error) });
        }
    }
    if (!stopped && !residual.reliable) log("error", "limpeza não confirmou o estado final do WireSock", { motivo: residual.reason || UNKNOWN_WIRESOCK_STATE });
    else if (!stopped) log("error", "limpeza deixou resíduo WireSock próprio", { services: residual.services, pids: residual.processIds });
    else log("info", "WireSock próprio parado; lock global e DNS de adaptadores foram preservados");
    return {
        stopped,
        servicesResidual: residual.services,
        processResidual: residual.processIds,
        networkLockReset,
        dnsCleared,
        dnsFlushed,
        ...(stopped ? {} : {
            error: !residual.reliable
                ? residual.reason || UNKNOWN_WIRESOCK_STATE
                : "O WireSock próprio ainda permanece ativo.",
        }),
    };
}

/**
 * Retomada gerenciada: encerra somente serviços e processos cuja config foi comprovada
 * como instância do GoLiveBypass (GUI ou pool de rotas dela) e libera o slot para o plugin.
 * Nunca toca em WireSock externo, em leitura desconhecida ou em mistura dos dois. Chamada
 * apenas pela ativação explícita do usuário, depois de o controller reservar o owner.lock.
 */
export async function stopManagedWireSock(configPath: string, guiConfigPath: string, log: WireSockLogger): Promise<WireSockCleanupResult> {
    if (!isWindows()) return { stopped: true, servicesResidual: [], processResidual: [], networkLockReset: false, dnsCleared: false, dnsFlushed: false };
    const initial = await inspectWireSockUntilReliable(configPath, guiConfigPath);
    if (!initial.reliable) {
        const error = initial.reason || UNKNOWN_WIRESOCK_STATE;
        log("warn", "retomada adiada porque o estado do WireSock é desconhecido", { motivo: error });
        return { stopped: false, servicesResidual: initial.services, processResidual: initial.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
    }
    if (!initial.active) return { stopped: true, servicesResidual: [], processResidual: [], networkLockReset: false, dnsCleared: false, dnsFlushed: false };
    if (initial.origin !== "gui" && initial.origin !== "managed") {
        const error = initial.reason || "WireSock externo detectado";
        log("warn", "retomada recusada para preservar WireSock não gerenciado", { motivo: error, origem: initial.origin });
        return { stopped: false, servicesResidual: initial.services, processResidual: initial.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
    }

    // Somente serviços comprovadamente gerenciados: no veredito "gui"/"managed" não existe
    // recurso externo, então a lista ativa é exatamente o conjunto encerrável.
    for (const name of initial.services) {
        if (!runAsAdministrator("sc.exe", ["stop", name], log)) {
            log("warn", "o Windows não autorizou parar o serviço WireSock gerenciado", { servico: name });
            return { stopped: false, servicesResidual: initial.services, processResidual: initial.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error: "O Windows não autorizou encerrar a instância anterior do GoLiveBypass." };
        }
    }
    let stopped = false;
    for (let attempt = 0; attempt < 2 && !stopped; attempt++) {
        await wait(500);
        const current = await inspectWireSockUntilReliable(configPath, guiConfigPath);
        if (!current.reliable) {
            const error = current.reason || UNKNOWN_WIRESOCK_STATE;
            log("error", "retomada interrompida porque o estado do WireSock ficou desconhecido", { motivo: error });
            return { stopped: false, servicesResidual: current.services, processResidual: current.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
        }
        if (!current.active) { stopped = true; break; }
        if (current.origin !== "gui" && current.origin !== "managed") {
            const error = current.reason || "WireSock externo apareceu durante a retomada";
            log("error", "retomada interrompida ao detectar WireSock não gerenciado", { motivo: error, origem: current.origin });
            return { stopped: false, servicesResidual: current.services, processResidual: current.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
        }
        killProcesses(current.processIds, "gerenciado", log);
    }
    if (!stopped) {
        const residual = await inspectWireSockUntilReliable(configPath, guiConfigPath);
        const error = residual.reliable && residual.active
            ? "A instância anterior do GoLiveBypass não encerrou; tente novamente."
            : residual.reason || UNKNOWN_WIRESOCK_STATE;
        log("error", "retomada não confirmou o encerramento da instância gerenciada", { services: residual.services, pids: residual.processIds });
        return { stopped: false, servicesResidual: residual.services, processResidual: residual.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
    }

    // A managed config/PID does not prove ownership of global lock/DNS state.
    const networkLockReset = false;
    const dnsCleared = false;
    let dnsFlushed = false;
    try {
        execFileSync("ipconfig.exe", ["/flushdns"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
        dnsFlushed = true;
    } catch (error) {
        log("warn", "flushdns falhou", { erro: logError(error) });
    }
    log("info", "WireSock da GUI GoLiveBypass encerrado; plugin assumiu o serviço", { networkLockReset });
    return { stopped: true, servicesResidual: [], processResidual: [], networkLockReset, dnsCleared, dnsFlushed };
}

function httpsCheck(url: string): Promise<boolean> {
    return new Promise(resolve => {
        const request = https.get(url, { timeout: 7000 }, response => {
            response.resume();
            response.once("end", () => resolve(true));
        });
        request.once("timeout", () => { request.destroy(); resolve(false); });
        request.once("error", () => resolve(false));
    });
}

export async function diagnoseWindowsNetwork(log: WireSockLogger): Promise<WindowsNetworkDiagnostic> {
    if (!isWindows()) return { ok: true, dnsOk: true, httpsOk: true, detail: "plataforma fora do escopo Windows" };
    const dnsOk = await Promise.all(["www.microsoft.com", "gateway.discord.gg", "updates.discord.com"].map(host => dns.lookup(host).then(() => true).catch(() => false))).then(results => results.every(Boolean));
    const httpsResults = await Promise.all([
        httpsCheck("https://www.microsoft.com/generate_204"),
        httpsCheck("https://discord.com/api/v9/gateway"),
        httpsCheck("https://updates.discord.com/"),
    ]);
    const httpsOk = httpsResults.some(Boolean);
    const result = { ok: dnsOk && httpsOk, dnsOk, httpsOk, detail: dnsOk && httpsOk ? "diagnóstico concluído" : "DNS/HTTPS apresentou falha" };
    log(result.ok ? "info" : "warn", "diagnóstico assíncrono da rede", { ...result, mode: "log-only" });
    return result;
}

const ROUTE_PROBE_BASENAME = /^\.golive-route-probe-\d+-\d+\.exe$/i;
const ROUTE_PROBE_REMOVE_RETRIES = 3;
const ROUTE_PROBE_REMOVE_RETRY_DELAY_MS = 200;
const ROUTE_PROBE_GRACE_MS = 60_000;

export type RouteProbeRemoval = "removed" | "missing" | "invalid" | "busy";

export interface RouteProbeCleanupResult {
    scanned: number;
    removed: number;
    protected: number;
    recent: number;
    invalid: number;
    busy: number;
}

function probePathKey(value: string): string {
    const resolved = path.resolve(value);
    return isWindows() ? resolved.toLowerCase() : resolved;
}

function probeErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== "object") return undefined;
    const { code } = (error as { code?: unknown });
    return typeof code === "string" ? code : undefined;
}

export function isManagedRouteProbePath(directory: string, candidate: string): boolean {
    const root = path.resolve(directory);
    const target = path.resolve(candidate);
    const relative = path.relative(root, target);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
    if (path.dirname(relative) !== ".") return false;
    return ROUTE_PROBE_BASENAME.test(path.basename(target));
}

export async function removeRouteProbe(directory: string, target: string): Promise<RouteProbeRemoval> {
    if (!isManagedRouteProbePath(directory, target)) return "invalid";
    try {
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink()) return "invalid";
    } catch (error) {
        return probeErrorCode(error) === "ENOENT" ? "missing" : "busy";
    }

    for (let attempt = 0; attempt < ROUTE_PROBE_REMOVE_RETRIES; attempt++) {
        try {
            // maxRetries/retryDelay only apply to recursive removal in Node.
            // Use explicit bounded attempts so an in-use Windows executable is
            // retried without ever enabling recursive deletion.
            fs.rmSync(target, { force: true });
            if (!fs.existsSync(target)) return "removed";
        } catch (error) {
            if (probeErrorCode(error) === "ENOENT") return "missing";
        }
        if (attempt + 1 < ROUTE_PROBE_REMOVE_RETRIES)
            await new Promise<void>(resolve => setTimeout(resolve, ROUTE_PROBE_REMOVE_RETRY_DELAY_MS));
    }
    return "busy";
}

export async function cleanupRouteProbes(
    directory: string,
    protectedPaths: readonly string[] = [],
    now = Date.now(),
    graceMs = ROUTE_PROBE_GRACE_MS,
): Promise<RouteProbeCleanupResult> {
    const result: RouteProbeCleanupResult = { scanned: 0, removed: 0, protected: 0, recent: 0, invalid: 0, busy: 0 };
    const protectedSet = new Set(
        protectedPaths.filter(candidate => isManagedRouteProbePath(directory, candidate)).map(probePathKey),
    );
    let entries: string[];
    try {
        entries = fs.readdirSync(directory);
    } catch {
        return result;
    }

    for (const name of entries) {
        if (!ROUTE_PROBE_BASENAME.test(name)) continue;
        result.scanned++;
        const target = path.join(directory, name);
        if (protectedSet.has(probePathKey(target))) {
            result.protected++;
            continue;
        }

        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(target);
        } catch {
            result.busy++;
            continue;
        }
        if (!stat.isFile() || stat.isSymbolicLink()) {
            result.invalid++;
            continue;
        }
        if (now - stat.mtimeMs < graceMs) {
            result.recent++;
            continue;
        }

        switch (await removeRouteProbe(directory, target)) {
            case "removed": result.removed++; break;
            case "missing": break;
            case "invalid": result.invalid++; break;
            case "busy": result.busy++; break;
        }
    }
    return result;
}

export function routeProbeExecutablePath(directory: string): string {
    return path.join(directory, `.golive-route-probe-${process.pid}-${Date.now()}.exe`);
}

export function copyRouteProbe(source: string, target: string): void {
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("Helper de diagnóstico Proton não encontrado.");
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

export function runRouteProbe(executable: string): Promise<Record<string, unknown> | null> {
    try {
        const stat = fs.lstatSync(executable);
        if (!stat.isFile() || stat.isSymbolicLink() || !isManagedRouteProbePath(path.dirname(executable), executable))
            return Promise.resolve(null);
    } catch {
        return Promise.resolve(null);
    }
    return new Promise(resolve => {
        execFile(executable, ["-route-probe"], { windowsHide: true, timeout: 12_000, encoding: "utf8" }, (_error, stdout) => {
            try {
                const parsed = JSON.parse(String(stdout).trim()) as unknown;
                return resolve(parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : null);
            } catch {
                return resolve(null);
            }
        });
    });
}

export function isWireSockPacketFilterDriverInstalled(): boolean {
    if (!isWindows()) return false;
    return WIRESOCK_DRIVER_NAMES.some(name => {
        try {
            const output = execFileSync("sc.exe", ["query", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000 });
            return !/\b1060\b/.test(output);
        } catch {
            return false;
        }
    });
}
