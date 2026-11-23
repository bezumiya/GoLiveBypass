// Alarme da versão do app na API da Proton.
//
// O helper Go (tools/proton-confgen) se identifica com x-pm-appversion
// linux-vpn-gui@<ClientVersion>+<arquitetura> e User-Agent ProtonVPN/<ClientVersion> (Linux; ubuntu/26.04),
// com ClientVersion de tools/proton-confgen/internal/constants/api.go. Em 2026-11-19 a Proton passou
// a responder HTTP 422 com Code 5003 ("This version of the app is no longer supported") ao
// identificador da época e ninguém conseguiu fazer login até sair uma release. Um workflow agendado
// roda este script para descobrir a recusa antes dos usuários.
//
// Uso: node scripts/check-proton-app-version.mjs (Node 20+, sem dependências)
//
// Saída: uma linha JSON no stdout,
//   {"status","clientVersion","arch","appVersion","httpStatus","code","message","latestVersion","behind"}
// Avisos e erros vão para o stderr (como anotações quando roda no GitHub Actions). Da resposta da
// Proton só saem Code e Error.
//
// status e código de saída:
//   accepted         0  Code 1000 ou 1001 com HTTP 2xx
//   inconclusive     0  rede, 5xx, 429 ou Code inesperado: sem alarme, a próxima execução confere de novo
//   rejected         1  Code 5001, 5003 ou 5005: a Proton recusa a versão e o login de todos está quebrado
//   invalid_request  2  Code 5002 ou 2064: o x-pm-appversion da própria checagem está ausente ou malformado
//   (sem JSON)       2  erro interno: api.go ilegível, versão fora de X.Y.Z, variável de ambiente inválida
//
// Variáveis de ambiente:
//   PROTON_CLIENT_VERSION  substitui o ClientVersion de api.go (X.Y.Z); x-pm-appversion e User-Agent derivam dele
//   PROTON_ARCH            arquitetura do x-pm-appversion (padrão x86-64; o helper do macOS Apple Silicon envia aarch64)
//   PROTON_APP_VERSION     x-pm-appversion inteiro; vence as duas acima. O workflow usa para conferir o par
//                          literal de um helper anterior ao ClientVersion (a macos-v0.8.0 manda linux-vpn@4.17.2)
//   PROTON_USER_AGENT      User-Agent inteiro, o par de PROTON_APP_VERSION; sem ele, deriva da versão do cliente
//   PROTON_API_URL        base da API (padrão https://vpn-api.proton.me)
//   PROTON_VERSIONS_URL    versions.yml de referência (padrão: o do python-proton-vpn-api-core estável)
// No GitHub Actions, GITHUB_OUTPUT recebe status, client_version, latest_version, code, app_version,
// http_status e message, e GITHUB_STEP_SUMMARY recebe um resumo em Markdown. message vem da Proton, que
// ecoa o cabeçalho recebido: no workflow, passe-o por env:, nunca interpolado em run: (por garantia, os
// valores de GITHUB_OUTPUT saem sem crases, cifrões, aspas e barras invertidas).

import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_API_URL = "https://vpn-api.proton.me";
// O cliente Linux oficial anuncia a versão do python-proton-vpn-api-core; o ramo stable é a que ele
// distribui.
export const DEFAULT_VERSIONS_URL =
  "https://raw.githubusercontent.com/ProtonVPN/python-proton-vpn-api-core/stable/versions.yml";
// Como o helper escreve amd64 (officialArch em api.go).
export const DEFAULT_ARCH = "x86-64";

const API_GO_PATH = ["tools", "proton-confgen", "internal", "constants", "api.go"];
const CLIENT_CONFIG_PATH = "/vpn/v2/clientconfig";
const API_TIMEOUT_MS = 20_000;
const VERSIONS_TIMEOUT_MS = 10_000;
// Pausa antes de cada nova tentativa: no máximo duas, e só após falha de rede, 5xx ou 429.
const RETRY_DELAYS_MS = [1_000, 3_000];
const MAX_MESSAGE_LENGTH = 300;
const CLIENT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const ARCH_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// Sucesso para o helper (constants.IsSuccessCode).
const ACCEPTED_CODES = new Set([1000, 1001]);
// Recusa pela versão do app (internal/auth/errors.go): 5001 x-pm-appversion ausente,
// 5003 versão do app sem suporte, 5005 versão da API inválida.
const REJECTED_CODES = new Set([5001, 5003, 5005]);
// A Proton recusou a requisição da própria checagem, não a versão do app (ambos chegam com HTTP 400):
// 5002 "Missing x-pm-appversion header" e 2064 para um valor malformado.
const INVALID_REQUEST_CODES = new Set([5002, 2064]);

