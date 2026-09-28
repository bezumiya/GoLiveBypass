// Transporte WireGuard do macOS.
//
// O macOS nao tem primitiva de roteamento por processo sem Network Extension
// assinada (WireSock/WFP no Windows, network namespace no Linux). O helper
// `golive-tunnel` (tools/proton-confgen/cmd/golive-tunnel) sobe uma utun com
// wireguard-go e instala rotas somente para os destinos do Discord: blocos da
// Discord Inc. (voz) e os IPs Cloudflare dedicados do gateway/API. O restante
// do computador continua na rede normal.
//
// O helper roda como root (criar utun e rotas exige isso) e e lancado pelo
// prompt de administrador do proprio macOS via osascript. Depois disso a GUI o
// controla sem privilegio por um socket Unix em /var/run, que so aceita o uid
// do usuario que ativou (LOCAL_PEERCRED). A configuracao WireGuard viaja pelo
// socket: o processo root nunca le arquivos da pasta do usuario.

import { execFile, execFileSync } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { macHelperCandidates, type ProtonRuntimeContext } from "./proton-runtime";
import type { WgTunnelStats } from "./wgstats";

export const MAC_TUNNEL_DIR = "/var/run/golivebypass";
export const MAC_TUNNEL_SOCKET = `${MAC_TUNNEL_DIR}/tunnel.sock`;
export const MAC_TUNNEL_LOG = `${MAC_TUNNEL_DIR}/tunnel.log`;
export const MAC_TUNNEL_REJECT_ROUTES = `${MAC_TUNNEL_DIR}/reject-routes`;
export const MAC_TUNNEL_HELPER = "golive-tunnel";
/** Rota sentinela: o bloco de voz da Discord Inc. so existe na utun enquanto o helper vive. */
export const MAC_TUNNEL_SENTINEL_ROUTE = "66.22.192/18";

const LAUNCH_TIMEOUT_MS = 120_000;
const SOCKET_READY_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;

export interface MacTunnelResponse {
  ok: boolean;
  error?: string;
  protocol?: number;
  pid?: number;
  configured?: boolean;
  interface?: string;
  addresses?: string[];
  routes?: number;
  startedAt?: string;
  stats?: { handshakeAgoS: number | null; rxBytes: number | null; txBytes: number | null; endpoint: string };
  logs?: string[];
}

export interface MacTunnelStatus {
  running: boolean;
  configured: boolean;
  interfaceName: string | null;
  pid: number | null;
  routes: number;
  logs: string[];
  error?: string;
}

export class MacTunnelAuthorizationCancelled extends Error {
  constructor() {
    super("A autorização de administrador foi cancelada.");
    this.name = "MacTunnelAuthorizationCancelled";
  }
}

export function findMacHelper(name: string, context: ProtonRuntimeContext): string | undefined {
  return macHelperCandidates(name, context).find((candidate) => {
    try {
      const stat = fs.statSync(candidate);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Script AppleScript que lanca o helper como root. O `do shell script` so
 * retorna quando ninguem mais segura o stdout dele: por isso o helper nasce
 * num comando proprio (depois do `;` -- com `&&` o `&` mandaria a lista
 * inteira para uma subshell que herda o pipe) e com stdin/stdout/stderr
 * desviados.
 */
export function buildMacTunnelLaunchScript(helperPath: string, ownerUid: number): string {
  if (!path.isAbsolute(helperPath)) throw new Error("O caminho do helper precisa ser absoluto.");
  if (!Number.isInteger(ownerUid) || ownerUid < 0) throw new Error("uid inválido.");
  const prepare = [
    `/bin/mkdir -p ${shellQuote(MAC_TUNNEL_DIR)}`,
    `/usr/sbin/chown root:wheel ${shellQuote(MAC_TUNNEL_DIR)}`,
    `/bin/chmod 755 ${shellQuote(MAC_TUNNEL_DIR)}`,
  ].join(" && ");
  const launch = `${shellQuote(helperPath)} serve --owner-uid ${ownerUid} --socket ${shellQuote(MAC_TUNNEL_SOCKET)} < /dev/null >> ${shellQuote(MAC_TUNNEL_LOG)} 2>&1 &`;
  const shell = `${prepare} || exit 1; ${launch}`;
  const prompt = "O GoLiveBypass precisa criar um túnel WireGuard só para o Discord.";
  return `do shell script ${appleScriptString(shell)} with prompt ${appleScriptString(prompt)} with administrator privileges`;
}

/**
 * Script para encerrar um helper que não responde mais ao socket. As rotas da
 * utun somem com o processo; as de rejeição IPv6 (via loopback) não, então o
 * helper mantém a lista delas em MAC_TUNNEL_REJECT_ROUTES.
 */
export function buildMacTunnelForceStopScript(): string {
  const list = shellQuote(MAC_TUNNEL_REJECT_ROUTES);
  const shell = [
    `/usr/bin/pkill -TERM -x ${MAC_TUNNEL_HELPER}`,
    "/bin/sleep 1",
    `/usr/bin/pkill -KILL -x ${MAC_TUNNEL_HELPER}`,
    `if [ -f ${list} ]; then while read -r r; do [ -n "$r" ] && /sbin/route -q -n delete -inet6 "$r" ::1; done < ${list}; /bin/rm -f ${list}; fi`,
    `/bin/rm -f ${shellQuote(MAC_TUNNEL_SOCKET)}`,
    "exit 0",
  ].join("; ");
  const prompt = "O GoLiveBypass precisa encerrar o túnel do Discord para restaurar a rede.";
  return `do shell script ${appleScriptString(shell)} with prompt ${appleScriptString(prompt)} with administrator privileges`;
}

export type OsaRunner = (script: string, timeoutMs: number) => Promise<void>;

export const runOsascript: OsaRunner = (script, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      // -128 = "User canceled." no prompt de administrador.
      if (/-128|User canceled|cancelad/i.test(String(stderr))) return reject(new MacTunnelAuthorizationCancelled());
      reject(new Error(String(stderr || error.message).trim().slice(0, 300)));
    });
  });

export function sendMacTunnelCommand(
  request: { cmd: "status" | "stop" | "configure" | "pause"; config?: string },
  options: { socketPath?: string; timeoutMs?: number } = {},
): Promise<MacTunnelResponse> {
  const socketPath = options.socketPath ?? MAC_TUNNEL_SOCKET;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const socket = net.createConnection(socketPath);
    const finish = (error: Error | null, value?: MacTunnelResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value as MacTunnelResponse);
    };
    const timer = setTimeout(() => finish(new Error("o helper do túnel não respondeu a tempo")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)) as MacTunnelResponse);
      } catch {
        finish(new Error("resposta inválida do helper do túnel"));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(new Error("o helper do túnel fechou a conexão sem responder")));
  });
}

