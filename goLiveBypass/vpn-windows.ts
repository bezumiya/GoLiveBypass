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

export const WIRESOCK_VERSION = "3.4.8.1";
const WIRESOCK_DOWNLOAD = "https://wiresock.net/_api/download-release.php?product=wiresock-secure-connect-sdk&platform=x64&version=3.4.8.1&channel=winget";
const WIRESOCK_INSTALLER_SHA256 = "abfeebdc645de36b95fabbed00c7fdb0bf4d0c68c5518608450619c61876d33e";
const WIRESOCK_DRIVER_NAMES = ["ndiswg", "NDISRD"] as const;
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
}

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

function serviceRunning(name: string): boolean | null {
    if (!isWindows()) return false;
    const cimState = serviceRunningFromCim(name);
    if (cimState !== null) return cimState;
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

function serviceProcessId(name: string): number | null {
    if (!isWindows() || serviceRunning(name) !== true) return null;
    try {
        const script = `$s=Get-CimInstance Win32_Service -Filter "Name='${name.replace(/'/g, "''")}'"; if($s){$s.ProcessId}`;
        const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        }).trim();
        const pid = Number(output);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
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
    if (!command || !containsConfig(command, configPath))
        throw new Error("O serviço WireSock já está registrado com outro perfil (possivelmente pela GUI ou por outro plugin). Desative-o antes de usar a VPN do plugin.");
}

function runningWireSockProcesses(): Array<{ pid: number; commandLine: string | null }> | null {
    if (!isWindows()) return [];
    try {
        const script = "$p=Get-CimInstance Win32_Process -Filter \"Name='wiresock-client.exe'\" | ForEach-Object { [PSCustomObject]@{pid=[int]$_.ProcessId; commandLine=$_.CommandLine} }; $p | ConvertTo-Json -Compress";
        const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        }).trim();
        if (!output) return [];
        const parsed = JSON.parse(output) as unknown;
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows.flatMap(row => {
            if (row === null || typeof row !== "object") return [];
            const value = row as { pid?: unknown; commandLine?: unknown };
            const pid = Number(value.pid);
            if (!Number.isInteger(pid) || pid <= 0) return [];
            return [{ pid, commandLine: typeof value.commandLine === "string" ? value.commandLine : null }];
        });
    } catch {
        return null;
    }
}

