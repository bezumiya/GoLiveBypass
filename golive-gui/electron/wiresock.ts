import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { execFile, execFileSync, execSync } from "child_process";
import dns from "dns/promises";
import https from "https";
import * as logger from "./logger";
import { elevatedPowerShellFileArgs, wireSockDirectScript, wireSockServiceScript } from "./wiresock-service";
import { enumerateWireSockCandidatesAsync, selectSupportedWireSock } from "./wiresock-preflight";

const EMBEDDED_WG_CONF = `[Interface]
PrivateKey = sLPBSsrhzoqZSOY/XxAzGAy5F+sQKQIIE3WoxG8buWM=
Address = 10.2.0.2/32
DNS = 10.2.0.1

[Peer]
# MX-FREE#16
PublicKey = mkI+cC9ggzfMdZy1cl3Fl01gPJJxsLXjshXAN8EedQ8=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 84.20.27.53:51820
PersistentKeepalive = 25
`;

const WIRESOCK_OFFICIAL_DOWNLOAD = "https://wiresock.net/_api/download-release.php?product=wiresock-secure-connect-sdk&platform={platform}&version=3.4.8.1&channel=winget";
const WIRESOCK_INSTALLER_HASHES: Record<string, string> = {
  x64: "abfeebdc645de36b95fabbed00c7fdb0bf4d0c68c5518608450619c61876d33e",
  x86: "53c8b434482043b2eb734d05595fb357ce87460dc60f49c79f57011d655539b0",
  arm64: "62f641a19c2d4a89ce58ba4c0539166982fb89373aef3c87b66fea33e26db311",
};
const WIRESOCK_SERVICE_NAMES = ["wiresock-client-service", "wiresock-pro-client-service"] as const;
// O SDK 3.4.x instala o filtro WireGuard como `ndiswg`; releases antigas do
// mecanismo por aplicativo expunham `NDISRD`. Ambos são nomes oficiais vistos
// em campo. A prova funcional é apenas diagnóstico, sem bloquear a ativação.
const WIRESOCK_DRIVER_SERVICE_NAMES = ["ndiswg", "NDISRD"] as const;
let wiresockRebootPending = false;

export type WireSockConnectionState = "connected" | "connecting" | "disconnected" | "unknown";

export interface WireSockConnectionStatus {
  state: WireSockConnectionState;
  verified: boolean;
  source: "cli" | "service" | "none";
  externalAddress?: string;
  detail?: string;
}

export interface WireSockAdapterTraffic {
  adapter: string;
  receivedBytes: number;
  sentBytes: number;
}

// No split tunnel o processo da GUI fica fora de AllowedApps. Portanto, o
// crescimento destes contadores depois de o Discord abrir e' a evidencia que
// realmente pertence ao tunel, ao contrario de um HTTPS feito pela propria GUI.
export function hasWireSockAdapterTrafficIncrease(
  previous: WireSockAdapterTraffic | null,
  current: WireSockAdapterTraffic | null,
): boolean {
  return Boolean(
    previous && current &&
    current.receivedBytes > previous.receivedBytes &&
    current.sentBytes > previous.sentBytes,
  );
}

function detalheErro(err: unknown): string {
  const texto = String((err as { stderr?: string; stdout?: string; message?: string })?.stderr ||
    (err as { stdout?: string })?.stdout ||
    (err as { message?: string })?.message || err)
    .replace(/\s+/g, " ").trim();
  return texto.slice(0, 500) || "sem detalhes retornados pelo Windows";
}

export type WireSockActivationFailureKind =
  | "permission"
  | "driver"
  | "timeout"
  | "process"
  | "profile"
  | "service"
  | "unknown";

export interface WireSockActivationFailure {
  kind: WireSockActivationFailureKind;
  code: string;
  message: string;
}

export type WireSockDirectResult =
  | { kind: "running"; pid: number; detail: string }
  | { kind: "unsupported"; code: string; detail: string }
  | { kind: "failed"; code: string; detail: string };

/**
 * O serviço só é compatibilidade para versões do WireSock que não conhecem o
 * comando oficial run. Falhas de UAC, driver, perfil ou processo encerrado
 * não podem cair silenciosamente no serviço global: esse era o caminho que
 * marcava a GUI como ativa sem capturar o Discord.
 */
export function classifyWireSockDirectResult(detail: string): WireSockDirectResult {
  const normalized = detalheErro(detail);
  const running = normalized.match(/DIRECT_RUNNING:\s*pid=(\d+)/i);
  if (running) {
    return { kind: "running", pid: Number(running[1]), detail: normalized };
  }
  if (/DIRECT_UNSUPPORTED|RUN_NOT_SUPPORTED|UNKNOWN_COMMAND|unknown\s+(?:command|option)|unrecognized\s+(?:command|option)|(?:run|application mode).{0,24}(?:not supported|unsupported)|comando\s+desconhecido|op[cç][aã]o\s+n[aã]o\s+reconhecida|par[aâ]metro\s+n[aã]o\s+reconhecido|not\s+recognized/i.test(normalized)) {
    return { kind: "unsupported", code: "WIRESOCK_DIRECT_UNSUPPORTED", detail: normalized };
  }
  if (/DIRECT_EXITED:\s*codigo=0\b/i.test(normalized)) {
    return { kind: "failed", code: "WIRESOCK_DIRECT_EXITED_0", detail: normalized };
  }
  return { kind: "failed", code: "WIRESOCK_DIRECT_FAILED", detail: normalized };
}

export function mayUseServiceCompatibility(result: WireSockDirectResult): boolean {
  return result.kind === "unsupported";
}

/**
 * The service helper deliberately returns a small marker instead of exposing
 * a PowerShell exception to the renderer. Windows localizes SCM/UAC errors,
 * so classification accepts both the marker and the common English/Portuguese
 * forms while keeping the detailed text only in the log.
 */