export function toMacTunnelStatus(response: MacTunnelResponse | null, error?: string): MacTunnelStatus {
  if (!response) {
    return { running: false, configured: false, interfaceName: null, pid: null, routes: 0, logs: [], error };
  }
  return {
    running: true,
    configured: response.configured === true,
    interfaceName: response.interface || null,
    pid: typeof response.pid === "number" ? response.pid : null,
    routes: typeof response.routes === "number" ? response.routes : 0,
    logs: Array.isArray(response.logs) ? response.logs.slice(-40) : [],
    error: response.ok ? undefined : response.error,
  };
}

export async function getMacTunnelStatus(socketPath = MAC_TUNNEL_SOCKET): Promise<MacTunnelStatus> {
  try {
    return toMacTunnelStatus(await sendMacTunnelCommand({ cmd: "status" }, { socketPath, timeoutMs: 3_000 }));
  } catch (error) {
    return toMacTunnelStatus(null, String((error as Error)?.message ?? error));
  }
}

export function macTunnelStatsFromResponse(response: MacTunnelResponse | null, error?: string): WgTunnelStats {
  const stats = response?.stats;
  if (!response || !response.configured || !stats) {
    return { ok: false, handshakeAgoS: null, rxBytes: null, txBytes: null, endpoint: null, error: error || "túnel macOS sem peer configurado" };
  }
  return {
    ok: true,
    handshakeAgoS: typeof stats.handshakeAgoS === "number" ? stats.handshakeAgoS : null,
    rxBytes: typeof stats.rxBytes === "number" ? stats.rxBytes : null,
    txBytes: typeof stats.txBytes === "number" ? stats.txBytes : null,
    endpoint: stats.endpoint || null,
  };
}

export async function getMacTunnelStats(socketPath = MAC_TUNNEL_SOCKET): Promise<WgTunnelStats> {
  try {
    return macTunnelStatsFromResponse(await sendMacTunnelCommand({ cmd: "status" }, { socketPath, timeoutMs: 3_000 }));
  } catch (error) {
    return macTunnelStatsFromResponse(null, String((error as Error)?.message ?? error));
  }
}

/** Procura a rota sentinela numa utun na tabela IPv4 (`netstat -rn -f inet`). */
export function parseMacSentinelRoute(netstatOutput: string): string | null {
  for (const line of netstatOutput.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== MAC_TUNNEL_SENTINEL_ROUTE) continue;
    const iface = columns.find((column) => /^utun\d+$/.test(column));
    if (iface) return iface;
  }
  return null;
}

