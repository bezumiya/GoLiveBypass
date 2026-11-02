// Logger proprio da GUI: arquivo rotacionado + ring buffer em memoria.
// Mesmo espirito do log() do standalone (golivebypass.js): simples, sem dependencias,
// e nunca derruba o app por falha de escrita.
//
// Formato das linhas (grep-friendly):
//   [HH:MM:SS] [nivel][categoria] mensagem | chave=valor chave=valor
//
// O patchConsole() intercepta console.log/info/warn/error do main process uma
// unica vez, entao todo o logging que ja existe ([tor], [updater], [restore],
// [settings]) passa a persistir em arquivo sem tocar nos pontos de chamada. A
// tag entre colchetes vira a categoria da linha.

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

export type Nivel = "info" | "warn" | "error";
export type LogContext = Record<string, string | number | boolean | null | undefined>;

const MAX_FILE_BYTES = 2 * 1024 * 1024; // rotacao igual ao standalone: corta pra metade
const RING_MAX = 1000; // linhas guardadas em memoria para o report
const RING_TAIL_BYTES = 128 * 1024; // teto do getRecent() (o total do report e limitado)

interface Entrada {
  linha: string;
  corpo: string; // linha sem o carimbo [HH:MM:SS]: e o que decide se repetiu
  n: number; // repeticoes consecutivas colapsadas (rajada de erro nao come o buffer)
  ultimaHora: string;
}

let arquivo = "";
const ring: Entrada[] = [];
// Tamanho conhecido do arquivo atual: evita existsSync+statSync a cada linha
// (eram tres syscalls sincronos por evento de log na thread principal).
let tamanhoArquivo = 0;