const EXIT_CODES = { accepted: 0, inconclusive: 0, rejected: 1, invalid_request: 2 };
const STATUS_LABELS = {
  accepted: "aceita",
  inconclusive: "inconclusiva",
  rejected: "recusada",
  invalid_request: "requisição inválida",
};
const LEVEL_LABELS = { error: "erro", warning: "aviso", notice: "nota" };

/** Valor de `var ClientVersion = "X.Y.Z"` no código-fonte de api.go. */
export function readClientVersion(goSource) {
  const match = /^[ \t]*(?:var[ \t]+)?ClientVersion(?:[ \t]+string)?[ \t]*=[ \t]*"([^"\r\n]*)"/m.exec(
    String(goSource ?? ""),
  );
  const version = match?.[1].trim();
  if (!version) {
    throw new Error('ClientVersion não encontrado em api.go: esperava uma linha como var ClientVersion = "X.Y.Z"');
  }
  return version;
}

/** x-pm-appversion que o helper envia, no formato do cliente oficial (init() de api.go). */
export function officialAppVersion(clientVersion, arch = DEFAULT_ARCH) {
  return `linux-vpn-gui@${clientVersion}+${arch}`;
}

/** User-Agent que o helper envia, no formato do cliente oficial (init() de api.go). */
export function officialUserAgent(clientVersion) {
  return `ProtonVPN/${clientVersion} (Linux; ubuntu/26.04)`;
}

/**
 * Versão do cliente, arquitetura e cabeçalhos que a checagem envia, com os overrides de ambiente:
 * PROTON_CLIENT_VERSION substitui o ClientVersion de api.go (e então `loadGoSource` nem é chamado),
 * PROTON_ARCH troca a arquitetura, e PROTON_APP_VERSION e PROTON_USER_AGENT substituem os dois
 * cabeçalhos inteiros (o par literal de um helper antigo). Lança erro quando algum valor é inválido,
 * antes de qualquer requisição.
 */
export function resolveClientIdentity(env, loadGoSource) {
  const override = env.PROTON_CLIENT_VERSION?.trim();
  const clientVersion = override || readClientVersion(loadGoSource());
  if (!CLIENT_VERSION_PATTERN.test(clientVersion)) {
    const origin = override ? "PROTON_CLIENT_VERSION" : "ClientVersion de api.go";
    throw new Error(`versão do cliente inválida em ${origin}: ${quoted(clientVersion)}; esperava X.Y.Z, como 6.1.2`);
  }
  const arch = env.PROTON_ARCH?.trim() || DEFAULT_ARCH;
  if (!ARCH_PATTERN.test(arch)) {
    throw new Error(`arquitetura inválida em PROTON_ARCH: ${quoted(arch)}; esperava algo como x86-64 ou aarch64`);
  }
  const appVersion = env.PROTON_APP_VERSION?.trim() || officialAppVersion(clientVersion, arch);
  if (!/^[\x20-\x7e]+$/.test(appVersion)) {
    throw new Error("x-pm-appversion inválido em PROTON_APP_VERSION: use só caracteres ASCII visíveis");
  }
  const userAgent = env.PROTON_USER_AGENT?.trim() || officialUserAgent(clientVersion);
  if (!/^[\x20-\x7e]+$/.test(userAgent)) {
    throw new Error("User-Agent inválido em PROTON_USER_AGENT: use só caracteres ASCII visíveis");
  }
  return { clientVersion, arch, appVersion, userAgent };
}

const quoted = value => JSON.stringify(String(value).slice(0, 64));

/**
 * Classifica a resposta de /vpn/v2/clientconfig; `body` é o texto cru ou o JSON já decodificado.
 * - accepted: Code 1000 ou 1001 com HTTP 2xx;
 * - rejected: Code 5001, 5003 ou 5005, com qualquer HTTP;
 * - invalid_request: Code 5002 ou 2064, com qualquer HTTP (o erro é da checagem, não da versão);
 * - inconclusive: o resto (outro Code, corpo vazio ou que não é JSON, 5xx, 429, sem resposta).
 * Do corpo só são lidos Code e Error.
 */