export function classifyWireSockActivationFailure(error: unknown): WireSockActivationFailure {
  const raw = detalheErro(error).toLowerCase();
  if (/uac|runas|access(?: is)? denied|acesso negado|permission|permiss[aã]o|cancel(?:led|ed)|cancelad|1223|740/.test(raw)) {
    return {
      kind: "permission",
      code: "WIRESOCK_PERMISSION",
      message: "O Windows não autorizou a ativação do WireSock. Aceite a solicitação de administrador e tente novamente.",
    };
  }
  if (/driver|ndiswg|ndisrd|filter|filtro|reboot|reinici|1061/.test(raw)) {
    return {
      kind: "driver",
      code: "WIRESOCK_DRIVER",
      message: "O componente de rede do WireSock ainda não está pronto. Reinicie o Windows e tente ativar novamente.",
    };
  }
  if (!/wiresock_direct|direct_exited|direct_failed|processo direto/.test(raw) &&
    /stop_timeout|timeout|timed out|tempo limite|stop_pending|pendente|1053/.test(raw)) {
    return {
      kind: "timeout",
      code: "WIRESOCK_TIMEOUT",
      message: "O serviço WireSock não respondeu a tempo. Feche outros clientes VPN e tente ativar novamente.",
    };
  }
  if (/direct_exited|direct_failed|wiresock_direct|processo direto|process.*exited|process.*encerr/.test(raw)) {
    return {
      kind: "process",
      code: "WIRESOCK_PROCESS",
      message: "O WireSock encerrou durante a ativação. Verifique o perfil e tente novamente; os detalhes foram registrados no diagnóstico.",
    };
  }
  if (/config_failed|profile|perfil|wireguard|allowedapps|caminho|path|invalid|inv[aá]lid/.test(raw)) {
    return {
      kind: "profile",
      code: "WIRESOCK_PROFILE",
      message: "O perfil WireGuard selecionado não pôde ser aplicado. Selecione ou gere o perfil novamente e tente ativar.",
    };
  }
  if (/install_failed|service_missing|start_failed|openservice failed|servi[cç]o (?:ausente|desabilitado|n[aã]o encontrado)|1058|1060/.test(raw)) {
    return {
      kind: "service",
      code: "WIRESOCK_SERVICE",
      message: "O serviço WireSock não pôde ser instalado ou iniciado. Reinstale o GoLiveBypass e tente novamente.",
    };
  }
  return {
    kind: "unknown",
    code: "WIRESOCK_UNKNOWN",
    message: "O Windows não conseguiu iniciar a rota WireSock. A rede foi restaurada; tente novamente ou envie os logs.",
  };
}

export function wireSockInstallerExitKind(error: unknown): "reboot" | "cancel" | "failure" {
  const code = Number((error as { code?: unknown })?.code);
  if (code === 3010 || code === 1641) return "reboot";
  if (code === 1223 || /cancel(?:led|ed)|user.?declin|recus/i.test(detalheErro(error))) return "cancel";
  return "failure";
}

function wireSockBootTime(): number {
  return Date.now() - Math.round(os.uptime() * 1000);
}

function wireSockRebootMarker(): string {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
  return path.join(base, "GoLiveBypass", "wiresock-reboot-pending.json");
}

function assertNoPendingWireSockReboot(): void {
  if (wiresockRebootPending) throw new Error("O WireSock solicitou reinicialização; reinicie o Windows antes de tentar novamente.");
  const marker = wireSockRebootMarker();
  try {
    const saved = JSON.parse(fs.readFileSync(marker, "utf8")) as { lastBootUpTime?: unknown };
    const previous = Number(saved.lastBootUpTime);
    if (Number.isFinite(previous) && Math.abs(previous - wireSockBootTime()) < 60_000) {
      wiresockRebootPending = true;
      throw new Error("O WireSock solicitou reinicialização; reinicie o Windows antes de tentar novamente.");
    }
    fs.unlinkSync(marker);
  } catch (error) {
    if (error instanceof Error && /solicitou reinicialização/.test(error.message)) throw error;
  }
}

function markWireSockRebootPending(): never {
  wiresockRebootPending = true;
  const marker = wireSockRebootMarker();
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ lastBootUpTime: wireSockBootTime() }), "utf8");
  } catch (error) {
    logger.warn("wiresock", "nao consegui persistir reboot pendente", { erro: detalheErro(error) });
  }
  throw new Error("O instalador WireSock solicitou reinicialização (código 3010/1641). Reinicie o Windows e tente ativar novamente.");
}

function wireSockPlatform(): { hash: keyof typeof WIRESOCK_INSTALLER_HASHES; query: "x64" | "x86" | "ARM64" } {
  if (process.arch === "ia32") return { hash: "x86", query: "x86" };
  if (process.arch === "arm64") return { hash: "arm64", query: "ARM64" };
  if (process.arch === "x64") return { hash: "x64", query: "x64" };
  throw new Error(`Arquitetura Windows não suportada para WireSock: ${process.arch}`);
}