/** Leitura síncrona e sem privilégio usada pelo getStatus() da GUI. */
export function macTunnelRouteInterfaceSync(): string | null {
  try {
    const output = execFileSync("/usr/sbin/netstat", ["-rn", "-f", "inet"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    });
    return parseMacSentinelRoute(output);
  } catch {
    return null;
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

export interface MacTunnelHelperOptions {
  helperPath: string;
  ownerUid?: number;
  socketPath?: string;
  osascript?: OsaRunner;
}

/**
 * Garante o helper vivo. Só este passo pede a senha de administrador; se o
 * usuário cancelar, nada na rede nem no Discord foi alterado ainda.
 */
export async function ensureMacTunnelHelper(options: MacTunnelHelperOptions): Promise<MacTunnelStatus> {
  const socketPath = options.socketPath ?? MAC_TUNNEL_SOCKET;
  const current = await getMacTunnelStatus(socketPath);
  if (current.running) return current;
  const uid = options.ownerUid ?? process.getuid?.() ?? -1;
  await (options.osascript ?? runOsascript)(buildMacTunnelLaunchScript(options.helperPath, uid), LAUNCH_TIMEOUT_MS);
  const ready = await waitFor(async () => (await getMacTunnelStatus(socketPath)).running, SOCKET_READY_TIMEOUT_MS);
  if (!ready) throw new Error(`O helper do túnel não iniciou. Veja ${MAC_TUNNEL_LOG}.`);
  return getMacTunnelStatus(socketPath);
}

/** Aplica (ou troca) o perfil WireGuard no helper já vivo, sem novo prompt. */
export async function configureMacTunnel(configText: string, socketPath = MAC_TUNNEL_SOCKET): Promise<MacTunnelStatus> {
  const response = await sendMacTunnelCommand({ cmd: "configure", config: configText }, { socketPath, timeoutMs: 20_000 });
  const status = toMacTunnelStatus(response);
  if (!response.ok || !status.configured) throw new Error(response.error || "O helper recusou a configuração WireGuard.");
  return status;
}

/** Remove o peer mantendo utun e rotas (o Discord fica sem rede, não vaza). */
export async function pauseMacTunnel(socketPath = MAC_TUNNEL_SOCKET): Promise<void> {
  const response = await sendMacTunnelCommand({ cmd: "pause" }, { socketPath });
  if (!response.ok) throw new Error(response.error || "O helper não pausou o túnel.");
}

export async function startMacTunnel(configText: string, options: MacTunnelHelperOptions): Promise<MacTunnelStatus> {
  await ensureMacTunnelHelper(options);
  return configureMacTunnel(configText, options.socketPath);
}

export interface StopMacTunnelResult {
  ok: boolean;
  residual: string[];
  error?: string;
}

export async function stopMacTunnel(options: { socketPath?: string; osascript?: OsaRunner; force?: boolean; routeInterface?: () => string | null } = {}): Promise<StopMacTunnelResult> {
  const socketPath = options.socketPath ?? MAC_TUNNEL_SOCKET;
  const routeInterface = options.routeInterface ?? macTunnelRouteInterfaceSync;
  const gone = async () => !(await getMacTunnelStatus(socketPath)).running && routeInterface() === null;

  const before = await getMacTunnelStatus(socketPath);
  if (before.running) {
    await sendMacTunnelCommand({ cmd: "stop" }, { socketPath }).catch(() => undefined);
    if (await waitFor(gone, STOP_TIMEOUT_MS)) return { ok: true, residual: [] };
  } else if (routeInterface() === null) {
    return { ok: true, residual: [] };
  }

  // Helper travado ou morto sem limpar: só o root encerra o processo. Com a
  // utun fechada, o kernel remove as rotas -interface junto.
  if (options.force) {
    try {
      await (options.osascript ?? runOsascript)(buildMacTunnelForceStopScript(), LAUNCH_TIMEOUT_MS);
    } catch (error) {
      return { ok: false, residual: residualOf(await getMacTunnelStatus(socketPath), routeInterface()), error: String((error as Error)?.message ?? error) };
    }
    if (await waitFor(gone, STOP_TIMEOUT_MS)) return { ok: true, residual: [] };
  }
  const residual = residualOf(await getMacTunnelStatus(socketPath), routeInterface());
  return { ok: residual.length === 0, residual, error: residual.length ? "o túnel do Discord continua ativo" : undefined };
}

function residualOf(status: MacTunnelStatus, iface: string | null): string[] {
  const residual: string[] = [];
  if (status.running) residual.push(`helper pid ${status.pid ?? "?"}`);
  if (iface) residual.push(`rotas do Discord em ${iface}`);
  return residual;
}

/** Espera o primeiro handshake do peer para a troca de rota (failover/otimização). */
export async function waitForMacTunnelHandshake(timeoutMs: number, socketPath = MAC_TUNNEL_SOCKET): Promise<boolean> {
  return waitFor(async () => {
    const stats = await getMacTunnelStats(socketPath);
    return stats.ok && stats.handshakeAgoS !== null && stats.handshakeAgoS < 180;
  }, timeoutMs, 500);
}