export function classifyApiResponse({ httpStatus = null, body = null } = {}) {
  const status = Number.isInteger(httpStatus) ? httpStatus : null;
  const { payload, problem } = readJsonObject(body);
  const code = Number.isInteger(payload?.Code) ? payload.Code : null;
  const apiError = typeof payload?.Error === "string" ? cleanText(payload.Error) : "";

  if (REJECTED_CODES.has(code)) {
    return { status: "rejected", code, message: apiError || `a Proton recusou a versão do app (Code ${code})` };
  }
  if (INVALID_REQUEST_CODES.has(code)) {
    return { status: "invalid_request", code, message: apiError || `a Proton recusou a requisição da checagem (Code ${code})` };
  }
  if (ACCEPTED_CODES.has(code) && status !== null && status >= 200 && status < 300) {
    return { status: "accepted", code, message: null };
  }

  let reason;
  if (status === null && !payload) reason = "sem resposta HTTP";
  else if (problem) reason = problem;
  else if (code === null) reason = "JSON sem Code numérico";
  else if (ACCEPTED_CODES.has(code)) reason = `Code ${code} com HTTP ${status ?? "desconhecido"}`;
  else reason = `Code ${code} não indica aceite nem recusa da versão`;
  return { status: "inconclusive", code, message: apiError || reason };
}

function readJsonObject(body) {
  let value = body;
  if (typeof body === "string") {
    if (!body.trim()) return { payload: null, problem: "corpo vazio" };
    try {
      value = JSON.parse(body);
    } catch {
      return { payload: null, problem: "corpo não é JSON" };
    }
  }
  if (value === null || value === undefined) return { payload: null, problem: "corpo vazio" };
  if (typeof value !== "object" || Array.isArray(value)) return { payload: null, problem: "JSON não é um objeto" };
  return { payload: value, problem: null };
}

// Texto remoto em uma linha curta, sem caracteres de controle (quebras de linha, escapes de terminal).
function cleanText(value, maxLength = MAX_MESSAGE_LENGTH) {
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Versão do primeiro `version:` de versions.yml (o lançamento mais recente), ou null. */
export function parseVersionsYml(text) {
  const match = /^version:[ \t]*([^\r\n]*)/m.exec(String(text ?? "").replace(/^\uFEFF/, ""));
  if (!match) return null;
  const value = match[1]
    .replace(/[ \t]+#.*$/, "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
  // Conteúdo remoto: só passa algo com cara de versão, seguro para outputs, logs e Markdown.
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value) ? value : null;
}

/** Compara versões numéricas pontuadas ("6.1.2"): -1, 0 ou 1. Segmentos ausentes valem 0. */
export function compareVersions(a, b) {
  const left = versionNumbers(a);
  const right = versionNumbers(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function versionNumbers(version) {
  const text = String(version ?? "").trim().replace(/^v/i, "");
  if (!/^\d+(?:\.\d+)*$/.test(text)) throw new TypeError(`versão não numérica: ${JSON.stringify(version)}`);
  return text.split(".").map(Number);
}

/**
 * GET em /vpn/v2/clientconfig com os cabeçalhos do helper: o endpoint dispensa login e já responde
 * 5003 a uma versão recusada. Repete até duas vezes, com pausa curta, só quando o resultado é
 * inconclusivo por falha de rede, 5xx ou 429.
 */
export async function requestClientConfig({
  apiUrl = DEFAULT_API_URL,
  appVersion,
  userAgent,
  fetchImpl = globalThis.fetch,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  timeoutMs = API_TIMEOUT_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
}) {
  const url = `${String(apiUrl).replace(/\/+$/, "")}${CLIENT_CONFIG_PATH}`;
  // Os mesmos cabeçalhos explícitos do helper (internal/api/transport.go), para a resposta valer para
  // ele; o fetch acrescenta os padrões dele, como o net/http do Go também faz.
  const headers = {
    "Content-Type": "application/json",
    "x-pm-appversion": appVersion,
    "User-Agent": userAgent,
  };
  for (let attempt = 1; ; attempt++) {
    let httpStatus = null;
    let failed = false;
    let result;
    try {
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      httpStatus = response.status;
      result = classifyApiResponse({ httpStatus, body: await response.text() });
    } catch (error) {
      failed = true;
      result = { status: "inconclusive", code: null, message: `falha de rede: ${describeError(error, timeoutMs)}` };
    }
    const retryable = result.status === "inconclusive" && (failed || httpStatus >= 500 || httpStatus === 429);
    if (!retryable || attempt > retryDelaysMs.length) {
      const message =
        result.status === "inconclusive" && attempt > 1 ? `${result.message} (após ${attempt} tentativas)` : result.message;
      return { ...result, message, httpStatus, attempts: attempt };
    }
    await sleep(retryDelaysMs[attempt - 1]);
  }
}

// Motivo curto de uma falha do fetch: o código do erro de rede (ECONNREFUSED, ENOTFOUND...) ou o timeout.
function describeError(error, timeoutMs) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return `sem resposta em ${Math.round(timeoutMs / 1000)} s`;
  }
  const cause = error?.cause;
  return cleanText(cause?.code || cause?.message || error?.message || error, 120);
}

// Versão estável do python-proton-vpn-api-core. Informativa: uma falha aqui não muda o resultado.
async function fetchLatestVersion(url, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(VERSIONS_TIMEOUT_MS) });
    const text = await response.text();
    if (!response.ok) return { latestVersion: null, problem: `HTTP ${response.status}` };
    const latestVersion = parseVersionsYml(text);
    return { latestVersion, problem: latestVersion ? null : "sem linha version: válida" };
  } catch (error) {
    return { latestVersion: null, problem: describeError(error, VERSIONS_TIMEOUT_MS) };
  }
}

