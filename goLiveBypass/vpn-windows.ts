import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import https from "https";
import { promises as dns } from "dns";
import { execFile, execFileSync } from "child_process";

import {
    VPN_SERVICE_NAMES,
    formatAllowedApps,
    safeDiagnosticDetail,
    sanitizeWireGuardConfig,
    validateWireGuardConfig,
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
    services: string[];
    processIds: number[];
    reason: string | null;
}

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
        return value ? /^Running$/i.test(value) : null;
    } catch {
        return null;
    }
}

function serviceRunning(name: string): boolean {
    if (!isWindows()) return false;
    const cimState = serviceRunningFromCim(name);
    if (cimState !== null) return cimState;
    try {
        const output = execFileSync("sc.exe", ["query", name], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000,
        });
        return /STATE\s*:\s*\d+\s+RUNNING/i.test(output);
    } catch {
        return false;
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
    if (!isWindows() || !serviceRunning(name)) return null;
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
    if (!serviceRunning(name)) return;
    const command = serviceCommand(name);
    if (!command || !containsConfig(command, configPath))
        throw new Error("O serviço WireSock já está registrado com outro perfil (possivelmente pela GUI ou por outro plugin). Desative-o antes de usar a VPN do plugin.");
}

function runningWireSockProcesses(): Array<{ pid: number; commandLine: string | null }> {
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
        return [];
    }
}

export function inspectWireSock(configPath?: string): WireSockInspection {
    if (!isWindows()) return { active: false, owned: false, services: [], processIds: [], reason: null };
    const services = VPN_SERVICE_NAMES.filter(serviceRunning);
    const processes = runningWireSockProcesses();
    const processIds = processes.map(process => process.pid);
    const active = services.length > 0 || processes.length > 0;
    if (!active) return { active: false, owned: false, services: [], processIds: [], reason: null };
    if (!configPath) return { active, owned: false, services, processIds, reason: "WireSock já está ativo fora do perfil do plugin." };

    const ownService = services.filter(name => containsConfig(serviceCommand(name), configPath));
    const ownServiceProcessIds = new Set(ownService.map(serviceProcessId).filter((pid): pid is number => pid !== null));
    const ownProcess = processes.filter(process =>
        containsConfig(process.commandLine, configPath) || ownServiceProcessIds.has(process.pid));
    const allServicesOwned = services.every(name => containsConfig(serviceCommand(name), configPath));
    const allProcessesOwned = processes.every(process =>
        containsConfig(process.commandLine, configPath) || ownServiceProcessIds.has(process.pid));
    if ((ownService.length > 0 || ownProcess.length > 0) && allServicesOwned && allProcessesOwned)
        return { active, owned: true, services, processIds, reason: null };
    return {
        active,
        owned: false,
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
    const stopped = !residual.active && networkLockReset;
    if (stopped) log("info", "WireSock próprio, lock e processo verificados como parados");
    else if (residual.active) log("error", "limpeza deixou resíduo WireSock próprio", { services: residual.services, pids: residual.processIds });
    else log("error", "processo WireSock parou, mas o network-lock não foi confirmado como restaurado");
    return {
        stopped,
        servicesResidual: residual.services,
        processResidual: residual.processIds,
        networkLockReset,
        dnsCleared,
        dnsFlushed,
        ...(stopped ? {} : { error: residual.active ? "O WireSock próprio ainda permanece ativo." : "Não foi possível confirmar a restauração do network-lock do WireSock." }),
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

export function routeProbeExecutablePath(directory: string): string {
    return path.join(directory, `.golive-route-probe-${process.pid}-${Date.now()}.exe`);
}

export function copyRouteProbe(source: string, target: string): void {
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("Helper de diagnóstico Proton não encontrado.");
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

export function removeRouteProbe(target: string): void {
    try { fs.rmSync(target, { force: true }); } catch {}
}

export function runRouteProbe(executable: string): Promise<Record<string, unknown> | null> {
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