export function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function formatLine(
  nivel: Nivel,
  cat: string,
  msg: string,
  data?: Record<string, unknown>,
): string {
  const extras = data
    ? " | " +
      Object.entries(data)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v) ?? String(v)}`)
        .join(" ")
    : "";
  return `[${stamp()}] [${nivel}][${cat}] ${msg}${extras}`;
}

function gravar(linha: string) {
  if (!arquivo) return;
  try {
    const bytes = Buffer.byteLength(linha, "utf8") + 1;
    if (tamanhoArquivo + bytes > MAX_FILE_BYTES) {
      const conteudo = fs.readFileSync(arquivo, "utf8").slice(-MAX_FILE_BYTES / 2);
      fs.writeFileSync(arquivo, conteudo);
      tamanhoArquivo = Buffer.byteLength(conteudo, "utf8");
    }
    fs.appendFileSync(arquivo, linha + "\n");
    tamanhoArquivo += bytes;
  } catch {
    // Ficar sem registro e ruim; derrubar o app por causa do registro e pior.
  }
}

// Toda linha comeca com "[HH:MM:SS] " (stamp()).
const horaDa = (linha: string) => linha.slice(1, 9);

function empilhar(linha: string) {
  // Comparar a linha inteira so colapsava repeticoes no mesmo segundo.
  const hora = horaDa(linha);
  const corpo = linha.slice(11);
  const ultima = ring[ring.length - 1];
  if (ultima && ultima.corpo === corpo) {
    ultima.n += 1;
    ultima.ultimaHora = hora;
    return;
  }
  ring.push({ linha, corpo, n: 1, ultimaHora: hora });
  if (ring.length > RING_MAX) ring.shift();
}

export function escrever(
  nivel: Nivel,
  cat: string,
  msg: string,
  data?: Record<string, unknown>,
) {
  const linha = formatLine(nivel, cat, msg, data);
  gravar(linha);
  empilhar(linha);
}

export function info(cat: string, msg: string, data?: Record<string, unknown>) {
  escrever("info", cat, msg, data);
}
export function warn(cat: string, msg: string, data?: Record<string, unknown>) {
  escrever("warn", cat, msg, data);
}
export function error(cat: string, msg: string, data?: Record<string, unknown>) {
  escrever("error", cat, msg, data);
}

export function createOperationId(prefix: string): string {
  const safePrefix = prefix.trim().replace(/[^A-Za-z0-9_-]+/g, "-") || "operation";
  return safePrefix + "-" + randomUUID();
}

export function clipLogText(value: unknown, max = 2000): string {
  const limit = Math.max(1, Math.floor(max));
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

const SENSITIVE_LOG_KEY = /password|senha|token|secret|private(?:key|_key)?|session|credential|auth/i;

export function redactLogValue(value: unknown, key = ""): string {
  if (SENSITIVE_LOG_KEY.test(key)) return "[redacted]";
  return clipLogText(value, 4000)
    .replace(/((?:password|senha|token|secret|privatekey|private_key|session|credential|auth)[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
}

export function logEvent(
  nivel: Nivel,
  cat: string,
  event: string,
  context: LogContext,
  data?: LogContext,
): void {
  const merged = Object.fromEntries(
    Object.entries({ ...context, ...data })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, redactLogValue(value, key)]),
  );
  escrever(nivel, cat, event, merged);
}

export function initLogger(dir: string) {
  try {
    // /proc e /sys sao filesystems virtuais: mkdirSync recursive trava (hang) em vez de falhar rapido
    if (/^\/(proc|sys)(\/|$)/.test(dir)) throw new Error("caminho virtual nao gravavel");
    fs.mkdirSync(dir, { recursive: true });
    arquivo = path.join(dir, "gui.log");
    try {
      tamanhoArquivo = fs.statSync(arquivo).size;
    } catch {
      tamanhoArquivo = 0; // primeira gravacao cria o arquivo
    }
  } catch {
    arquivo = ""; // sem pasta de dados, segue so o ring em memoria
    tamanhoArquivo = 0;
  }
}

// Buffer serializado (mais antigo -> mais recente), respeitando o teto de bytes
// a partir do fim: o mais recente e o que importa num diagnostico.
export function getRecent(): string {
  const escolhidas: string[] = [];
  let bytes = 0;
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i];
    const ate = e.ultimaHora !== horaDa(e.linha) ? `, ate ${e.ultimaHora}` : "";
    const texto = e.n > 1 ? `${e.linha} (x${e.n}${ate})` : e.linha;
    const custo = Buffer.byteLength(texto, "utf8");
    const sep = escolhidas.length ? 1 : 0; // "\n" entre linhas
    // Um teste de regressao cobre este teto: nem a primeira linha pode estoura-lo.
    if (bytes + custo + sep > RING_TAIL_BYTES) break;
    bytes += custo + sep;
    escolhidas.push(texto);
  }
  escolhidas.reverse();
  return escolhidas.join("\n");
}

// Linha do getRecent() como foi gravada no arquivo (sem o sufixo de repeticao).
export function semRepeticao(linha: string): string {
  return linha.replace(/ \(x\d+(?:, ate \d{2}:\d{2}:\d{2})?\)$/, "");
}

// Uso exclusivo de testes: o estado e de modulo, cada teste recomeca do zero.
export function _resetForTests() {
  ring.length = 0;
  arquivo = "";
  tamanhoArquivo = 0;
}

// ---------------------------------------------------------------------------
// Tee do console: mantem a saida original (dev/terminal) e persiste no logger.
// ---------------------------------------------------------------------------

type ConsoleMethod = (...a: unknown[]) => void;
let consolaOriginal: {
  log: ConsoleMethod;
  info: ConsoleMethod;
  warn: ConsoleMethod;
  error: ConsoleMethod;
} | null = null;

// Tags que ja existem espalhadas no codigo -> categorias canonicas do formato.
const CAT_MAP: Record<string, string> = {
  tor: "tor",
  updater: "updater",
  restore: "app",
  settings: "app",
};

function stringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

export function patchConsole(alvo: {
  log: ConsoleMethod;
  info: ConsoleMethod;
  warn: ConsoleMethod;
  error: ConsoleMethod;
} = console): () => void {
  if (consolaOriginal) return () => {};
  consolaOriginal = {
    log: alvo.log,
    info: alvo.info,
    warn: alvo.warn,
    error: alvo.error,
  };

  const interceptar =
    (nivel: Nivel, original: ConsoleMethod) => {
      const chamadaOriginal = original.bind(alvo);
      return (...args: unknown[]) => {
        try {
          chamadaOriginal(...args);
        } catch {
          // A saida original pode falhar (por exemplo, EIO/EPIPE); o tee segue.
        }
        try {
          const texto = args.map(stringifyArg).join(" ");
          const m = /^\[([A-Za-z-]+)\]/.exec(texto);
          const cat = m ? (CAT_MAP[m[1].toLowerCase()] ?? m[1].toLowerCase()) : "app";
          escrever(nivel, cat, m ? texto.slice(m[0].length).trimStart() : texto);
        } catch {
          // O tee jamais pode propagar erro pra dentro do app que esta logando.
        }
      };
    };

  alvo.log = interceptar("info", consolaOriginal.log);
  alvo.info = interceptar("info", consolaOriginal.info);
  alvo.warn = interceptar("warn", consolaOriginal.warn);
  alvo.error = interceptar("error", consolaOriginal.error);

  return () => {
    if (!consolaOriginal) return;
    alvo.log = consolaOriginal.log;
    alvo.info = consolaOriginal.info;
    alvo.warn = consolaOriginal.warn;
    alvo.error = consolaOriginal.error;
    consolaOriginal = null;
  };
}