function isBehind(clientVersion, latestVersion) {
  if (!latestVersion) return null;
  try {
    return compareVersions(clientVersion, latestVersion) < 0;
  } catch {
    return null;
  }
}

function httpUrl(value, name) {
  let protocol = "";
  try {
    protocol = new URL(value).protocol;
  } catch {
    // tratado abaixo
  }
  if (protocol !== "http:" && protocol !== "https:") throw new Error(`${name} não é uma URL http(s) válida`);
  return value;
}

function responseContext(summary) {
  const parts = [summary.httpStatus === null ? "sem resposta HTTP" : `HTTP ${summary.httpStatus}`];
  if (summary.code !== null) parts.push(`Code ${summary.code}`);
  return parts.join(", ");
}

// Uma linha, sem crases, cifrões, aspas e barras invertidas: message vem da Proton e não pode virar
// comando nem fechar aspas se o workflow interpolar o output em um script.
const outputValue = value => cleanText(value ?? "").replace(/[`$"'\\]/g, "");

function formatGithubOutput(summary) {
  const values = {
    status: summary.status,
    client_version: summary.clientVersion,
    latest_version: summary.latestVersion,
    code: summary.code,
    app_version: summary.appVersion,
    http_status: summary.httpStatus,
    message: summary.message,
  };
  return Object.entries(values)
    .map(([key, value]) => `${key}=${outputValue(value)}\n`)
    .join("");
}

const inlineCode = value => `\`${cleanText(value ?? "", 200).replace(/`/g, "'")}\``;
const markdownText = value =>
  cleanText(value).replace(/[\\`*_[\]|~<>&#]/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char] ?? `\\${char}`);

function formatStepSummary(summary, upstreamProblem) {
  let upstream = `não consultada (${markdownText(upstreamProblem ?? "motivo desconhecido")})`;
  if (summary.latestVersion !== null) {
    upstream = inlineCode(summary.latestVersion) + (summary.behind ? ", à frente do ClientVersion" : "");
  }
  const lines = [
    `### Versão do app na API da Proton (${inlineCode(summary.arch)})`,
    "",
    `- Resultado: **${STATUS_LABELS[summary.status]}** (${responseContext(summary)})`,
    `- x-pm-appversion: ${inlineCode(summary.appVersion)}`,
    `- ClientVersion: ${inlineCode(summary.clientVersion)}`,
    `- python-proton-vpn-api-core estável: ${upstream}`,
  ];
  if (summary.message) lines.push(`- Mensagem: ${markdownText(summary.message)}`);
  if (summary.status === "rejected") {
    lines.push(
      "",
      `> A Proton recusou a versão: o login falha para todos os usuários até sair uma release com \`ClientVersion\` atualizado em \`${API_GO_PATH.join("/")}\`.`,
    );
  } else if (summary.status === "invalid_request") {
    lines.push(
      "",
      "> A checagem enviou um x-pm-appversion ausente ou malformado: corrija o script ou as variáveis `PROTON_*`. Isto não é a Proton recusando a versão do app.",
    );
  } else if (summary.status === "inconclusive") {
    lines.push("", "> Resultado inconclusivo: sem alarme; a próxima execução confere de novo.");
  }
  return `${lines.join("\n")}\n\n`;
}