export function inspectWireSock(configPath?: string): WireSockInspection {
    if (!isWindows()) return { active: false, owned: false, reliable: true, services: [], processIds: [], reason: null };
    const serviceStates = VPN_SERVICE_NAMES.map(name => ({ name, running: serviceRunning(name) }));
    const services = serviceStates.filter(service => service.running === true).map(service => service.name);
    const processSnapshot = runningWireSockProcesses();
    const processes = processSnapshot ?? [];
    const processIds = processes.map(process => process.pid);
    const serviceStateReliable = serviceStates.every(service => service.running !== null);
    const reliable = serviceStateReliable && processSnapshot !== null;
    if (!reliable) {
        return {
            // Uma leitura incompleta não prova nem presença nem ausência. Não
            // a exponha como ativa, pois isso faria o controller classificá-la
            // incorretamente como um WireSock externo.
            active: false,
            owned: false,
            reliable: false,
            services,
            processIds,
            reason: UNKNOWN_WIRESOCK_STATE,
        };
    }
    const active = services.length > 0 || processes.length > 0;
    if (!active) return { active: false, owned: false, reliable: true, services: [], processIds: [], reason: null };
    if (!configPath) return { active, owned: false, reliable: true, services, processIds, reason: "WireSock já está ativo fora do perfil do plugin." };

    const commands = new Map(services.map(name => [name, serviceCommand(name)]));
    if ([...commands.values()].some(command => command === null)) {
        return {
            active: false,
            owned: false,
            reliable: false,
            services,
            processIds,
            reason: "Não foi possível confirmar o perfil do serviço WireSock; estado desconhecido.",
        };
    }
    const ownService = services.filter(name => containsConfig(commands.get(name) ?? null, configPath));
    const ownServiceProcessIds = new Set(ownService.map(serviceProcessId).filter((pid): pid is number => pid !== null));
    const processOwnershipReliable = processes.every(process =>
        (typeof process.commandLine === "string" && process.commandLine.trim().length > 0)
        || ownServiceProcessIds.has(process.pid));
    if (!processOwnershipReliable) {
        return {
            active: false,
            owned: false,
            reliable: false,
            services,
            processIds,
            reason: "Não foi possível confirmar o perfil do processo WireSock; estado desconhecido.",
        };
    }
    const ownProcess = processes.filter(process =>
        containsConfig(process.commandLine, configPath) || ownServiceProcessIds.has(process.pid));
    const allServicesOwned = services.every(name => containsConfig(commands.get(name) ?? null, configPath));
    const allProcessesOwned = processes.every(process =>
        containsConfig(process.commandLine, configPath) || ownServiceProcessIds.has(process.pid));
    if ((ownService.length > 0 || ownProcess.length > 0) && allServicesOwned && allProcessesOwned)
        return { active, owned: true, reliable: true, services, processIds, reason: null };
    return {
        active,
        owned: false,
        reliable: true,
        services,
        processIds,
        reason: ownService.length > 0 || ownProcess.length > 0
            ? "WireSock próprio e externo foram detectados ao mesmo tempo; a operação foi bloqueada."
            : "WireSock já está ativo por outro perfil, pela GUI ou por outro plugin.",
    };
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

function runElevatedInstaller(installer: string): Promise<void> {
    const command = `try { $p=Start-Process -FilePath ${quotePowerShell(installer)} -ArgumentList @('/quiet','/norestart') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; if($null -eq $p){ exit 1223 }; exit [int]$p.ExitCode } catch { if($_.Exception.NativeErrorCode -eq 1223){ exit 1223 }; Write-Error $_; exit 1 }`;
    return new Promise((resolve, reject) => {
        const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
            windowsHide: true,
            timeout: 120_000,
        }, error => error ? reject(error) : resolve());
        child.once("error", reject);
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
        log("info", "instalando WireSock com elevação do Windows");
        await runElevatedInstaller(installer);
        const installed = findWireSockCandidate();
        if (!installed) throw new Error("O instalador WireSock terminou, mas não deixou uma instalação SDK compatível.");
        return installed.executable;
    } catch (error) {
        const code = Number((error as { code?: unknown })?.code);
        if (code === 1223) throw new Error("A instalação do WireSock foi cancelada pelo usuário.");
        throw new Error(`Não foi possível preparar o WireSock: ${logError(error)}`);
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
    clearWireSockDns(log);
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

function resetNetworkLock(executable: string, log: WireSockLogger): boolean {
    if (runAsAdministrator(executable, ["reset-network-lock"], log)) return true;
    return false;
}

export function clearWireSockDns(log: WireSockLogger): boolean {
    if (!isWindows()) return true;
    try {
        const script = "Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -match 'ProTUN|WireSock' -or $_.InterfaceDescription -match 'ProTUN|WireSock' } | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses -ErrorAction SilentlyContinue }";
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
        return true;
    } catch (error) {
        log("warn", "não consegui limpar DNS do adaptador WireSock", { erro: logError(error) });
        return false;
    }
}

function killOwnProcesses(processIds: number[], log: WireSockLogger): void {
    for (const pid of processIds) {
        if (!runAsAdministrator("taskkill.exe", ["/F", "/T", "/PID", String(pid)], log))
            log("warn", "não consegui encerrar processo WireSock próprio", { pid });
    }
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function stopOwnedWireSock(configPath: string, log: WireSockLogger): Promise<WireSockCleanupResult> {
    if (!isWindows()) return { stopped: true, servicesResidual: [], processResidual: [], networkLockReset: false, dnsCleared: false, dnsFlushed: false };
    const initial = inspectWireSock(configPath);
    if (!initial.reliable) {
        const error = initial.reason || UNKNOWN_WIRESOCK_STATE;
        log("warn", "limpeza adiada porque o estado do WireSock é desconhecido", { motivo: error });
        return { stopped: false, servicesResidual: initial.services, processResidual: initial.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
    }
    if (initial.active && !initial.owned) {
        const error = initial.reason || "WireSock externo detectado";
        log("warn", "limpeza recusada para preservar WireSock externo", { motivo: error });
        return { stopped: false, servicesResidual: initial.services, processResidual: initial.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
    }

    for (const name of initial.services) {
        if (containsConfig(serviceCommand(name), configPath)) {
            if (!runAsAdministrator("sc.exe", ["stop", name], log))
                log("warn", "não consegui solicitar parada do serviço WireSock próprio", { servico: name });
        }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
        await wait(500);
        const current = inspectWireSock(configPath);
        if (!current.reliable) {
            const error = current.reason || UNKNOWN_WIRESOCK_STATE;
            log("error", "limpeza interrompida porque o estado do WireSock ficou desconhecido", { motivo: error });
            return { stopped: false, servicesResidual: current.services, processResidual: current.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
        }
        if (!current.active) break;
        if (!current.owned) {
            const error = current.reason || "WireSock externo apareceu durante a limpeza";
            log("error", "limpeza interrompida ao detectar WireSock externo", { motivo: error });
            return { stopped: false, servicesResidual: current.services, processResidual: current.processIds, networkLockReset: false, dnsCleared: false, dnsFlushed: false, error };
        }
        killOwnProcesses(current.processIds, log);
    }

    const executable = findWireSockCandidate()?.executable;
    // O lock de rede pertence à instância que acabamos de confirmar como nossa.
    // Resetá-lo mesmo depois de o processo sumir fecha o caso de parada tardia.
    const networkLockReset = executable ? resetNetworkLock(executable, log) : false;
    const dnsCleared = clearWireSockDns(log);
    let dnsFlushed = false;
    try {
        execFileSync("ipconfig.exe", ["/flushdns"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
        dnsFlushed = true;
    } catch (error) {
        log("warn", "flushdns falhou", { erro: logError(error) });
    }
    const residual = inspectWireSock(configPath);
    // O veredito e' o mesmo da GUI (electron/wiresock.ts: `!isWireSockActive() && residual.length === 0`)
    // e o mesmo que o README promete: o tunel acabou quando servico E processos proprios
    // sumiram, com leitura confiavel. `active` cobre exatamente esses dois (services/processIds);
    // o network-lock nao entra.
    //
    // O reset do network-lock continua sendo TENTADO logo acima e reportado no resultado, mas
    // nao decide mais nada: ele exige elevacao (UAC) e a config do plugin instala o servico com
    // "-network-lock disabled" (vpn-windows.ts:469/477, confirmado por
    // tests/test-distribution-parity.cjs), entao a nossa sessao nunca engata esse lock. Exigi-lo
    // fazia a limpeza falhar em maquina onde o UAC nao era aceito no momento da saida -- com o
    // tunel ja derrubado e a rede restaurada --, o que virava recovery_required, mantinha o
    // lock do plugin e (antes da correcao do before-quit) deixava o Discord preso sem janela.
    const stopped = residual.reliable && !residual.active;
    if (!stopped && !residual.reliable) log("error", "limpeza não confirmou o estado final do WireSock", { motivo: residual.reason || UNKNOWN_WIRESOCK_STATE });
    else if (!stopped) log("error", "limpeza deixou resíduo WireSock próprio", { services: residual.services, pids: residual.processIds });
    else if (networkLockReset) log("info", "WireSock próprio, lock e processo verificados como parados");
    else log("warn", "WireSock próprio parado (serviço e processos); o reset do network-lock não foi confirmado -- exige elevação e o plugin não habilita esse lock", { networkLockReset });
    return {
        stopped,
        servicesResidual: residual.services,
        processResidual: residual.processIds,
        networkLockReset,
        dnsCleared,
        dnsFlushed,
        // So ha erro quando o veredito falhou. O reset do network-lock nao entra aqui: virou
        // aviso, porque nao diz nada sobre o tunel ter parado.
        ...(stopped ? {} : {
            error: !residual.reliable
                ? residual.reason || UNKNOWN_WIRESOCK_STATE
                : "O WireSock próprio ainda permanece ativo.",
        }),
    };
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
