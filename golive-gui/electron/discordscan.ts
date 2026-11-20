// Instrumentacao da deteccao do Discord — categoria "discord" no logger.
// Objetivo: quando a GUI NAO acha o Discord, o report de bug tem pistas do
// porque (raizes testadas, installs achados, stderr do script Linux, pgrep).

import { createHash } from "crypto";
import * as logger from "./logger";

// Fase 5 (#300): o diagnostico de scan NAO carrega o caminho cru do usuario.
// Raizes conhecidas viram placeholder (%LOCALAPPDATA%, %PROGRAMFILES%, <usuario>);
// um trecho fora do layout conhecido do cliente vira hash curto; tudo passa por
// clipping. Nunca entram CommandLine, argumentos, stdout, PID ou segredos.
const DISCOVERY_PATH_MAX = 160;
const DISCOVERY_TAIL_MAX = 96;
const DISCOVERY_SEGMENT =
  /^(?:Programs|resources|Applications|app-[^\\/]+|(?:Discord|DiscordPTB|DiscordCanary|Vesktop|Equibop|Legcord)(?:\.exe)?|Update\.exe|[^\\/]+\.app)$/i;
const DISCOVERY_ENV_PLACEHOLDERS: ReadonlyArray<readonly [string, string]> = [
  ["LOCALAPPDATA", "%LOCALAPPDATA%"],
  ["APPDATA", "%APPDATA%"],
  ["ProgramData", "%PROGRAMDATA%"],
  ["ProgramFiles", "%PROGRAMFILES%"],
  ["ProgramFiles(x86)", "%PROGRAMFILES(X86)%"],
  ["ProgramW6432", "%PROGRAMW6432%"],
  ["PUBLIC", "%PUBLIC%"],
  ["TEMP", "%TEMP%"],
  ["USERPROFILE", "<usuario>"],
  ["HOME", "<usuario>"],
];
// Raizes fixas que nao identificam o usuario e podem aparecer como estao (mac).
const DISCOVERY_FIXED_ROOTS: readonly string[] = ["/Applications"];
// A varredura roda a cada leitura de status e, sem controle, enche o ring buffer (e o relatorio
// de bug, que tem teto de tamanho) com a mesma foto do disco: no relatorio #370, 84% das linhas
// eram isso e o miolo da sessao foi cortado. Cada linha identica so e registrada de novo depois
// desta janela, o que mantem uma varredura recente em todo relatorio; se algo muda (um install
// novo, outro total), a linha nova tem outro conteudo e entra na hora.
const DISCOVERY_LOG_DEDUPE_MS = 10 * 60_000;
const DISCOVERY_LOG_DEDUPE_MAX = 500;
const recentDiscoveryLines = new Map<string, number>();

function logDiscoveryOnce(msg: string, data: Record<string, unknown>): void {
  const key = `${msg}|${JSON.stringify(data)}`;
  const now = Date.now();
  const previous = recentDiscoveryLines.get(key);
  if (previous !== undefined && now >= previous && now - previous < DISCOVERY_LOG_DEDUPE_MS) return;
  if (recentDiscoveryLines.size >= DISCOVERY_LOG_DEDUPE_MAX) {
    for (const [oldKey, at] of recentDiscoveryLines) {
      if (now < at || now - at >= DISCOVERY_LOG_DEDUPE_MS) recentDiscoveryLines.delete(oldKey);
    }
    if (recentDiscoveryLines.size >= DISCOVERY_LOG_DEDUPE_MAX) recentDiscoveryLines.clear();
  }
  recentDiscoveryLines.set(key, now);
  logger.info("discord", msg, data);
}

export function _resetDiscoveryLogDedupe(): void {
  recentDiscoveryLines.clear();
}

function clipDiscoveryValue(value: string, max = DISCOVERY_PATH_MAX): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function sanitizeDiscoveryErrorDetail(value: string): string {
  return value
    .split(/\r?\n/, 1)[0]
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*/g, "[path]")
    .replace(/[,;]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DISCOVERY_TAIL_MAX);
}

function shortDiscoveryHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function isUnderDiscoveryBase(value: string, base: string): boolean {
  const normalized = base.replace(/[\\/]+$/, "").toLowerCase();
  if (!normalized) return false;
  const candidate = value.toLowerCase();
  return candidate === normalized ||
    candidate.startsWith(`${normalized}\\`) ||
    candidate.startsWith(`${normalized}/`);
}

// Depois do placeholder, so o layout conhecido do cliente pode aparecer; um
// segmento fora dele (pasta customizada do usuario) e trocado por hash.
function sanitizeDiscoveryTail(tail: string): string {
  const segments = tail.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.every((segment) => DISCOVERY_SEGMENT.test(segment))) {
    return clipDiscoveryValue(tail, DISCOVERY_TAIL_MAX);
  }
  return `<hash:${shortDiscoveryHash(tail)}>`;
}

// Nunca devolve o caminho cru: raizes de perfil viram placeholder e caminhos
// arbitrarios viram hash curto nao reversivel operacionalmente.
export function sanitizeDiscoveryPath(value: string | undefined): string {
  if (typeof value !== "string") return "ausente";
  const raw = value.trim();
  if (!raw) return "ausente";
  for (const [name, placeholder] of DISCOVERY_ENV_PLACEHOLDERS) {
    const base = (process.env[name] ?? "").trim();
    if (!base || !isUnderDiscoveryBase(raw, base)) continue;
    const tail = raw.slice(base.replace(/[\\/]+$/, "").length);
    return clipDiscoveryValue(`${placeholder}${sanitizeDiscoveryTail(tail)}`);
  }
  for (const base of DISCOVERY_FIXED_ROOTS) {
    if (!isUnderDiscoveryBase(raw, base)) continue;
    const tail = raw.slice(base.replace(/[\\/]+$/, "").length);
    return clipDiscoveryValue(`${base}${sanitizeDiscoveryTail(tail)}`);
  }
  return clipDiscoveryValue(`<path:${shortDiscoveryHash(raw)}>`);
}