// No GitHub Actions vira anotação (::error::, ::warning::, ::notice::); fora dele, uma linha no stderr.
function annotate(level, message) {
  const text = cleanText(message, 1000);
  console.error(
    process.env.GITHUB_ACTIONS === "true" ? `::${level}::${text.replace(/%/g, "%25")}` : `${LEVEL_LABELS[level]}: ${text}`,
  );
}

function reportProblems(summary, upstreamProblem) {
  const context = responseContext(summary);
  const reason = String(summary.message ?? "").replace(/[.\s]+$/, "");
  if (summary.status === "rejected") {
    const latest = summary.latestVersion ? ` (estável do python-proton-vpn-api-core: ${summary.latestVersion})` : "";
    annotate(
      "error",
      `A Proton recusou x-pm-appversion ${summary.appVersion} (${context}): ${reason}. Atualize ClientVersion em ${API_GO_PATH.join("/")}${latest} e publique uma release.`,
    );
  } else if (summary.status === "invalid_request") {
    annotate(
      "error",
      `A Proton recusou a requisição da própria checagem (${context}): ${reason}. O x-pm-appversion enviado (${summary.appVersion}) está ausente ou malformado: corrija o script ou as variáveis PROTON_*; isto não é recusa da versão do app.`,
    );
  } else if (summary.status === "inconclusive") {
    annotate(
      "warning",
      `Checagem inconclusiva da versão do app na Proton (${context}): ${reason}. Sem alarme; a próxima execução confere de novo.`,
    );
  } else if (summary.behind) {
    annotate(
      "notice",
      `A Proton aceita ${summary.appVersion}, mas o python-proton-vpn-api-core estável já está em ${summary.latestVersion}: vale subir ClientVersion antes que a Proton recuse ${summary.clientVersion}.`,
    );
  }
  if (upstreamProblem) {
    annotate("warning", `Não foi possível ler a versão estável do python-proton-vpn-api-core: ${upstreamProblem}.`);
  }
}

async function main(env = process.env) {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const { clientVersion, arch, appVersion, userAgent } = resolveClientIdentity(env, () => {
    try {
      return readFileSync(path.join(repoRoot, ...API_GO_PATH), "utf8");
    } catch (error) {
      throw new Error(`não foi possível ler ${API_GO_PATH.join("/")} (${error?.code ?? error?.message})`);
    }
  });
  const apiUrl = httpUrl(env.PROTON_API_URL?.trim() || DEFAULT_API_URL, "PROTON_API_URL");
  const versionsUrl = httpUrl(env.PROTON_VERSIONS_URL?.trim() || DEFAULT_VERSIONS_URL, "PROTON_VERSIONS_URL");

  const [api, upstream] = await Promise.all([
    requestClientConfig({ apiUrl, appVersion, userAgent }),
    fetchLatestVersion(versionsUrl),
  ]);
  const summary = {
    status: api.status,
    clientVersion,
    arch,
    appVersion,
    httpStatus: api.httpStatus,
    code: api.code,
    message: api.message,
    latestVersion: upstream.latestVersion,
    behind: isBehind(clientVersion, upstream.latestVersion),
  };
  console.log(JSON.stringify(summary));
  reportProblems(summary, upstream.problem);

  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, formatGithubOutput(summary), "utf8");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, formatStepSummary(summary, upstream.problem), "utf8");
  return EXIT_CODES[summary.status];
}

function isMainModule() {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    annotate("error", `Não foi possível conferir a versão do app na Proton: ${error?.message ?? error}`);
    process.exitCode = 2;
  }
}
