import path from "path";
import { memoizeWithTtl, runningImageNames, tasklistHasProcess } from "./wait-condition";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { execFile, execFileSync } from "child_process";
import dns from "dns/promises";
import https from "https";
import * as logger from "./logger";
import { elevatedPowerShellFileArgs, wireSockCleanupScript, wireSockDirectScript, wireSockNetworkRestoreScript, wireSockServiceScript } from "./wiresock-service";
import { inspectGuiWireSockOwnership, wireSockOwnershipSnapshotScript, type GuiWireSockInspection } from "./wiresock-ownership";
import { enumerateWireSockCandidatesAsync, selectSupportedWireSock } from "./wiresock-preflight";
import { registrarLogWireSock } from "./wiresock-log";

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
// O SDK 3.4.x instala o filtro WireGuard como serviço de kernel `ndiswgc` (medido
// no Windows 11 com o 3.4.8.1: `sc query ndiswgc` responde KERNEL_DRIVER RUNNING e
// o componente aparece no `netcfg -s n` como `nt_ndiswgc`). Releases anteriores do
// mecanismo por aplicativo expunham `ndiswg` e `NDISRD`. A prova funcional é
// apenas diagnóstico, sem bloquear a ativação.
const WIRESOCK_DRIVER_SERVICE_NAMES = ["ndiswgc", "ndiswg", "NDISRD"] as const;
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
  | { kind: "running"; pid: number; supervisor?: number; detail: string }
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
  // A successful exit is still a stopped tunnel, regardless of captured text.
  if (/^(?:GOLIVE_WIRESOCK_DIRECT_ERROR:\s*)?DIRECT_EXITED:\s*codigo=0\b/i.test(normalized)) {
    return { kind: "failed", code: "WIRESOCK_DIRECT_EXITED_0", detail: normalized };
  }
  const running = normalized.match(/^DIRECT_RUNNING:\s*pid=(\d+)(?:\s+supervisor=(\d+))?\s*$/i);
  if (running) {
    return { kind: "running", pid: Number(running[1]), ...(running[2] ? { supervisor: Number(running[2]) } : {}), detail: normalized };
  }
  if (/\b(?:DIRECT_UNSUPPORTED|RUN_NOT_SUPPORTED)\b|(?:unknown|unrecognized)\s+command\s*[:=]?\s*['"]?run\b|\brun['"]?\s+(?:is\s+)?(?:not supported|unsupported)|comando\s+desconhecido\s*[:=]?\s*['"]?run\b/i.test(normalized)) {
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
  if (/wiresock_external/.test(raw)) {
    return { kind: "service", code: "WIRESOCK_EXTERNAL", message: "Há um WireSock externo ou misto. Desative-o no aplicativo responsável antes de ativar a GUI." };
  }
  if (/wiresock_inspection_failed/.test(raw)) {
    return { kind: "unknown", code: "WIRESOCK_STATE_UNKNOWN", message: "Não foi possível confirmar o estado e o perfil do WireSock. Nenhum recurso desconhecido será interrompido; tente novamente aceitando a solicitação de administrador." };
  }
  // Marcadores do wrapper elevado (elevatedPowerShellFileArgs): ele sai sem
  // resultado antes de o script aplicar o perfil. Precisam vir antes dos tokens
  // genéricos, senão quem classifica é o resto da linha de comando.
  if (/direct_worker_timeout/.test(raw)) {
    return {
      kind: "timeout",
      code: "WIRESOCK_ELEVATION_TIMEOUT",
      message: "A ativação elevada do WireSock não devolveu resultado em 100 s. Confirme se o Windows pediu permissão de administrador e tente novamente.",
    };
  }
  if (/direct_worker_exited/.test(raw)) {
    return {
      kind: "process",
      code: "WIRESOCK_WORKER_SEM_RESULTADO",
      message: "O processo elevado de ativação terminou sem registrar o resultado. Tente ativar novamente; se o Windows pedir permissão de administrador, aceite a solicitação.",
    };
  }
  if (/uac|runas|access(?: is)? denied|acesso negado|permission|permiss[aã]o|cancel(?:led|ed)|cancelad|1223|740/.test(raw)) {
    return {
      kind: "permission",
      code: "WIRESOCK_PERMISSION",
      message: "O Windows não autorizou a ativação do WireSock. Aceite a solicitação de administrador e tente novamente.",
    };
  }
  // Evidência de driver é o nome do driver/serviço ou a palavra "driver"/"reboot". `filter`
  // e `filtro` saíram: em mensagem de erro real do WireSock elas não aparecem (só como
  // `.filter()` no código) e o log JSON do cliente que entra no detalhe poderia trazê-las.
  if (/driver|ndiswg|ndisrd|reboot|reinici/.test(raw)) {
    return {
      kind: "driver",
      code: "WIRESOCK_DRIVER",
      message: "O componente de rede do WireSock ainda não está pronto. Reinicie o Windows e tente ativar novamente.",
    };
  }
  if (!/wiresock_direct|direct_exited|direct_failed|processo direto/.test(raw) &&
    /stop_timeout|timeout|timed out|tempo limite|stop_pending|pendente|1053|1061/.test(raw)) {
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
  // `-NoProfile` da linha de comando do PowerShell não é evidência de perfil:
  // sem a fronteira, qualquer falha do wrapper elevado virava "perfil WireGuard".
  if (/config_failed|(?:^|[^a-z-])profile\b|\bperfil\b|wireguard|allowedapps|caminho|inv[aá]lid/.test(raw)) {
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
      message: "O serviço WireSock não pôde ser instalado ou iniciado. Consulte os logs de diagnóstico para identificar a falha do Windows.",
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

// Modos do setup oficial. `uninstall` e `repair` sao os proprios switches de
// manutencao do instalador: sao eles que resolvem a instalacao que o /quiet
// sozinho deixa pela metade.
const WIRESOCK_INSTALLER_ARGUMENTS = {
  install: ["/quiet", "/norestart"],
  uninstall: ["/uninstall", "/quiet", "/norestart"],
  repair: ["/repair", "/quiet", "/norestart"],
} as const;
export type WireSockInstallerMode = keyof typeof WIRESOCK_INSTALLER_ARGUMENTS;

export function wireSockInstallerArguments(mode: WireSockInstallerMode): string[] {
  return [...WIRESOCK_INSTALLER_ARGUMENTS[mode]];
}

// 1605 = produto nao instalado, 1614 = produto desinstalado. Os dois sao o
// resultado esperado quando nao havia mesmo nada para remover.
const WIRESOCK_ABSENT_EXIT_CODES = new Set([0, 1605, 1614]);

// Tetos medidos no Windows 11 com o setup 3.4.8.1: desinstalar leva segundos,
// instalar/reparar menos de um minuto. Os valores cobrem maquina lenta sem
// deixar o app preso em "Iniciando túnel…" por um instalador interativo.
const WIRESOCK_INSTALLER_TIMEOUT_MS = 5 * 60_000;
const WIRESOCK_UNINSTALL_TIMEOUT_MS = 3 * 60_000;
const WIRESOCK_SETTLE_TIMEOUT_MS = 90_000;

export type WireSockInstallState = "compatible" | "stale" | "none";

export interface WireSockInstallStateProbe {
  compatiblePair: boolean;
  installDir: boolean;
  registered: boolean;
  driverService: boolean;
}

/**
 * "stale" e o estado perigoso: sobrou registro do Windows (ou driver, ou pasta)
 * sem um par cliente/booster utilizavel. Nesse estado o setup reexecutado cai
 * em manutencao ("Modify Setup"), que em /quiet nao instala nada e pode deixar
 * o driver pela metade — foi assim que maquinas ficaram sem internet.
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
    return rows.flatMap((row) => {
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

export interface WireSockResidueSnapshot {
  clientInstalled: boolean;
  driverService: boolean;
  adapterDefaultRoute: boolean;
}

/**
 * Residuo que segura a rede quando nenhum cliente roda: rota default orfa no
 * adaptador virtual, ou driver carregado sem cliente para reverter o estado.
 * Uma maquina saudavel com o tunel desligado nao tem rota default no ProTUN,
 * entao uma leitura barata evita pedir UAC em toda desativacao.
 */
export function wireSockResidueNeedsRestore(snapshot: WireSockResidueSnapshot): boolean {
  return snapshot.adapterDefaultRoute || (snapshot.driverService && !snapshot.clientInstalled);
}

export function parseWireSockOrphanDefaultRoutes(output: string): boolean {
  return output.split(/\r?\n/).some((line) =>
    /0\.0\.0\.0\/0/.test(line) && /(?:^|[\s|])(?:protun|wiresock|wireguard)(?:[\s|]|$)/i.test(line),
  );
}

/**
 * Mensagem honesta para o popup: o usuario precisa saber se a rede voltou. A
 * afirmacao so aparece com a sonda confirmando saida — o script de recuperacao
 * dizer que deu certo nao prova que o Windows navega.
 */
export function wireSockInstallFailureHint(restore: WireSockNetworkRestoreResult, network?: WindowsNetworkCheck): string {
  if (!restore.executed) return "";
  const networkState = network ? (network.ok ? " A rede foi comprobada." : ` A rede ainda não responde (${network.error || "sem saída confirmada"}).`) : "";
  if (restore.ok && restore.networkLockReset) {
    return `A rede do Windows foi restaurada depois da falha da instalação; só o túnel não foi ativado.${networkState}`;
  }
  if (restore.networkLockReset) {
    return `O bloqueio de rede do driver foi removido, mas a recuperação ficou inconclusiva (${restore.residual.join("; ") || "sem detalhes"}).${networkState}`;
  }
  return `A instalação falhou e não foi possível confirmar a rede (${restore.residual.join("; ") || "sem detalhes"}). Use "Restaurar internet"; se persistir, repita Reparo em Programas e Recursos do "WireSock Secure Connect".${networkState}`;
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

/**
 * Executa o setup oficial no modo pedido e traduz a saida. Um `error.code`
 * numerico preserva a classificacao de reboot/cancelamento usada acima.
 *
 * O setup nunca fica sem teto: medido no Windows 11, `/quiet` sobre uma
 * instalacao registrada devolve 0 em 3 s sem instalar nada, e um setup que
 * espera interacao fica preso para sempre. O arvore e morta no estouro, senao
 * um instalador vivo continuaria escrevendo no WireSock depois do app desistir.
 */
function runWireSockInstaller(
  installer: string,
  mode: WireSockInstallerMode,
  timeoutMs = WIRESOCK_INSTALLER_TIMEOUT_MS,
): Promise<void> {
  const file = installer.replace(/'/g, "''");
  const argumentsLiteral = wireSockInstallerArguments(mode).map((value) => `'${value.replace(/'/g, "''")}'`).join(",");
  const command = `try { $p=Start-Process -FilePath '${file}' -ArgumentList @(${argumentsLiteral}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; if($null -eq $p){ exit 1223 }; exit [int]$p.ExitCode } catch { $c=$_.Exception.HResult; if($c -eq -2147023673 -or $_.Exception.NativeErrorCode -eq 1223){ exit 1223 }; Write-Error $_; exit 1 }`;
  return new Promise<void>((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: timeoutMs }, (error) => {
      if (!error) { resolve(); return; }
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

/**
 * O setup pode sair antes da transação do Windows Installer: medido no
 * Windows 11, o `msiexec` continuou rodando depois do `/quiet` devolver e o
 * par só apareceu minutos depois. Verificar na hora daria falso negativo e a
 * mensagem de "instalador terminou sem par compatível" — a mesma que o usuário
 * viu. Aqui a verificação espera a instalação assentar.
 */
async function waitForCompatibleWireSock(timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await findCompatibleWireSockAsync();
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await esperar(2000);
  }
}

const WIRESOCK_INSTALL_REBOOT = "WIRESOCK_INSTALL_REBOOT";
const WIRESOCK_INSTALL_CANCEL = "WIRESOCK_INSTALL_CANCEL";

export function wireSockInstallModeError(error: unknown, mode: WireSockInstallerMode): Error {
  const kind = wireSockInstallerExitKind(error);
  if (kind === "cancel") return Object.assign(new Error("A instalação do WireSock foi cancelada pelo usuário; nenhuma tentativa adicional foi executada."), { code: WIRESOCK_INSTALL_CANCEL });
  if (kind === "reboot") return Object.assign(new Error(`O instalador WireSock solicitou reinicialização (modo ${mode}). Reinicie o Windows e tente ativar novamente.`), { code: WIRESOCK_INSTALL_REBOOT });
  return error instanceof Error ? error : new Error(detalheErro(error));
}

/**
 * Recuperacao de rede que roda quando o caminho de instalacao falhou depois de
 * tocar o setup. E o que garante que a maquina nunca fica sem saida por causa
 * de uma instalacao quebrada: lock de driver (reset oficial do fornecedor),
 * rota default orfa do adaptador virtual e DNS.
 */
export async function restoreWireSockNetwork(
  reason: string,
  options: { force?: boolean } = {},
): Promise<WireSockNetworkRestoreResult> {
  const empty: WireSockNetworkRestoreResult = {
    ok: true, executed: false, networkLockReset: false, dnsFlushed: false, adapterRoutesCleared: false, residual: [],
  };
  if (process.platform !== "win32") return empty;
  let client = "";
  try { client = findWireSockInKnownRoots() ?? ""; } catch {}
  let driverService = false;
  let adapterDefaultRoute = false;
  try {
    driverService = isWireSockPacketFilterDriverInstalled();
    adapterDefaultRoute = parseWireSockOrphanDefaultRoutes(
      execFileSync("netsh", ["interface", "ipv4", "show", "route"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }),
    );
  } catch {}
  if (!options.force && !wireSockResidueNeedsRestore({ clientInstalled: Boolean(client), driverService, adapterDefaultRoute })) {
    logger.info("wiresock", "recuperacao de rede nao necessaria", { reason, driverService, adapterDefaultRoute });
    return empty;
  }
  try {
    const raw = await runElevatedWireSockWorker((resultPath) => wireSockNetworkRestoreScript(client ? [client] : [], resultPath));
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: WireSockNetworkRestoreResult = {
      ok: parsed.ok === true,
      executed: true,
      networkLockReset: parsed.networkLockReset === true,
      dnsFlushed: parsed.dnsFlushed === true,
      adapterRoutesCleared: parsed.adapterRoutesCleared === true,
      residual: Array.isArray(parsed.residual) ? parsed.residual.filter((value): value is string => typeof value === "string") : [],
    };
    logger.logEvent(result.ok ? "info" : "warn", "wiresock", "network.restore", { phase: "restore", reason }, result as unknown as logger.LogContext);
    return result;
  } catch (error) {
    const residual = [detalheErro(error)];
    logger.warn("wiresock", "recuperacao de rede nao confirmada", { reason, residual });
    return { ...empty, ok: false, executed: true, residual };
  }
}

/** Registro do Windows que sobrou sem um par cliente/booster utilizavel. */
async function hasWireSockUninstallRegistration(): Promise<{ registered: boolean; entries: string[] }> {
  if (process.platform !== "win32") return { registered: false, entries: [] };
  const script = "$roots=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); $found=@(); foreach($root in $roots){ try { Get-ItemProperty -Path $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and $_.DisplayName -match '(?i)wire\\s?sock|wglaunch' } | ForEach-Object { $found += [PSCustomObject]@{ name=[string]$_.DisplayName } } } catch {} }; ConvertTo-Json -Compress $found";
  try {
    const output = await new Promise<string>((resolve, reject) => execFile(
      "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 8000 },
      (error, stdout) => error ? reject(error) : resolve(stdout),
    ));
    const entries = parseWireSockUninstallEntries(output);
    return { registered: entries.length > 0, entries };
  } catch {
    return { registered: false, entries: [] };
  }
}

async function detectWireSockInstallState(compatiblePair: boolean): Promise<WireSockInstallState> {
  const installDir = wireSockSearchRoots().some((root) => {
    try { return fs.existsSync(root) || fs.existsSync(path.join(root, "sdk")); } catch { return false; }
  });
  const registration = await hasWireSockUninstallRegistration();
  const state = classifyWireSockInstallState({
    compatiblePair,
    installDir,
    registered: registration.registered,
    driverService: isWireSockPacketFilterDriverInstalled(),
  });
  logger.info("wiresock", "estado de instalacao do WireSock", { state, installDir, registered: registration.registered, entradas: registration.entries.join(" | ") });
  return state;
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
    const state = await detectWireSockInstallState(false);
    // Instalacao pela metade: subir o setup por cima cai na tela "Modify Setup",
    // que em /quiet nao instala e pode deixar o driver trocado pela metade.
    // Remover antes e o que mantem o upgrade inteiro fora do modo manutencao.
    if (state === "stale") {
      onProgress?.("Removendo a instalação anterior do WireSock…");
      try {
        await runWireSockInstaller(installer, "uninstall", WIRESOCK_UNINSTALL_TIMEOUT_MS);
      } catch (error) {
        const kind = wireSockInstallerExitKind(error);
        if (kind === "reboot" || kind === "cancel") throw wireSockInstallModeError(error, "uninstall");
        const code = Number((error as { code?: unknown })?.code);
        // 1605/1614 = nao havia nada instalado; o registro antigo segue sendo
        // tratado como "stale" e o /quiet seguinte e tentado assim mesmo.
        if (!WIRESOCK_ABSENT_EXIT_CODES.has(code)) {
          logger.warn("wiresock", "desinstalacao anterior do WireSock nao confirmada", { code, detalhe: detalheErro(error) });
        }
      }
    }
    onProgress?.("Instalando o WireSock SDK validado…");
    await runWireSockInstaller(installer, "install").catch((error) => { throw wireSockInstallModeError(error, "install"); });
    let selected = await waitForCompatibleWireSock(WIRESOCK_SETTLE_TIMEOUT_MS);
    if (!selected) {
      // O setup entrou em manutencao e nao instalou (medido: /quiet devolve 0 em
      // 3 s sobre uma instalacao registrada e nao escreve nada). O reparo e o
      // caminho que restaura o driver e o par no lugar — o mesmo que o usuario
      // precisou fazer em Programas e Recursos, agora automatico.
      onProgress?.("Reparando a instalação do WireSock…");
      try {
        await runWireSockInstaller(installer, "repair");
      } catch (error) {
        const kind = wireSockInstallerExitKind(error);
        if (kind === "reboot" || kind === "cancel") throw wireSockInstallModeError(error, "repair");
        logger.warn("wiresock", "reparo do WireSock nao confirmado", { detalhe: detalheErro(error) });
      }
      selected = await waitForCompatibleWireSock(WIRESOCK_SETTLE_TIMEOUT_MS);
    }
    if (!selected) throw new Error("O instalador oficial terminou, mas não deixou um par WireSock SDK compatível.");
    return selected;
  } catch (error) {
    const installError = wireSockInstallModeError(error, "install");
    const code = (installError as { code?: unknown })?.code;
    // Reboot pedido e cancelamento sao saidas limpas do usuario: a maquina nao
    // foi quebrada por um setup que parou antes de mexer no driver.
    if (code === WIRESOCK_INSTALL_REBOOT) markWireSockRebootPending();
    if (code !== WIRESOCK_INSTALL_REBOOT && code !== WIRESOCK_INSTALL_CANCEL) {
      const restore = await restoreWireSockNetwork("instalacao-falhou", { force: true });
      // O script de recuperacao roda elevado e relata o que fez; so a sonda de
      // saida diz se o Windows voltou a navegar, e e ela que vai no popup.
      const network = restore.executed ? await verifyWindowsNetworkStable().catch(() => undefined) : undefined;
      const hint = wireSockInstallFailureHint(restore, network);
      throw new Error(detalheErro(installError) + (hint ? ` ${hint}` : ""));
    }
    throw installError;
  } finally {
    try { await fs.promises.rm(tempDir, { recursive: true, force: true }); } catch {}
  }
}

export function wireSockDriverQueryShowsInstalled(output: string): boolean {
  return /SERVICE_NAME:\s*(?:ndiswgc|ndiswg|NDISRD)\b/i.test(output) && !/\b1060\b/.test(output);
}

export function isWireSockPacketFilterDriverInstalled(): boolean {
  if (process.platform !== "win32") return false;
  return WIRESOCK_DRIVER_SERVICE_NAMES.some((name) => {
    try {
      const output = execFileSync("sc.exe", ["query", name], {
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
      const out = execFileSync("sc.exe", ["query", name], {
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
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq wiresock-client.exe"], {
      stdio: ["pipe", "pipe", "ignore"],
      encoding: "utf8",
      windowsHide: true,
    });
    return out.toLowerCase().includes("wiresock-client.exe");
  } catch {
    return false;
  }
}

// Assincrono: a espera da ativacao chama isto ate 13 vezes e o execSync antigo (cmd.exe + tasklist,
// ~400 ms cada) congelava a janela por alguns segundos a cada ativacao.
async function isWireSockProcessPidAlive(pid: number): Promise<boolean> {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    const out = await execFileText("tasklist", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"]);
    return tasklistHasProcess(out, "wiresock-client.exe", pid);
  } catch {
    return false;
  }
}

async function esperarProcessoWireSock(pid: number, tentativas: number, intervaloMs: number): Promise<boolean> {
  for (let i = 0; i < tentativas; i++) {
    if (await isWireSockProcessPidAlive(pid)) return true;
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

// Cada chamada sem cache custa ate 2 `where` sincronos (cmd.exe) na thread principal, e a prontidao
// e o failover chamam isto a cada 1 a 3 s. A CLI nao some nem aparece no meio de uma sessao.
export const findWireSockCli = memoizeWithTtl(procurarWireSockCli, 60_000);

function procurarWireSockCli(): string | null {
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
      const out = execFileSync("where.exe", [name], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
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
  // O caminho fixo so cobre um ambiente sem as variaveis de Program Files; quem as passa
  // (mesmo vazias) decide as raizes.
  const semVariaveis = !("ProgramW6432" in env || "ProgramFiles" in env || "ProgramFiles(x86)" in env);
  const programFiles = [
    env.ProgramW6432,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    semVariaveis ? "C:\\Program Files" : undefined,
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

export type WindowsRouteUiStatus = "ACTIVE" | "INACTIVE" | "RECOVERY_REQUIRED";

/**
 * Estado honesto da rota Windows para a UI (#309). `readinessVerified` vem do
 * veredito de `waitForWindowsWgReady`: `null` enquanto ele não terminou (sem
 * veredito ainda não há o que mostrar) e `false` quando não há handshake nem
 * trânsito provado pelo túnel. Com a rota iniciada e a prontidão refutada, a UI
 * deixa de exibir "ligado" e mostra a recuperação com a Restaurar internet.
 * Isto é só apresentação: nenhuma leitura de diagnóstico para ou destrói o
 * túnel aqui.
 */
export function windowsRouteStatus(input: {
  started: boolean;
  wireSockActive: boolean;
  discordRunning: boolean;
  readinessVerified: boolean | null;
}): WindowsRouteUiStatus {
  if (!input.started || !input.wireSockActive || !input.discordRunning) return "INACTIVE";
  if (input.readinessVerified === false) return "RECOVERY_REQUIRED";
  return "ACTIVE";
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

// Um unico `tasklist /FO CSV` com todos os processos. O amostrador de failover deriva dali, de uma
// vez, "o Discord esta aberto" e "o WireSock esta vivo", em vez de um tasklist para cada pergunta.
export async function listRunningImageNamesAsync(): Promise<Set<string> | null> {
  if (process.platform !== "win32") return null;
  try {
    return runningImageNames(await execFileText("tasklist", ["/FO", "CSV", "/NH"]));
  } catch {
    return null;
  }
}

// `processAlive`: resposta ja conhecida pelo chamador sobre o processo wiresock-client.exe
// (true = vivo, false = ausente). Sem ela o tasklist e feito aqui.
export async function isWireSockActiveAsync(options: { processAlive?: boolean } = {}): Promise<boolean> {
  if (process.platform !== "win32") return false;
  // O processo primeiro: com o tunel ativo (modo direto ou servico) um `tasklist` responde e
  // evita os dois `sc query`. O resultado e o mesmo "servico rodando OU processo vivo".
  if (options.processAlive === true) return true;
  if (options.processAlive === undefined) {
    try {
      const output = await execFileText("tasklist", ["/FI", "IMAGENAME eq wiresock-client.exe"]);
      if (output.toLowerCase().includes("wiresock-client.exe")) return true;
    } catch {}
  }
  for (const name of WIRESOCK_SERVICE_NAMES) {
    try {
      const output = await execFileText("sc.exe", ["query", name]);
      if (/STATE\s*:\s*\d+\s+RUNNING/i.test(output)) return true;
    } catch {}
  }
  return false;
}

/** Non-blocking counterpart used by the short-interval failover monitor. */
export async function getWireSockConnectionStatusAsync(options: { activeHint?: boolean } = {}): Promise<WireSockConnectionStatus> {
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
      if (options.activeHint ?? await isWireSockActiveAsync()) {
        return { state: "unknown", verified: false, source: "cli", detail: detalheErro(err) };
      }
      return { state: "disconnected", verified: false, source: "none", detail: detalheErro(err) };
    }
  }
  if (options.activeHint ?? await isWireSockActiveAsync()) {
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

// `netsh interface ipv4 show subinterfaces`: MTU, estado, bytes in, bytes out, nome. O
// cabecalho vem traduzido, mas as colunas sao fixas; o nome pode ter espacos.
export function parseNetshInterfaceBytes(output: string, adapter: string): WireSockAdapterTraffic | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*\d+\s+\d+\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && m[3].toLowerCase() === adapter.toLowerCase()) return { adapter, receivedBytes: Number(m[1]), sentBytes: Number(m[2]) };
  }
  return null;
}

// Leitura leve (~90ms, contra ~400ms do PowerShell) para amostrar de poucos em poucos segundos.
export async function getWireSockAdapterTrafficNetshAsync(adapter = "ProTUN"): Promise<WireSockAdapterTraffic | null> {
  if (process.platform !== "win32") return null;
  try {
    return parseNetshInterfaceBytes(await execFileText("netsh", ["interface", "ipv4", "show", "subinterfaces"]), adapter);
  } catch {
    return null;
  }
}

// O que o card de trafego recebe a cada leitura (null nos contadores = adaptador do tunel ausente).
export type TunnelStats = { downMbps: number | null; upMbps: number | null; receivedBytes: number | null; sentBytes: number | null; pingMs: number | null };

// Taxa entre duas leituras. "uploadDrop" = upload despencou para menos de 20% da amostra anterior
// estando acima de 1 Mbps: e a assinatura de uma stream congelando.
export function trafficSample(
  previous: WireSockAdapterTraffic,
  current: WireSockAdapterTraffic,
  elapsedMs: number,
  previousUpMbps: number | null,
): { downMbps: number; upMbps: number; uploadDrop: boolean } {
  const mbps = (bytes: number) => (bytes > 0 && elapsedMs > 0 ? (bytes * 8) / (elapsedMs * 1000) : 0);
  const downMbps = mbps(current.receivedBytes - previous.receivedBytes);
  const upMbps = mbps(current.sentBytes - previous.sentBytes);
  const uploadDrop = previousUpMbps !== null && previousUpMbps > 1 && upMbps < previousUpMbps * 0.2;
  return { downMbps, upMbps, uploadDrop };
}

// Tempo de resposta do servidor da VPN (ping.exe localizado: so o "=NNms"/"<1ms" importa).
export function parsePingMs(output: string): number | null {
  const m = /[=<]\s*(\d+)\s*ms/i.exec(output);
  return m ? Number(m[1]) : null;
}

export async function pingHostAsync(host: string): Promise<number | null> {
  if (process.platform !== "win32" || !/^[\w.:-]+$/.test(host)) return null;
  try {
    return parsePingMs(await execFileText("ping", ["-n", "1", "-w", "1500", host], 3000));
  } catch {
    return null;
  }
}

// Sem o adaptador ProTUN o netsh devolve sempre null. O failover (a cada 3 s) pede para lembrar
// essa ausencia por 30 s e pular o processo; a prontidao nao pede, porque la um adaptador que
// aparece depois do inicio precisa ser visto na hora.
let adaptadorAusenteAte = 0;

export async function getWireSockAdapterTrafficAsync(options: { lembrarAusencia?: boolean } = {}): Promise<WireSockAdapterTraffic | null> {
  if (process.platform !== "win32") return null;
  if (options.lembrarAusencia && Date.now() < adaptadorAusenteAte) return null;
  // netsh (~90ms) no lugar de um PowerShell inteiro (~600ms) por leitura: a prontidao le a cada
  // segundo e o failover a cada 3s. O PowerShell fica so de reserva se o netsh nao rodar.
  try {
    const leitura = parseNetshInterfaceBytes(await execFileText("netsh", ["interface", "ipv4", "show", "subinterfaces"]), "ProTUN");
    if (options.lembrarAusencia && leitura === null) adaptadorAusenteAte = Date.now() + 30_000;
    return leitura;
  } catch { /* cai no PowerShell */ }
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
    // que estão carregados (o 3.4.8.1 responde por `ndiswgc`, um KERNEL_DRIVER).
    // Isso é telemetria: a observação funcional após o start fica só nos logs.
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

/**
 * Lê o arquivo de resultado escrito pelo script elevado. Quando o worker morre
 * depois de iniciar o cliente, o resultado não existe, mas a saída capturada do
 * próprio WireSock continua no diretório temporário — é a última evidência antes
 * do rmSync do finally.
 */
export function readWireSockResult(resultPath: string): string {
  for (const caminho of [resultPath, `${resultPath}.stderr`, `${resultPath}.stdout`]) {
    try {
      const texto = logger.clipLogText(fs.readFileSync(caminho, "utf8").replace(/^\d+\s*/, "").trim(), 4000);
      if (texto) return texto;
    } catch {
      continue;
    }
  }
  return "";
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
  // O tempDir e apagado no fim da ativacao; o sinal de parada do supervisor precisa de uma pasta estavel.
  const stopFlagPath = path.join(installDir, "wiresock-stop.flag");
  // Um par de sinal/resultado sobra quando o worker elevado morre no meio (o wrapper o mata no
  // timeout) ou quando a ativacao cai no modo servico, que nao gera script com supervisor: sem
  // ninguem vigiando o arquivo, nenhum supervisor o leria, mas ele fica na pasta do app e aparece
  // em relatorio de bug. Toda ativacao comeca sem sinal velho.
  limparSinalDoSupervisor(stopFlagPath);
  const operationId = logger.createOperationId("wiresock-activation");
  const directAttemptId = logger.createOperationId("wiresock-direct");
  let activationMode: "service" | "direct" = "direct";
  try {
    // The official WireSock Discord setup uses `run -config`. It owns only
    // this user's application tunnel and does not inherit a stale global
    // service profile. Starting a service merely proves that SCM accepted a
    // process; it does not prove that the WFP filter captured Discord.
    fs.writeFileSync(
      directScriptPath,
      wireSockDirectScript(wsExe, targetConf, directResultPath, { guiPid: process.pid, stopFlagPath }),
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
      await execFileWithWindow("powershell.exe", elevatedPowerShellFileArgs(directScriptPath, directResultPath), {
        windowsHide: true, timeout: 120_000,
      });
    } catch (error) {
      directError = error;
    }

    // The result file belongs to the elevated child. Unlike an SCM RUNNING
    // state, DIRECT_RUNNING means that the exact application-mode process
    // stayed alive after parsing this profile.
    const directDetail = readWireSockResult(directResultPath);
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
    const supervisor = directStarted && directResult.kind === "running" && directResult.supervisor
      ? { pid: directResult.supervisor, stopFlagPath }
      : null;
    setTunnelSupervisor(supervisor);
    if (supervisor) logger.info("wiresock", "supervisor.ativo", { pid: supervisor.pid });
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
      const compatibilityCleanup = await stopWireSockService(targetConf);
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
        await execFileWithWindow("powershell.exe", elevatedPowerShellFileArgs(serviceScriptPath), {
          windowsHide: true, timeout: 120_000,
        });
      } catch (error) {
        serviceError = error;
      }

      const serviceDetail = readWireSockResult(serviceResultPath) || (serviceError ? detalheErro(serviceError) : "");
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
        // The direct attempt was explicitly unsupported, not the cause of the
        // service failure. Keep it in the log without masking the SCM result.
        const failure = classifyWireSockActivationFailure(serviceDetail || "START_FAILED: serviço não confirmou o processo próprio");
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
      registrarLogWireSock(null);
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
      // O wiresock-client escreve handshake e keepalive neste arquivo enquanto o tunel vive. O
      // tempDir nao some ao fim da ativacao (o arquivo aberto impede a remocao), entao o caminho
      // segue valido para o watchdog e para o relatorio de bug lerem.
      registrarLogWireSock(directResultPath + ".stdout");
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
  // Profiles omit DNS, so activation must not reset unrelated host adapters.
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

// Chamadas que podem abrir UAC ficam assincronas: enquanto o prompt esta na tela
// a janela precisa continuar respondendo (execSync segurava a main thread por
// tempo indeterminado ate o usuario responder).
const UAC_TIMEOUT_MS = 5 * 60_000;

/**
 * Quando o stderr é um pipe (caso do `execFile`), o Windows PowerShell serializa
 * o stream de erro como CLIXML: o marcador real fica depois de centenas de
 * caracteres de XML de progresso e sairia do corte de 500 caracteres do
 * diagnóstico. Aqui o stream volta a ser texto simples.
 */
export function unwrapPowerShellErrorStream(stderr: unknown): string {
  const texto = String(stderr ?? "");
  if (!texto.includes("#< CLIXML")) return texto;
  const partes = [...texto.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((match) => match[1]);
  const unificado = (partes.length > 0 ? partes.join(" ") : texto)
    .replace(/_x000D_|_x000A_/g, " ")
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return unificado.replace(/\s+/g, " ").trim() || texto;
}

/**
 * O wrapper elevado publica o motivo real em stderr; o erro do execFile carrega
 * apenas a linha de comando (`Command failed: powershell.exe -NoProfile …`).
 * Sem juntar os streams, o log e a classificação da falha ficavam sem a causa —
 * e o `-NoProfile` da própria linha de comando virava diagnóstico de perfil.
 */
export function wireSockExecError(error: unknown, file: string, stdout: unknown, stderr: unknown): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  const capturado = [unwrapPowerShellErrorStream(stderr), stdout]
    .map((stream) => String(stream ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
  if (!capturado) return base;
  const code = "code" in base ? base.code : undefined;
  const killed = "killed" in base ? base.killed : undefined;
  const marcador = typeof code === "number" ? `exit=${code}` : killed === true ? "timeout" : "sem-exit";
  return Object.assign(base, { stderr: logger.clipLogText(`[${path.basename(file)} ${marcador}] ${capturado}`, 600) });
}

function execFileWithWindow(
  file: string,
  args: string[],
  options: { windowsHide: boolean; timeout: number },
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(file, args, { encoding: "utf8", windowsHide: options.windowsHide, timeout: options.timeout }, (error, stdout, stderr) => {
    if (error) reject(wireSockExecError(error, file, stdout, stderr));
    else resolve(String(stdout ?? ""));
  });
  return promise;
}

const esperar = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function defaultGuiWireSockConfig(): string {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "GoLiveBypass", "wiresock-discord.conf");
}

async function runElevatedWireSockWorker(makeScript: (resultPath: string) => string): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "golive-wiresock-cleanup-"));
  const scriptPath = path.join(directory, "worker.ps1");
  const resultPath = path.join(directory, "result.json");
  try {
    await fs.promises.writeFile(scriptPath, makeScript(resultPath), { encoding: "utf8", mode: 0o600 });
    let workerError: unknown;
    try {
      await execFileWithWindow("powershell.exe", elevatedPowerShellFileArgs(scriptPath), { windowsHide: false, timeout: UAC_TIMEOUT_MS });
    } catch (error) { workerError = error; }
    // Even a refused cleanup writes a result. A failed UAC/spawn does not.
    try { return await fs.promises.readFile(resultPath, "utf8"); } catch {
      throw workerError || new Error("WIRESOCK_INSPECTION_FAILED: worker sem resultado");
    }
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

async function inspectGuiWireSock(configPath: string): Promise<GuiWireSockInspection> {
  const script = wireSockOwnershipSnapshotScript(configPath);
  let raw = "";
  try {
    raw = await execFileWithWindow("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 10_000 });
  } catch {}
  // Sem UAC: um app comum nao le a linha de comando de um tunel elevado, entao o resultado pode vir
  // "nao confiavel". Isso e resolvido em stopWireSockService, sem abrir um segundo pedido de UAC.
  return inspectGuiWireSockOwnership(raw, configPath);
}

function parseCleanupResult(raw: string): WireSockCleanupResult {
  const result = JSON.parse(raw);
  for (const field of ["stopped", "resetNetworkLock", "dnsCleared", "dnsFlushed", "processResidual"]) {
    if (typeof result[field] !== "boolean") throw new Error("WIRESOCK_INSPECTION_FAILED: resultado de limpeza incompleto");
  }
  if (!Number.isSafeInteger(result.attempts) || result.attempts < 0 ||
    !Array.isArray(result.servicesResidual) || !result.servicesResidual.every((value: unknown) => typeof value === "string") ||
    !Array.isArray(result.residual) || !result.residual.every((value: unknown) => typeof value === "string") ||
    (result.stopped && (result.processResidual || result.servicesResidual.length || result.residual.length))) {
    throw new Error("WIRESOCK_INSPECTION_FAILED: resultado de limpeza incoerente");
  }
  return result as WireSockCleanupResult;
}

// Worker elevado que a ativacao deixou vivo ao lado do tunel (ver wireSockSupervisorPowerShell): ele
// para o proprio tunel quando recebe o sinal, sem um novo UAC. null = nao ha (tunel de uma sessao
// antiga, ou o supervisor ja morreu), e a parada cai na limpeza elevada, com UAC.
let tunnelSupervisor: { pid: number; stopFlagPath: string } | null = null;
const SUPERVISOR_STOP_TIMEOUT_MS = 20_000;

export function setTunnelSupervisor(supervisor: { pid: number; stopFlagPath: string } | null): void {
  tunnelSupervisor = supervisor;
}

/** Apaga o par sinal/resultado da parada pelo supervisor (sobra de worker morto ou de outra sessao). */
export function limparSinalDoSupervisor(stopFlagPath: string): void {
  for (const file of [stopFlagPath, stopFlagPath + ".result"]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

async function isSupervisorAlive(pid: number): Promise<boolean> {
  try {
    const out = await execFileText("tasklist", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"]);
    return tasklistHasProcess(out, "powershell.exe", pid);
  } catch {
    return false;
  }
}

/** Pede a parada ao supervisor e le o resultado dele. null = nao deu certo, o chamador segue para o UAC. */
async function stopViaSupervisor(): Promise<WireSockCleanupResult | null> {
  const supervisor = tunnelSupervisor;
  if (!supervisor) return null;
  if (!(await isSupervisorAlive(supervisor.pid))) {
    tunnelSupervisor = null;
    return null;
  }
  const resultPath = supervisor.stopFlagPath + ".result";
  try {
    fs.rmSync(resultPath, { force: true });
    fs.writeFileSync(supervisor.stopFlagPath, "stop", { mode: 0o600 });
  } catch (error) {
    logger.warn("wiresock", "supervisor.sinal.falhou", { erro: detalheErro(error) });
    return null;
  }
  const deadline = Date.now() + SUPERVISOR_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let raw = "";
    try { raw = fs.readFileSync(resultPath, "utf8"); } catch {}
    if (raw) {
      try {
        const result = parseCleanupResult(raw);
        // O resultado vem de um arquivo em pasta do usuario: so vale se nada do WireSock continua rodando.
        if (result.stopped && await isWireSockActiveAsync()) {
          logger.warn("wiresock", "supervisor.resultado.divergente", { acao: "usando a limpeza elevada" });
          return null;
        }
        tunnelSupervisor = null;
        // O supervisor remove o sinal ao sair; se ele nao conseguir (arquivo em uso), o app garante.
        limparSinalDoSupervisor(supervisor.stopFlagPath);
        logger.logEvent(result.stopped ? "info" : "warn", "wiresock", "cleanup.result", { phase: "cleanup", via: "supervisor" }, result as unknown as logger.LogContext);
        return result;
      } catch {
        // Arquivo ainda sendo escrito: tenta de novo.
      }
    }
    await esperar(250);
  }
  logger.warn("wiresock", "supervisor.sem-resposta", { prazo_ms: SUPERVISOR_STOP_TIMEOUT_MS, acao: "usando a limpeza elevada" });
  return null;
}

/** Stops only the GUI's exact profile; the ownership check is repeated under UAC by the cleanup worker. */
export async function stopWireSockService(configPath = defaultGuiWireSockConfig()): Promise<WireSockCleanupResult> {
  const empty: WireSockCleanupResult = {
    stopped: true, attempts: 0, resetNetworkLock: false, dnsCleared: false,
    dnsFlushed: false, servicesResidual: [], processResidual: false, residual: [],
  };
  if (process.platform !== "win32") return empty;
  // Sem UAC: o supervisor elevado que a ativacao deixou vivo para o proprio tunel.
  const viaSupervisor = await stopViaSupervisor();
  if (viaSupervisor) return viaSupervisor;
  const inspection = await inspectGuiWireSock(configPath);
  const refused = (reason: string): WireSockCleanupResult => ({
    ...empty, stopped: false, servicesResidual: inspection.services,
    processResidual: inspection.processIds.length > 0 || !inspection.reliable, residual: [reason],
  });
  if (inspection.reliable && inspection.active && !inspection.owned) {
    const result = refused(inspection.reason || "WireSock externo ou desconhecido; limpeza recusada.");
    logger.warn("wiresock", "limpeza recusada para preservar WireSock externo ou desconhecido", { residual: result.residual });
    return result;
  }
  // Inspecao "nao confiavel" (comum com o tunel elevado) nao pede mais um UAC so para inspecionar: o
  // script elevado da limpeza repete a checagem de dono e falha fechada (WIRESOCK_EXTERNAL /
  // WIRESOCK_INSPECTION_FAILED) sem parar nada alheio. So se pula esse UAC quando da para ver, sem
  // administrador, que ha WireSock rodando; sem nada rodando nao se pede UAC nenhum.
  if (inspection.reliable ? !inspection.active : !(await isWireSockActiveAsync())) return empty;
  try {
    const raw = await runElevatedWireSockWorker(resultPath => wireSockCleanupScript(configPath, resultPath));
    const result = parseCleanupResult(raw);
    logger.logEvent(result.stopped ? "info" : "warn", "wiresock", "cleanup.result", { phase: "cleanup" }, result as unknown as logger.LogContext);
    return result;
  } catch (error) {
    const result = refused(detalheErro(error));
    logger.warn("wiresock", "limpeza propria nao foi confirmada", { residual: result.residual });
    return result;
  }
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
 * Amostras consecutivas distinguem resposta isolada de conectividade estável
 * no diagnóstico assíncrono. Seu resultado nunca bloqueia a abertura do Discord.
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

export interface WireSockRecoveryResult extends WireSockCleanupResult {
  ok: boolean;
  error?: string;
  networkRestore: WireSockNetworkRestoreResult;
}

/**
 * The sole recovery path used by deactivate, route changes and Restore internet.
 * The vendor network restore runs only when the cheap residue check finds
 * something that can hold traffic (orphan default route on the virtual adapter,
 * or the driver loaded with no client to undo it), or when the caller forces it
 * because the network itself is down.
 */
export async function recoverWireSockNetwork(options: { forceNetworkRestore?: boolean } = {}): Promise<WireSockRecoveryResult> {
  const cleanup = await stopWireSockService();
  // Public endpoints are asynchronous diagnostics, never an OS cleanup gate.
  void verifyWindowsNetworkStable().then((network) => {
    logger.info("wiresock", "network.diagnostic", { ...network, mode: "log-only" });
  }).catch((error) => logger.warn("wiresock", "network.diagnostic.error", { erro: String((error as Error)?.message ?? error) }));
  const networkRestore = await restoreWireSockNetwork("recuperacao", { force: options.forceNetworkRestore });
  const result: WireSockRecoveryResult = {
    ...cleanup,
    ok: cleanup.stopped && (networkRestore.ok || !networkRestore.executed),
    networkRestore,
  };
  if (cleanup.stopped && !networkRestore.ok) {
    result.error = `A rede do Windows não foi confirmada: ${networkRestore.residual.join("; ") || "sem detalhes"}.`;
  }
  logger.info("wiresock", "recuperacao de rede concluida", result as unknown as logger.LogContext);
  return result;
}

function isServiceRunning(name: string): boolean {
  try {
    const out = execFileSync("sc.exe", ["query", name], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    return /STATE\s*:\s*\d+\s+RUNNING/i.test(out);
  } catch {
    return false;
  }
}