function downloadOfficialWireSock(platform: "x64" | "x86" | "ARM64", target: string): Promise<void> {
  const start = WIRESOCK_OFFICIAL_DOWNLOAD.replace("{platform}", platform);
  const maxBytes = 512 * 1024 * 1024;
  const request = (url: string, redirects = 0): Promise<void> => new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { reject(new Error("URL oficial do WireSock inválida")); return; }
    if (parsed.protocol !== "https:" || !/(^|\.)wiresock\.net$/i.test(parsed.hostname)) {
      reject(new Error("Redirecionamento para host não autorizado do instalador WireSock")); return;
    }
    const req = https.get(parsed, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 3) { reject(new Error("Muitos redirecionamentos no instalador WireSock")); return; }
        request(new URL(response.headers.location, parsed).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Download WireSock retornou HTTP ${response.statusCode ?? "desconhecido"}`)); return; }
      const output = fs.createWriteStream(target, { flags: "wx" });
      let total = 0;
      let settled = false;
      const abort = (error: Error) => {
        if (settled) return;
        settled = true;
        response.destroy(); output.destroy(); req.destroy(); reject(error);
      };
      response.on("data", (chunk: Buffer) => { total += chunk.length; if (total > maxBytes) abort(new Error("Instalador WireSock excede o limite de tamanho")); });
      response.on("error", abort); output.on("error", abort);
      response.pipe(output);
      output.on("finish", () => output.close((error) => { if (error) abort(error); else if (!settled) { settled = true; resolve(); } }));
    });
    req.setTimeout(120_000, () => req.destroy(new Error("Timeout ao baixar o instalador WireSock")));
    req.on("error", reject);
  });
  return request(start);
}

async function installOfficialWireSock(onProgress?: (message: string) => void): Promise<string> {
  const platform = wireSockPlatform();
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "golive-wiresock-"));
  const installer = path.join(tempDir, "wiresock-sdk.exe");
  try {
    onProgress?.("Baixando o instalador oficial do WireSock…");
    await downloadOfficialWireSock(platform.query, installer);
    const hash = await new Promise<string>((resolve, reject) => {
      const digest = crypto.createHash("sha256"); const input = fs.createReadStream(installer);
      input.on("data", (chunk) => digest.update(chunk)); input.on("error", reject); input.on("end", () => resolve(digest.digest("hex")));
    });
    if (hash.toLowerCase() !== WIRESOCK_INSTALLER_HASHES[platform.hash]) throw new Error("Hash do instalador WireSock não corresponde ao release oficial fixado.");
    onProgress?.("Instalando o WireSock SDK validado…");
    const file = installer.replace(/'/g, "''");
    const command = `try { $p=Start-Process -FilePath '${file}' -ArgumentList @('/quiet','/norestart') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; if($null -eq $p){ exit 1223 }; exit [int]$p.ExitCode } catch { $c=$_.Exception.HResult; if($c -eq -2147023673 -or $_.Exception.NativeErrorCode -eq 1223){ exit 1223 }; Write-Error $_; exit 1 }`;
    await new Promise<void>((resolve, reject) => {
      const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true }, (error) => error ? reject(error) : resolve());
      child.once("error", reject);
    }).catch((error) => {
      const kind = wireSockInstallerExitKind(error);
      if (kind === "reboot") markWireSockRebootPending();
      if (kind === "cancel") throw new Error("A instalação do WireSock foi cancelada pelo usuário; nenhuma tentativa adicional foi executada.");
      throw error;
    });
    const selected = await findCompatibleWireSockAsync();
    if (!selected) throw new Error("O instalador oficial terminou, mas não deixou um par WireSock SDK compatível.");
    return selected;
  } finally {
    try { await fs.promises.rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

export function wireSockDriverQueryShowsInstalled(output: string): boolean {
  return /SERVICE_NAME:\s*(?:ndiswg|NDISRD)\b/i.test(output) && !/\b1060\b/.test(output);
}

export function isWireSockPacketFilterDriverInstalled(): boolean {
  if (process.platform !== "win32") return false;
  return WIRESOCK_DRIVER_SERVICE_NAMES.some((name) => {
    try {
      const output = execSync(`sc.exe query ${name}`, {
        stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsHide: true,
      });
      return wireSockDriverQueryShowsInstalled(output);
    } catch {
      return false;
    }
  });
}

export function isWireSockRunning(): boolean {
  if (process.platform !== "win32") return false;
  return WIRESOCK_SERVICE_NAMES.some((name) => {
    try {
      const out = execSync(`sc.exe query ${name}`, {
        stdio: ["pipe", "pipe", "ignore"],
        encoding: "utf8",
        windowsHide: true,
      });
      return /STATE\s*:\s*\d+\s+RUNNING/i.test(out);
    } catch {
      return false;
    }
  });
}

// O fallback de startWireSockService roda o wiresock-client.exe direto (sem servico), entao
// isWireSockRunning() (que so olha o servico) nunca o enxerga. Confirma pelo processo.
function isWireSockProcessAlive(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq wiresock-client.exe"', {
      stdio: ["pipe", "pipe", "ignore"],
      encoding: "utf8",
      windowsHide: true,
    });
    return out.toLowerCase().includes("wiresock-client.exe");
  } catch {
    return false;
  }
}

function isWireSockProcessPidAlive(pid: number): boolean {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    const out = execSync('tasklist /FI "PID eq ' + pid + '"', {
      stdio: ["pipe", "pipe", "ignore"],
      encoding: "utf8",
      windowsHide: true,
    });
    return new RegExp("wiresock-client\\.exe\\s+" + pid + "\\b", "i").test(out);
  } catch {
    return false;
  }
}

async function esperarProcessoWireSock(pid: number, tentativas: number, intervaloMs: number): Promise<boolean> {
  for (let i = 0; i < tentativas; i++) {
    if (isWireSockProcessPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  return isWireSockProcessPidAlive(pid);
}

// Fonte de verdade de "o tunel esta de pe", pro getStatus() da GUI usar -- ao contrario de
// isWireSockRunning() (so servico), cobre tambem o fallback sem servico do startWireSockService.
export function isWireSockActive(): boolean {
  return isWireSockRunning() || isWireSockProcessAlive();
}

export function parseWireSockCliStatus(output: string): WireSockConnectionState {
  const text = output.trim().toLowerCase();
  if (/\bconnected\b/.test(text)) return "connected";
  if (/\b(connecting|disconnecting)\b/.test(text)) return "connecting";
  if (/\b(notconnected|not connected|disconnected)\b/.test(text)) return "disconnected";
  return "unknown";
}

export function parseWireSockCliExternalAddress(output: string): string | undefined {
  // A CLI oficial informa o IP externo quando o túnel concluiu o handshake.
  // Aceitamos IPv4/IPv6 sem confiar em texto localizado ao redor do campo.
  const match = output.match(/(?:external\s+address|endereço\s+externo|external\s+ip)\s*[:=]\s*([0-9a-f:.]{3,})/i);
  return match?.[1];
}

export function findWireSockCli(): string | null {
  const programFiles = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    "C:\\Program Files",
  ].filter((dir): dir is string => Boolean(dir));
  for (const dir of [...new Set(programFiles)]) {
    for (const name of ["wiresock-connect-cli.exe", "wiresock-cli.exe"]) {
      const candidate = path.join(dir, "WireSock Secure Connect", "sdk", name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const name of ["wiresock-connect-cli.exe", "wiresock-cli.exe"]) {
    try {
      const out = execSync(`where ${name}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      const firstLine = out.split(/\r?\n/)[0]?.trim();
      if (firstLine && fs.existsSync(firstLine)) return firstLine;
    } catch {}
  }
  return null;
}

const WIRESOCK_EXECUTABLE_NAMES = ["wiresock-client.exe"] as const;

/**
 * Returns only installation roots that are plausible for the official winget
 * package. This deliberately does not search the whole disk.
 */