export function scanInicio(plataforma: string, localAppData?: string) {
  const data: Record<string, unknown> = { plataforma };
  if (plataforma === "win32") data.localappdata = sanitizeDiscoveryPath(localAppData);
  logDiscoveryOnce("scan.inicio", data);
}

// Cada raiz/flavour testado: raiz + resultado do existsSync. A raiz entra
// sanitizada (placeholder/hash), nunca o caminho cru.
export function scanRaiz(raiz: string, existe: boolean, flavour?: string) {
  const data: Record<string, unknown> = {
    raiz: sanitizeDiscoveryPath(raiz),
    existe: existe ? "sim" : "nao",
  };
  if (flavour) data.flavour = flavour;
  logDiscoveryOnce("scan.raiz", data);
}

// Resumo das raizes testadas. A lista das raizes vem do ambiente e e a mesma em toda maquina; as
// que nao existem (sempre a maioria: 6 clientes x 7 pastas) ocupavam 12-30% dos relatos. Quem
// chama registra so as raizes encontradas (scanRaiz) e esta contagem.
export function scanRaizes(testadas: number, achadas: number) {
  logDiscoveryOnce("scan.raizes", { testadas, achadas });
}

// Um install valido (app.asar ou _app.asar presentes). O resources entra
// sanitizado (placeholder/hash), nunca o caminho cru.
export function scanInstall(resources: string, flavour: string) {
  logDiscoveryOnce("scan.install", { resources: sanitizeDiscoveryPath(resources), flavour });
}

export function scanResultado(total: number) {
  logDiscoveryOnce("scan.resultado", { total });
}

export function runningPgrep(processo: string, ok: boolean, erro?: string) {
  const data: Record<string, unknown> = { processo, ok: ok ? "sim" : "nao" };
  if (erro) data.erro = erro;
  logDiscoveryOnce("running.pgrep", data);
}

export function runningTasklist(imagem: string, ok: boolean, erro?: string) {
  const data: Record<string, unknown> = { imagem, ok: ok ? "sim" : "nao" };
  if (erro) data.erro = erro;
  logDiscoveryOnce("running.tasklist", data);
}

// Resultado do script Linux --status --json: code + se o JSON parseou.
// O stderr (banner, avisos) nao vai mais como blob — as linhas de trace viram
// eventos proprios (scriptTrace) para o log ficar legivel.
// O --status roda a cada leitura de estado da GUI: as linhas abaixo passam pelo mesmo dedupe da
// varredura, entao so entram de novo quando mudam ou depois da janela.
// Falha nunca e suprimida: cada uma entra no log.
export function scriptStatus(code: number | null, jsonOk: boolean) {
  const data = { code, json_ok: jsonOk ? "sim" : "nao" };
  if (code !== 0 || !jsonOk) {
    logger.warn("discord", "script.status", data);
    return;
  }
  logDiscoveryOnce("script.status", data);
}

// Uma linha de aviso/trace do script (ex.: "trace: varridas 5 blocos, achei 1").
export function scriptTrace(linha: string) {
  logDiscoveryOnce("script.trace", { msg: linha.slice(0, 200) });
}

// Cada Discord que o script Linux encontrou (vem do JSON, com estado).
export function scriptInstall(
  path: string,
  state: string,
  extras?: { flavour?: string; detected_by?: string; flatpak_id?: string },
) {
  const data: Record<string, unknown> = { path, state };
  if (extras?.flavour) data.flavour = extras.flavour;
  if (extras?.detected_by) data.detected_by = extras.detected_by;
  if (extras?.flatpak_id) data.flatpak_id = extras.flatpak_id;
  logDiscoveryOnce("script.install", data);
}

export function scriptJsonInvalido(stdout: string) {
  logger.warn("discord", "script.json_invalido", { stdout_tail: stdout.slice(0, 200) });
}

// A ativacao falhou por nao achar o Discord: loga o resumo antes do throw.
export function ativacaoSemDiscord(motivo: string) {
  logger.warn("discord", "ativacao.sem_discord", { motivo });
}
export type DiscoveryScanSource = "root" | "process" | "registry" | "shortcut";
export type DiscoveryScanStatus = "ok" | "empty" | "partial" | "error";

export interface DiscoveryScanFonteExtras {
  total?: number;
  truncated?: boolean;
  errorCode?: string;
  errorDetail?: string;
}

// Resultado de uma fonte pontual. "truncated" so aparece quando o teto de coleta
// foi atingido; errorCode so carrega o codigo estavel daquela fonte (nunca a
// excecao crua nem um caminho).
export function scanFonte(
  origem: DiscoveryScanSource,
  status: DiscoveryScanStatus,
  extras: DiscoveryScanFonteExtras = {},
) {
  const data: Record<string, unknown> = { origem, status };
  if (typeof extras.total === "number") data.total = extras.total;
  if (extras.truncated) data.truncated = "sim";
  if (extras.errorCode) data.error_code = extras.errorCode;
  if (extras.errorDetail) data.error_detail = sanitizeDiscoveryErrorDetail(extras.errorDetail);
  logger.info("discord", "scan.fonte", data);
}

// Candidato aceito, sem path. detected_by e a origem de maior precedencia que
// venceu a deduplicacao para este flavour.
export function scanCandidato(flavour: string, detectedBy: DiscoveryScanSource) {
  logDiscoveryOnce("scan.candidato", { flavour, detected_by: detectedBy });
}