export function wireSockSearchRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const programFiles = [
    env.ProgramW6432,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    "C:\\Program Files",
  ].filter((dir): dir is string => Boolean(dir));
  const roots = new Set<string>();
  for (const dir of programFiles) {
    roots.add(path.join(dir, "WireSock Secure Connect"));
  }
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) roots.add(path.join(localAppData, "Microsoft", "WinGet", "Packages"));
  return [...roots];
}

export function findWireSockInKnownRoots(env: NodeJS.ProcessEnv = process.env): string | null {
  const roots = wireSockSearchRoots(env);
  // The normal installer layout is cheap to check explicitly and handles
  // installations where the package directory itself is inaccessible.
  for (const root of roots) {
    for (const name of WIRESOCK_EXECUTABLE_NAMES) {
      for (const relative of [name, path.join("sdk", name)]) {
        const candidate = path.join(root, relative);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  // WinGet stores the package below LOCALAPPDATA. Check only its known layout;
  // never recursively scan arbitrary PATH/System32 trees.
  const packagesRoot = env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages")
    : "";
  if (packagesRoot) {
    try {
      const packages = fs.readdirSync(packagesRoot, { withFileTypes: true });
      for (const packageDir of packages) {
        if (!packageDir.isDirectory() || !/wiresock|ntkernel\.wiresock/i.test(packageDir.name)) continue;
        const packageRoot = path.join(packagesRoot, packageDir.name);
        const layouts = [packageRoot];
        try {
          for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
            if (entry.isDirectory() && /^(x64|x86|arm64)$/i.test(entry.name)) layouts.push(path.join(packageRoot, entry.name));
          }
        } catch {}
        for (const layout of layouts) {
          for (const relative of ["wiresock-client.exe", path.join("sdk", "wiresock-client.exe")]) {
            const found = path.join(layout, relative);
            if (fs.existsSync(found)) return found;
          }
        }
      }
    } catch {}
  }
  return null;
}

export function getWireSockConnectionStatus(): WireSockConnectionStatus {
  if (process.platform !== "win32") return { state: "unknown", verified: false, source: "none" };
  const cli = findWireSockCli();
  if (cli) {
    try {
      const output = execFileSync(cli, ["status"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 5000,
      });
      const state = parseWireSockCliStatus(output);
      const externalAddress = parseWireSockCliExternalAddress(output);
      return { state, verified: state === "connected" && Boolean(externalAddress), source: "cli", externalAddress, detail: output.trim().slice(0, 300) };
    } catch (err) {
      return { state: "unknown", verified: false, source: "cli", detail: detalheErro(err) };
    }
  }
  if (isWireSockActive()) {
    return {
      state: "unknown",
      verified: false,
      source: "service",
      detail: "WireSock ativo, mas esta instalacao nao oferece CLI de status",
    };
  }
  return { state: "disconnected", verified: false, source: "none" };
}

function execFileText(file: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", windowsHide: true, timeout }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || ""));
    });
  });
}

export async function isWireSockActiveAsync(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  for (const name of WIRESOCK_SERVICE_NAMES) {
    try {
      const output = await execFileText("sc.exe", ["query", name]);
      if (/STATE\s*:\s*\d+\s+RUNNING/i.test(output)) return true;
    } catch {}
  }
  try {
    const output = await execFileText("tasklist", ["/FI", "IMAGENAME eq wiresock-client.exe"]);
    return output.toLowerCase().includes("wiresock-client.exe");
  } catch {
    return false;
  }
}

/** Non-blocking counterpart used by the short-interval failover monitor. */
export async function getWireSockConnectionStatusAsync(): Promise<WireSockConnectionStatus> {
  if (process.platform !== "win32") return { state: "unknown", verified: false, source: "none" };
  const cli = findWireSockCli();
  if (cli) {
    try {
      const output = await execFileText(cli, ["status"]);
      const state = parseWireSockCliStatus(output);
      const externalAddress = parseWireSockCliExternalAddress(output);
      return { state, verified: state === "connected" && Boolean(externalAddress), source: "cli", externalAddress, detail: output.trim().slice(0, 300) };
    } catch (err) {
      // A CLI pode existir e ainda assim não responder durante uma troca do
      // serviço. Consulte o processo apenas para distinguir uma falha real de
      // um diagnóstico indisponível; o caller continua tratando o segundo
      // caso como unknown.
      if (await isWireSockActiveAsync()) {
        return { state: "unknown", verified: false, source: "cli", detail: detalheErro(err) };
      }
      return { state: "disconnected", verified: false, source: "none", detail: detalheErro(err) };
    }
  }
  if (await isWireSockActiveAsync()) {
    return { state: "unknown", verified: false, source: "service", detail: "WireSock ativo, mas esta instalacao nao oferece CLI de status" };
  }
  return { state: "disconnected", verified: false, source: "none" };
}

/** Counters do ProTUN para instalações sem wg.exe e sem a CLI opcional. */
export function getWireSockAdapterTraffic(): WireSockAdapterTraffic | null {
  if (process.platform !== "win32") return null;
  try {
    const script = "$a = Get-NetAdapterStatistics -Name 'ProTUN' -ErrorAction Stop; [PSCustomObject]@{adapter='ProTUN';receivedBytes=[int64]$a.ReceivedBytes;sentBytes=[int64]$a.SentBytes} | ConvertTo-Json -Compress";
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 5000,
    }).trim();
    const parsed = JSON.parse(output) as { adapter?: unknown; receivedBytes?: unknown; sentBytes?: unknown };
    const receivedBytes = Number(parsed.receivedBytes);
    const sentBytes = Number(parsed.sentBytes);
    if (!Number.isFinite(receivedBytes) || !Number.isFinite(sentBytes)) return null;
    return { adapter: String(parsed.adapter || "ProTUN"), receivedBytes, sentBytes };
  } catch {
    return null;
  }
}

export async function getWireSockAdapterTrafficAsync(): Promise<WireSockAdapterTraffic | null> {
  if (process.platform !== "win32") return null;
  try {
    const script = "$a = Get-NetAdapterStatistics -Name 'ProTUN' -ErrorAction Stop; [PSCustomObject]@{adapter='ProTUN';receivedBytes=[int64]$a.ReceivedBytes;sentBytes=[int64]$a.SentBytes} | ConvertTo-Json -Compress";
    const output = (await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])).trim();
    const parsed = JSON.parse(output) as { adapter?: unknown; receivedBytes?: unknown; sentBytes?: unknown };
    const receivedBytes = Number(parsed.receivedBytes);
    const sentBytes = Number(parsed.sentBytes);
    if (!Number.isFinite(receivedBytes) || !Number.isFinite(sentBytes)) return null;
    return { adapter: String(parsed.adapter || "ProTUN"), receivedBytes, sentBytes };
  } catch {
    return null;
  }
}

function tunelConfirmado(): boolean {
  return isWireSockActive();
}

async function esperarTunel(tentativas: number, intervaloMs: number): Promise<boolean> {
  for (let i = 0; i < tentativas; i++) {
    if (tunelConfirmado()) return true;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  return tunelConfirmado();
}

export function ensureWireGuardConf(installDir: string, customPath?: string): string {
  const confPath = path.join(installDir, "wireguard.conf");
  if (customPath && fs.existsSync(customPath)) {
    fs.mkdirSync(installDir, { recursive: true });
    fs.copyFileSync(customPath, confPath);
    return confPath;
  }
  if (fs.existsSync(confPath)) {
    return confPath;
  }
  const userProfile = process.env.USERPROFILE || "";
  const dl = path.join(userProfile, "Downloads");
  if (fs.existsSync(dl)) {
    try {
      const files = fs.readdirSync(dl).filter((f) => f.startsWith("wg-") && f.endsWith(".conf"));
      if (files.length > 0) {
        fs.mkdirSync(installDir, { recursive: true });
        fs.copyFileSync(path.join(dl, files[0]), confPath);
        return confPath;
      }
    } catch {}
  }
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(confPath, EMBEDDED_WG_CONF, "utf8");
  return confPath;
}

// Cleanup must also find a legacy client left by an older installation. This
// path is never used to start or install WireSock.
function findWireSockCleanupExe(): string | null {
  return findWireSockInKnownRoots();
}

async function findCompatibleWireSockAsync(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    const candidates = await enumerateWireSockCandidatesAsync(wireSockSearchRoots(env));
    return selectSupportedWireSock(candidates).executable;
  } catch {
    return null;
  }
}

let wireSockInstallInFlight: Promise<string> | null = null;
export async function ensureWireSockInstalled(onProgress?: (message: string) => void): Promise<string> {
  if (wireSockInstallInFlight) return wireSockInstallInFlight;
  wireSockInstallInFlight = ensureWireSockInstalledOnce(onProgress).finally(() => { wireSockInstallInFlight = null; });
  return wireSockInstallInFlight;
}

async function ensureWireSockInstalledOnce(onProgress?: (message: string) => void): Promise<string> {
  assertNoPendingWireSockReboot();
  onProgress?.("Verificando instalação compatível do WireSock…");
  const existing = await findCompatibleWireSockAsync();
  if (existing) {
    // Consultar o SCM a partir de um Electron não elevado pode ocultar drivers
    // que estão carregados (confirmado com `ndiswg` no SDK 3.4.x). Isso é
    // telemetria: a observação funcional após o start fica apenas nos logs.
    if (!isWireSockPacketFilterDriverInstalled()) {
      logger.warn("wiresock", "driver nao ficou visivel ao processo; seguindo para prova funcional", {});
    }
    return existing;
  }

  logger.info("wiresock", "nenhuma instalação compatível; usando instalador oficial com hash fixado", { url: WIRESOCK_OFFICIAL_DOWNLOAD });
  return installOfficialWireSock(onProgress);
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
  const values = [...unique.values()];
  if (values.length === 0) return "Discord, Discord.exe, Update.exe";
  return values.join(", ");
}

async function applyWireSockProfile(installDir: string, rawConf: string, allowedAppPaths: string[] = []): Promise<void> {
  if (!fs.existsSync(rawConf)) throw new Error("O perfil WireGuard selecionado não existe.");
  const wsExe = await ensureWireSockInstalled();
  logger.info("wiresock", "executavel encontrado", { caminho: wsExe });
  const targetConf = path.join(installDir, "wiresock-discord.conf");
  fs.mkdirSync(installDir, { recursive: true });

  const allowedApps = formatAllowedApps(allowedAppPaths);
  const rawLines = fs.readFileSync(rawConf, "utf8").split(/\r?\n/);
  let hasAllowedApps = false;
  const newLines = rawLines.map((l) => {
    if (/^\s*DNS\s*=/i.test(l)) {
      // O DNS do perfil WireGuard pode ser aplicado pelo WireSock no escopo do
      // host. O bypass e split-tunnel: o DNS do Windows deve continuar sendo
      // resolvido pelo adaptador do usuario, nao por 10.2.0.1.
      return "";
    }
    if (/^\s*(?:#@ws:)?AllowedApps\s*=/i.test(l)) {
      hasAllowedApps = true;
      return `#@ws:AllowedApps = ${allowedApps}`;
    }
    return l;
  });
  if (!hasAllowedApps) {
    newLines.push(`#@ws:AllowedApps = ${allowedApps}`);
  }
  fs.writeFileSync(targetConf, newLines.join("\r\n"), "utf8");
  const profileBytes = fs.readFileSync(targetConf);
  const profileContext = {
    config_file: path.basename(targetConf),
    profile_fingerprint: crypto.createHash("sha256").update(profileBytes).digest("hex").slice(0, 16),
    config_size: profileBytes.byteLength,
    allowed_apps_count: allowedApps.split(",").filter(Boolean).length,
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-wiresock-"));
  const serviceScriptPath = path.join(tempDir, "activate-service.ps1");
  const serviceResultPath = path.join(tempDir, "service-result.txt");
  const directScriptPath = path.join(tempDir, "activate-direct.ps1");
  const directResultPath = path.join(tempDir, "direct-result.txt");
  const operationId = logger.createOperationId("wiresock-activation");
  const directAttemptId = logger.createOperationId("wiresock-direct");
  const readResult = (resultPath: string): string => {
    try {
      return logger.clipLogText(fs.readFileSync(resultPath, "utf8").replace(/^\d+\s*/, "").trim(), 4000);
    } catch {
      return "";
    }
  };
  let activationMode: "service" | "direct" = "direct";
  try {
    // The official WireSock Discord setup uses `run -config`. It owns only
    // this user's application tunnel and does not inherit a stale global
    // service profile. Starting a service merely proves that SCM accepted a
    // process; it does not prove that the WFP filter captured Discord.
    fs.writeFileSync(
      directScriptPath,
      wireSockDirectScript(wsExe, targetConf, directResultPath),
      { encoding: "utf8", mode: 0o600 },
    );
    logger.logEvent("info", "wiresock", "activation.attempt", {
      operation_id: operationId,
      attempt_id: directAttemptId,
      phase: "direct-starting",
      mode: "direct",
    }, profileContext);
    const directStartedAt = Date.now();
    let directError: unknown = null;
    try {
      execFileSync("powershell.exe", elevatedPowerShellFileArgs(directScriptPath), {
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
      });
    } catch (error) {
      directError = error;
    }

    // The result file belongs to the elevated child. Unlike an SCM RUNNING
    // state, DIRECT_RUNNING means that the exact application-mode process
    // stayed alive after parsing this profile.
    const directDetail = readResult(directResultPath);
    const directResult = classifyWireSockDirectResult(
      directDetail || (directError ? detalheErro(directError) : ""),
    );
    logger.logEvent(directResult.kind === "running" ? "info" : "warn", "wiresock", "process.result", {
      operation_id: operationId,
      attempt_id: directAttemptId,
      phase: "process",
      mode: "direct",
    }, {
      result: directResult.kind,
      code: directResult.kind === "running" ? null : directResult.code,
      pid: directResult.kind === "running" ? directResult.pid : null,
      duration_ms: Date.now() - directStartedAt,
      detail: directResult.detail,
    });
    const directStarted = directResult.kind === "running" &&
      await esperarProcessoWireSock(directResult.pid, 12, 250);
    const directFailure = directResult.detail || "o processo direto não permaneceu ativo";
    if (!directStarted) {
      if (!mayUseServiceCompatibility(directResult)) {
        const failure = classifyWireSockActivationFailure(directFailure);
        logger.logEvent("error", "wiresock", "activation.failed", {
          operation_id: operationId,
          attempt_id: directAttemptId,
          phase: "direct-starting",
          mode: "direct",
        }, {
          codigo: failure.code,
          tipo: failure.kind,
          detalhe: directFailure,
        });
        throw new Error(failure.message + " [" + failure.code + "]");
      }

      logger.logEvent("warn", "wiresock", "activation.compatibility_fallback", {
        operation_id: operationId,
        attempt_id: directAttemptId,
        phase: "service-compatibility",
        mode: "direct",
      }, { detalhe: directFailure });
      const compatibilityCleanup = await stopWireSockService();
      if (!compatibilityCleanup.stopped) {
        logger.logEvent("error", "wiresock", "cleanup.recovery_required", {
          operation_id: operationId,
          attempt_id: directAttemptId,
          phase: "cleanup",
        }, {
          stopped: compatibilityCleanup.stopped,
          attempts: compatibilityCleanup.attempts,
          residual: compatibilityCleanup.residual.join(", "),
        });
        throw new Error("A tentativa anterior deixou um processo WireSock ativo. Use Restaurar internet antes de tentar novamente. [WIRESOCK_RECOVERY_REQUIRED]");
      }
      fs.writeFileSync(
        serviceScriptPath,
        wireSockServiceScript(wsExe, targetConf, serviceResultPath),
        { encoding: "utf8", mode: 0o600 },
      );
      const serviceAttemptId = logger.createOperationId("wiresock-service");
      logger.logEvent("info", "wiresock", "activation.attempt", {
        operation_id: operationId,
        attempt_id: serviceAttemptId,
        phase: "service-compatibility",
        mode: "service",
      }, profileContext);
      const serviceStartedAt = Date.now();
      let serviceError: unknown = null;
      try {
        execFileSync("powershell.exe", elevatedPowerShellFileArgs(serviceScriptPath), {
          windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
        });
      } catch (error) {
        serviceError = error;
      }

      const serviceDetail = readResult(serviceResultPath) || (serviceError ? detalheErro(serviceError) : "");
      logger.logEvent(serviceDetail.startsWith("SERVICE_RUNNING") ? "info" : "warn", "wiresock", "process.result", {
        operation_id: operationId,
        attempt_id: serviceAttemptId,
        phase: "process",
        mode: "service",
      }, {
        result: serviceDetail.startsWith("SERVICE_RUNNING") ? "running" : "failed",
        duration_ms: Date.now() - serviceStartedAt,
        detail: serviceDetail,
      });
      const serviceMatch = serviceDetail.match(/^SERVICE_RUNNING:\s+name=([^\s]+)\s+pid=(\d+)/i);
      const serviceName = serviceMatch?.[1] || "";
      const servicePid = Number(serviceMatch?.[2] || 0);
      const serviceStarted = Boolean(
        serviceMatch &&
        WIRESOCK_SERVICE_NAMES.includes(serviceName as typeof WIRESOCK_SERVICE_NAMES[number]) &&
        isServiceRunning(serviceName) &&
        await esperarProcessoWireSock(servicePid, 6, 250),
      );
      if (!serviceStarted) {
        const failure = classifyWireSockActivationFailure(directFailure + " " + serviceDetail);
        logger.logEvent("error", "wiresock", "activation.failed", {
          operation_id: operationId,
          attempt_id: serviceAttemptId,
          phase: "service-compatibility",
          mode: "service",
        }, {
          codigo: failure.code,
          tipo: failure.kind,
          direto: directFailure,
          servico: serviceDetail || "serviço não confirmou o processo próprio",
        });
        throw new Error(failure.message + " [" + failure.code + "]");
      }
      activationMode = "service";
      logger.logEvent("info", "wiresock", "activation.accepted", {
        operation_id: operationId,
        attempt_id: serviceAttemptId,
        phase: "active",
        mode: "service",
      }, {
        serviceName,
        pid: servicePid,
        wrapperError: serviceError ? detalheErro(serviceError) : null,
      });
    } else {
      logger.logEvent("info", "wiresock", "activation.accepted", {
        operation_id: operationId,
        attempt_id: directAttemptId,
        phase: "active",
        mode: "direct",
      }, {
        pid: directResult.pid,
        wrapperError: directError ? detalheErro(directError) : null,
      });
    }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (error) {
      logger.warn("wiresock", "nao consegui remover script temporario de ativacao", { erro: detalheErro(error) });
    }
  }
  limparDnsDoAdaptadorWireSock();
  logger.logEvent("info", "wiresock", "activation.completed", {
    operation_id: operationId,
    phase: "active",
    mode: activationMode,
  }, profileContext);
}

export async function startWireSockService(installDir: string, customConf?: string, allowedAppPaths: string[] = []): Promise<void> {
  const rawConf = ensureWireGuardConf(installDir, customConf);
  await applyWireSockProfile(installDir, rawConf, allowedAppPaths);
}

/**
 * Reapplies a candidate profile by restarting only the WireSock service. The
 * canonical wireguard.conf is intentionally untouched until the caller has
 * observed a recent handshake, so a failed candidate can be rolled back while
 * the Discord process remains alive.
 */
export async function switchWireSockService(installDir: string, candidateConf: string, allowedAppPaths: string[] = []): Promise<void> {
  const resolvedInstall = path.resolve(installDir);
  const resolvedCandidate = path.resolve(candidateConf);
  const relative = path.relative(resolvedInstall, resolvedCandidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("O perfil de failover WireSock está fora da pasta de dados do GoLiveBypass.");
  }
  await applyWireSockProfile(installDir, resolvedCandidate, allowedAppPaths);
}

export interface WireSockCleanupResult {
  stopped: boolean;
  attempts: number;
  resetNetworkLock: boolean;
  dnsCleared: boolean;
  dnsFlushed: boolean;
  servicesResidual: string[];
  processResidual: boolean;
  residual: string[];
}

export interface WindowsNetworkCheck {
  ok: boolean;
  dnsOk: boolean;
  httpsOk: boolean;
  updaterDnsOk: boolean;
  updaterHttpsOk: boolean;
  error?: string;
}

function resetWireSockNetworkLock(wsExe: string): boolean {
  try {
    execSync(`"${wsExe}" reset-network-lock`, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    try {
      const escaped = wsExe.replace(/'/g, "''");
      execSync(`powershell.exe -NoProfile -Command "Start-Process -FilePath '${escaped}' -ArgumentList 'reset-network-lock' -Verb RunAs -WindowStyle Hidden -Wait"`, { stdio: "ignore", windowsHide: true });
      return true;
    } catch (err) {
      logger.warn("wiresock", "nao consegui resetar network lock residual", { erro: detalheErro(err) });
      return false;
    }
  }
}

function stopWireSockServiceElevated(name: string): boolean {
  try {
    const escaped = name.replace(/'/g, "''");
    execSync(`powershell.exe -NoProfile -Command "$p = Start-Process -FilePath 'sc.exe' -ArgumentList 'stop ${escaped}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; if ($p.ExitCode -ne 0) { exit $p.ExitCode }"`, {
      stdio: "ignore",
      // A parada pode exigir consentimento UAC. Esconder o PowerShell fazia a
      // solicitacao ficar invisivel e o servico permanecia em execucao.
      windowsHide: false,
    });
    return true;
  } catch (err) {
    logger.warn("wiresock", "parada elevada do servico falhou", { servico: name, erro: detalheErro(err) });
    return false;
  }
}

function killWireSockProcessElevated(): boolean {
  try {
    execSync("powershell.exe -NoProfile -Command \"$p = Start-Process -FilePath 'taskkill.exe' -ArgumentList '/F /T /IM wiresock-client.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; if ($p.ExitCode -ne 0) { exit $p.ExitCode }\"", {
      stdio: "ignore",
      windowsHide: false,
    });
    return true;
  } catch (err) {
    logger.warn("wiresock", "encerramento elevado do processo falhou", { erro: detalheErro(err) });
    return false;
  }
}

function limparDnsDoAdaptadorWireSock(): boolean {
  try {
    execSync("powershell.exe -NoProfile -Command \"Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -match 'ProTUN|WireSock' -or $_.InterfaceDescription -match 'WireSock|WireGuard' } | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses -ErrorAction SilentlyContinue }\"", {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch (err) {
    logger.warn("wiresock", "nao consegui limpar DNS do adaptador virtual", { erro: detalheErro(err) });
    return false;
  }
}

const esperar = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Stops every WireSock execution path and verifies the result.  This is async
 * on purpose: callers must not start another profile while STOP_PENDING is
 * still dismantling WFP state.
 */
export async function stopWireSockService(): Promise<WireSockCleanupResult> {
  if (process.platform !== "win32") {
    return {
      stopped: true, attempts: 0, resetNetworkLock: false, dnsCleared: false,
      dnsFlushed: false, servicesResidual: [], processResidual: false, residual: [],
    };
  }

  const estavaAtivo = isWireSockActive();
  let attempts = 0;
  let resetNetworkLock = false;
  let servicesResidual: string[] = [];
  let processResidual = false;
  let residual: string[] = [];

  // A segunda passagem e elevada mesmo que a primeira tenha aceitado o stop:
  // e comum o SCM dizer STOP_PENDING enquanto um filho do servico ainda segura
  // o filtro WFP. Nunca criamos uma nova instancia antes desta verificacao.
  for (let pass = 0; pass < 2; pass++) {
    attempts++;
    for (const name of WIRESOCK_SERVICE_NAMES) {
      if (!isServiceRunning(name)) continue;
      let stopSolicitado = false;
      try {
        execSync(`sc.exe stop ${name}`, { stdio: "ignore", windowsHide: true });
        stopSolicitado = true;
      } catch (err) {
        try {
          const escaped = name.replace(/'/g, "''");
          execSync(`powershell.exe -NoProfile -Command "Stop-Service -Name '${escaped}' -Force -ErrorAction Stop"`, { stdio: "ignore", windowsHide: true });
          stopSolicitado = true;
        } catch (fallbackErr) {
          stopSolicitado = stopWireSockServiceElevated(name);
          if (!stopSolicitado) logger.warn("wiresock", "parada do servico recusada", { servico: name, erro: detalheErro(fallbackErr) || detalheErro(err), pass: pass + 1 });
        }
      }
      if (pass === 1 && isServiceRunning(name)) stopWireSockServiceElevated(name);
    }
    try {
      // /T e necessario: o servico pode deixar um cliente filho fora do PID que
      // o gerenciador de servicos reporta.
      execSync("taskkill.exe /F /T /IM wiresock-client.exe", { stdio: "ignore", windowsHide: true });
    } catch {
      killWireSockProcessElevated();
    }
    for (let i = 0; i < 10 && isWireSockActive(); i++) await esperar(250);
    servicesResidual = WIRESOCK_SERVICE_NAMES.filter(isServiceRunning);
    processResidual = isWireSockProcessAlive();
    if (servicesResidual.length === 0 && !processResidual) break;
    logger.warn("wiresock", "residuo encontrado; repetindo limpeza elevada", { pass: pass + 1, servicesResidual, processResidual });
    const wsExe = findWireSockCleanupExe();
    if (wsExe) resetNetworkLock = resetWireSockNetworkLock(wsExe) || resetNetworkLock;
  }
  servicesResidual = WIRESOCK_SERVICE_NAMES.filter(isServiceRunning);
  processResidual = isWireSockProcessAlive();
  residual = servicesResidual.map((name) => `${name}: ainda em execucao`);
  if (processResidual) residual.push("wiresock-client.exe: ainda em execucao");

  if (estavaAtivo || residual.length > 0) {
    const wsExe = findWireSockCleanupExe();
    if (wsExe) resetNetworkLock = resetWireSockNetworkLock(wsExe) || resetNetworkLock;
  }
  let dnsFlushed = false;
  const dnsCleared = limparDnsDoAdaptadorWireSock();
  try {
    execSync("ipconfig.exe /flushdns", { stdio: "ignore", windowsHide: true });
    dnsFlushed = true;
  } catch (err) {
    logger.warn("wiresock", "flushdns falhou", { erro: detalheErro(err) });
  }
  const stopped = !isWireSockActive() && residual.length === 0;
  const resultado = { stopped, attempts, resetNetworkLock, dnsCleared, dnsFlushed, servicesResidual, processResidual, residual };
  if (stopped) logger.info("wiresock", "servico, processo e lock verificados como parados", resultado);
  else logger.error("wiresock", "limpeza deixou residuo de WireSock", resultado);
  return resultado;
}

function testarHttps(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 7000 }, (res) => {
      res.resume();
      res.once("end", () => resolve(true));
    });
    req.once("timeout", () => { req.destroy(); resolve(false); });
    req.once("error", () => resolve(false));
  });
}

export async function verifyWindowsNetwork(): Promise<WindowsNetworkCheck> {
  if (process.platform !== "win32") {
    return { ok: true, dnsOk: true, httpsOk: true, updaterDnsOk: true, updaterHttpsOk: true };
  }
  const dnsResults = await Promise.all([
    dns.lookup("www.microsoft.com").then(() => true).catch(() => false),
    dns.lookup("gateway.discord.gg").then(() => true).catch(() => false),
  ]);
  const dnsOk = dnsResults.every(Boolean);
  // O cliente do Discord abre o updater antes da janela principal. Validar
  // apenas gateway.discord.gg deixava a sessão nascer mesmo quando o updater
  // não conseguia resolver updates.discord.com, entrando em "Update failed —
  // retrying" indefinidamente.
  const updaterDnsOk = await dns.lookup("updates.discord.com").then(() => true).catch(() => false);
  const httpsResults = await Promise.all([
    testarHttps("https://www.microsoft.com/generate_204"),
    testarHttps("https://discord.com/api/v9/gateway"),
  ]);
  const httpsOk = httpsResults.some(Boolean);
  const updaterHttpsOk = await testarHttps("https://updates.discord.com/");
  const ok = dnsOk && httpsOk && updaterDnsOk && updaterHttpsOk;
  return {
    ok,
    dnsOk,
    httpsOk,
    updaterDnsOk,
    updaterHttpsOk,
    ...(ok ? {} : {
      error: !dnsOk ? "DNS nao resolveu os dominios de teste" :
        !updaterDnsOk ? "DNS nao resolveu updates.discord.com" :
          !updaterHttpsOk ? "HTTPS nao alcançou updates.discord.com" : "HTTPS nao alcançou a internet",
    }),
  };
}

/**
 * Uma amostra pode acertar o cache do resolvedor enquanto o DNS do túnel está
 * intermitente. O Discord dispara o updater imediatamente ao abrir, então a
 * rede só é considerada liberada depois de duas confirmações completas.
 */
export async function verifyWindowsNetworkStable(
  samples = 2,
  probe: () => Promise<WindowsNetworkCheck> = verifyWindowsNetwork,
  intervalMs = 750,
): Promise<WindowsNetworkCheck> {
  const total = Math.max(1, Math.floor(samples));
  const maxAttempts = Math.max(total, total * 3);
  let last: WindowsNetworkCheck = await probe();
  let consecutiveOk = last.ok ? 1 : 0;
  for (let attempt = 1; attempt < maxAttempts && consecutiveOk < total; attempt++) {
    await esperar(Math.max(0, intervalMs));
    last = await probe();
    consecutiveOk = last.ok ? consecutiveOk + 1 : 0;
  }
  if (consecutiveOk < total) {
    return {
      ...last,
      ok: false,
      error: last.error || `rede não confirmou ${total} amostras consecutivas`,
    };
  }
  return last;
}

export interface WireSockRecoveryResult extends WireSockCleanupResult { ok: boolean; error?: string; }

/** The sole recovery path used by deactivate, route changes and Restore internet. */
export async function recoverWireSockNetwork(): Promise<WireSockRecoveryResult> {
  const cleanup = await stopWireSockService();
  // Public endpoints are asynchronous diagnostics, never an OS cleanup gate.
  void verifyWindowsNetworkStable().then((network) => {
    logger.info("wiresock", "network.diagnostic", { ...network, mode: "log-only" });
  }).catch((error) => logger.warn("wiresock", "network.diagnostic.error", { erro: String((error as Error)?.message ?? error) }));
  const result = { ...cleanup, ok: cleanup.stopped };
  logger.info("wiresock", "recuperacao de rede concluida", result);
  return result;
}

function isServiceRunning(name: string): boolean {
  try {
    const out = execSync(`sc.exe query ${name}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    return /STATE\s*:\s*\d+\s+RUNNING/i.test(out);
  } catch {
    return false;
  }
}
