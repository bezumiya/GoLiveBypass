// Alarme agendado da versão do app na Proton: scripts/check-proton-app-version.mjs, na raiz do repo.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyApiResponse,
  compareVersions,
  officialAppVersion,
  officialUserAgent,
  parseVersionsYml,
  readClientVersion,
  requestClientConfig,
  resolveClientIdentity,
} from "../../scripts/check-proton-app-version.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/check-proton-app-version.mjs", import.meta.url));
const API_GO = fileURLToPath(new URL("../../tools/proton-confgen/internal/constants/api.go", import.meta.url));
// Respostas da Proton: versão recusada e x-pm-appversion malformado (este ecoa o valor recebido).
const RECUSA = { Code: 5003, Error: "This version of the app is no longer supported" };
const MALFORMADO = {
  Code: 2064,
  Error: "Application platform and product must be separated by a dash ('-') (in `foo bar`)",
};
const APP = "linux-vpn-gui@6.1.2+x86-64";
const UA = "ProtonVPN/6.1.2 (Linux; ubuntu/26.04)";

const temporarios: string[] = [];
const servidores: http.Server[] = [];
afterEach(async () => {
  for (const servidor of servidores.splice(0)) {
    servidor.closeAllConnections();
    await new Promise(resolve => servidor.close(resolve));
  }
  for (const pasta of temporarios.splice(0)) fs.rmSync(pasta, { recursive: true, force: true });
});

function pastaTemporaria() {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "golive-proton-versao-"));
  temporarios.push(pasta);
  return pasta;
}

describe("readClientVersion", () => {
  it("lê uma versão pontuada do api.go real", () => {
    expect(readClientVersion(fs.readFileSync(API_GO, "utf8"))).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("segue o formato de cabeçalhos do init() de api.go", () => {
    // Se o helper mudar o formato, o alarme passaria a conferir um identificador que ele não envia.
    const fonte = fs.readFileSync(API_GO, "utf8");
    expect(fonte).toContain('"linux-vpn-gui@" + ClientVersion + "+"');
    expect(fonte).toContain('"ProtonVPN/" + ClientVersion + " (Linux; ubuntu/26.04)"');
    expect(fonte).toContain('return "x86-64"');
    expect(fonte).toContain('return "aarch64"');
  });

  it("aceita o tipo explícito e ignora menções em comentários", () => {
    const fonte = ['// go build -ldflags "-X .../internal/constants.ClientVersion=9.9.9"', 'var ClientVersion string = "7.0.1"'];
    expect(readClientVersion(fonte.join("\n"))).toBe("7.0.1");
  });

  it("falha com mensagem clara quando ClientVersion falta ou está vazio", () => {
    expect(() => readClientVersion("package constants\n")).toThrow(/ClientVersion não encontrado/);
    expect(() => readClientVersion('var ClientVersion = ""')).toThrow(/ClientVersion não encontrado/);
  });
});

describe("identificadores do cliente oficial", () => {
  it("formata x-pm-appversion e User-Agent como o helper", () => {
    expect(officialAppVersion("6.1.2")).toBe(APP);
    expect(officialAppVersion("6.1.2", "aarch64")).toBe("linux-vpn-gui@6.1.2+aarch64");
    expect(officialUserAgent("6.1.2")).toBe(UA);
  });
});

describe("resolveClientIdentity", () => {
  const fonte = 'package constants\n\nvar ClientVersion = "6.1.2"\n';

  it("deriva os cabeçalhos do ClientVersion de api.go, em x86-64 por padrão", () => {
    expect(resolveClientIdentity({}, () => fonte)).toEqual({
      clientVersion: "6.1.2", arch: "x86-64", appVersion: APP, userAgent: UA,
    });
  });

  it("PROTON_CLIENT_VERSION e PROTON_ARCH substituem api.go nos dois cabeçalhos", () => {
    const lerFonte = vi.fn(() => fonte);
    expect(resolveClientIdentity({ PROTON_CLIENT_VERSION: "7.0.1", PROTON_ARCH: "aarch64" }, lerFonte)).toEqual({
      clientVersion: "7.0.1",
      arch: "aarch64",
      appVersion: "linux-vpn-gui@7.0.1+aarch64",
      userAgent: "ProtonVPN/7.0.1 (Linux; ubuntu/26.04)",
    });
    expect(lerFonte).not.toHaveBeenCalled();
  });

  it("PROTON_APP_VERSION vence no x-pm-appversion; o User-Agent segue a versão do cliente", () => {
    const env = { PROTON_APP_VERSION: "linux-vpn@4.17.2", PROTON_CLIENT_VERSION: "7.0.1", PROTON_ARCH: "aarch64" };
    expect(resolveClientIdentity(env, () => fonte)).toMatchObject({
      appVersion: "linux-vpn@4.17.2",
      userAgent: "ProtonVPN/7.0.1 (Linux; ubuntu/26.04)",
    });
  });

  it("PROTON_USER_AGENT completa o par literal de um helper antigo", () => {
    const env = {
      PROTON_CLIENT_VERSION: "4.17.2",
      PROTON_APP_VERSION: "linux-vpn@4.17.2",
      PROTON_USER_AGENT: "ProtonVPN/4.17.2 (Linux; Ubuntu)",
    };
    expect(resolveClientIdentity(env, () => fonte)).toEqual({
      clientVersion: "4.17.2", arch: "x86-64", appVersion: "linux-vpn@4.17.2", userAgent: "ProtonVPN/4.17.2 (Linux; Ubuntu)",
    });
  });

  it.each(["6.1", "6.1.2.0", "v6.1.2", "6.1.2-beta", "6.1.x"])("recusa PROTON_CLIENT_VERSION %j fora de X.Y.Z", versao => {
    expect(() => resolveClientIdentity({ PROTON_CLIENT_VERSION: versao }, () => fonte)).toThrow(
      /PROTON_CLIENT_VERSION.*X\.Y\.Z/,
    );
  });

  it("recusa ClientVersion de api.go fora de X.Y.Z e arquitetura ou cabeçalhos malformados", () => {
    expect(() => resolveClientIdentity({}, () => 'var ClientVersion = "6.1"')).toThrow(/api\.go.*X\.Y\.Z/);
    expect(() => resolveClientIdentity({ PROTON_ARCH: "x86 64" }, () => fonte)).toThrow(/PROTON_ARCH/);
    expect(() => resolveClientIdentity({ PROTON_APP_VERSION: "linux\u0000vpn" }, () => fonte)).toThrow(/PROTON_APP_VERSION/);
    expect(() => resolveClientIdentity({ PROTON_USER_AGENT: "ProtonVPN\n6.1.2" }, () => fonte)).toThrow(/PROTON_USER_AGENT/);
  });
});

describe("classifyApiResponse", () => {
  it("aceita Code 1000 e 1001 com HTTP 2xx", () => {
    expect(classifyApiResponse({ httpStatus: 200, body: { Code: 1000 } })).toEqual({ status: "accepted", code: 1000, message: null });
    expect(classifyApiResponse({ httpStatus: 200, body: '{"Code":1001}' })).toMatchObject({ status: "accepted", code: 1001 });
  });

  it("recusa Code 5003 com HTTP 422 e guarda a mensagem da Proton", () => {
    expect(classifyApiResponse({ httpStatus: 422, body: JSON.stringify(RECUSA) })).toEqual({
      status: "rejected", code: 5003, message: RECUSA.Error,
    });
  });

  it.each([
    [5001, 422],
    [5005, 422],
    [5001, 400],
    [5003, 200],
    [5005, 503],
  ])("recusa Code %i com qualquer HTTP (%i)", (code, httpStatus) => {
    expect(classifyApiResponse({ httpStatus, body: { Code: code } })).toMatchObject({ status: "rejected", code });
  });

  it.each([
    [5002, { Code: 5002, Error: "Missing x-pm-appversion header" }],
    [2064, MALFORMADO],
  ])("trata Code %i como requisição inválida da checagem, nunca como recusa", (code, body) => {
    expect(classifyApiResponse({ httpStatus: 400, body })).toEqual({ status: "invalid_request", code, message: body.Error });
  });

  it.each([
    ["Code fora das listas", 422, { Code: 2028, Error: "Too many recent requests" }, 2028],
    ["503 sem corpo", 503, undefined, null],
    ["503 com corpo vazio", 503, "", null],
    ["corpo que não é JSON", 200, "<html>gateway</html>", null],
    ["JSON que não é objeto", 200, "[1000]", null],
    ["JSON sem Code", 200, { Error: "?" }, null],
    ["Code em texto", 422, { Code: "5003" }, null],
    ["429 com Code", 429, { Code: 2028 }, 2028],
    ["Code 1000 com HTTP 503", 503, { Code: 1000 }, 1000],
    ["sem resposta HTTP", null, undefined, null],
  ])("trata %s como inconclusivo", (_caso, httpStatus, body, code) => {
    const resultado = classifyApiResponse({ httpStatus, body });
    expect(resultado).toMatchObject({ status: "inconclusive", code });
    expect(resultado.message).toBeTruthy();
  });

  it("devolve só Code e Error do corpo, em uma linha curta", () => {
    const corpo = { Code: 5003, Error: `linha\nquebrada\u001b[31m ${"x".repeat(1000)}`, Details: { interno: "não sai" } };
    const resultado = classifyApiResponse({ httpStatus: 422, body: corpo });
    expect(resultado.message).not.toMatch(/[\u0000-\u001f]/);
    expect(resultado.message.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(resultado)).not.toContain("não sai");
  });
});

describe("parseVersionsYml", () => {
  it("lê a versão do primeiro documento", () => {
    const amostra = [
      "version: 6.1.2",
      "time: 2026/11/06 08:03",
      "author: Proton",
      "description:",
      '- "chore: bump version: 9.9.9"',
      "---",
      "version: 6.1.1",
      "",
    ].join("\n");
    expect(parseVersionsYml(amostra)).toBe("6.1.2");
  });

  it("tolera BOM, CRLF, aspas e comentário", () => {
    expect(parseVersionsYml('﻿version: "6.2.0" # estável\r\ntime: 2026/11/06 08:03\r\n')).toBe("6.2.0");
  });

  it("devolve null sem uma linha version: válida", () => {
    expect(parseVersionsYml("404: Not Found")).toBeNull();
    expect(parseVersionsYml("")).toBeNull();
    expect(parseVersionsYml("version:\ntime: x\n")).toBeNull();
    expect(parseVersionsYml("  version: 6.1.2\n")).toBeNull();
    expect(parseVersionsYml("version: $(curl exemplo.invalid)\n")).toBeNull();
  });
});

describe("compareVersions", () => {
  it.each([
    ["6.1.2", "6.1.2", 0],
    ["6.1.2", "6.1.10", -1],
    ["6.10.0", "6.9.9", 1],
    ["6.1", "6.1.0", 0],
    ["6.1.0.1", "6.1", 1],
    ["7", "6.99.99", 1],
    ["5.99.99", "6.0.0", -1],
    ["v6.1.2", " 6.1.2 ", 0],
    ["06.1.2", "6.1.2", 0],
  ])("compareVersions(%j, %j) = %i", (a, b, esperado) => {
    expect(compareVersions(a, b)).toBe(esperado);
  });

  it("recusa versões que não são numéricas pontuadas", () => {
    for (const invalida of ["", "6..1", "6.1.", "6.1.x", "6.1.2-beta", null, undefined]) {
      expect(() => compareVersions(invalida, "6.1.2")).toThrow(TypeError);
    }
  });
});

describe("requestClientConfig", () => {
  const resposta = (status: number, corpo: unknown = "") =>
    new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), { status });
  const pedido = { apiUrl: "https://api.exemplo.invalid/", appVersion: APP, userAgent: UA };

  it("envia os cabeçalhos do helper e repete 5xx e 429 até aceitar", async () => {
    const fila = [resposta(503), resposta(429, { Code: 2028 }), resposta(200, { Code: 1000 })];
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => fila.shift()!);
    const sleep = vi.fn(async (_ms: number) => {});
    const resultado = await requestClientConfig({ ...pedido, fetchImpl, sleep });
    expect(resultado).toMatchObject({ status: "accepted", code: 1000, httpStatus: 200, attempts: 3 });
    expect(sleep).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.exemplo.invalid/vpn/v2/clientconfig");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "x-pm-appversion": APP, "User-Agent": UA });
  });

  it.each([
    [422, "rejected", RECUSA],
    [400, "invalid_request", MALFORMADO],
    [422, "inconclusive", { Code: 2028 }],
  ])("não repete HTTP %i com resultado %s", async (status, esperado, corpo) => {
    const fetchImpl = vi.fn(async () => resposta(status, corpo));
    const resultado = await requestClientConfig({ ...pedido, fetchImpl, sleep: vi.fn(async () => {}) });
    expect(resultado).toMatchObject({ status: esperado, httpStatus: status, attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("desiste após três falhas de rede, como inconclusivo", async () => {
    const recusada = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: recusada });
    });
    const resultado = await requestClientConfig({ ...pedido, fetchImpl, sleep: vi.fn(async () => {}) });
    expect(resultado).toMatchObject({ status: "inconclusive", code: null, httpStatus: null, attempts: 3 });
    expect(resultado.message).toBe("falha de rede: ECONNREFUSED (após 3 tentativas)");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

// Faz o papel da API da Proton e do versions.yml upstream, sem sair da máquina.
async function subirServidor(api: { status: number; corpo: unknown }, versionsYml = "version: 6.1.2\n") {
  const pedidos: string[] = [];
  const cabecalhos: http.IncomingHttpHeaders[] = [];
  const servidor = http.createServer((req, res) => {
    pedidos.push(req.url ?? "");
    if (req.url === "/vpn/v2/clientconfig") {
      cabecalhos.push(req.headers);
      res.writeHead(api.status, { "Content-Type": "application/json" }).end(JSON.stringify(api.corpo));
    } else if (req.url === "/versions.yml") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end(versionsYml);
    } else {
      res.writeHead(404).end();
    }
  });
  servidores.push(servidor);
  await new Promise<void>(resolve => servidor.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  return { pedidos, cabecalhos, env: { PROTON_API_URL: base, PROTON_VERSIONS_URL: `${base}/versions.yml` } };
}

// O teste define todas as variáveis que o script lê, sem herdar do shell nem do CI.
const VARIAVEIS_DO_SCRIPT = [
  "PROTON_CLIENT_VERSION", "PROTON_ARCH", "PROTON_APP_VERSION", "PROTON_USER_AGENT", "PROTON_API_URL", "PROTON_VERSIONS_URL",
  "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "GITHUB_ACTIONS",
];

async function rodarCli(env: Record<string, string>, script = SCRIPT) {
  const pasta = pastaTemporaria();
  const saidas = path.join(pasta, "github-output");
  const resumo = path.join(pasta, "step-summary.md");
  const ambiente: NodeJS.ProcessEnv = { ...process.env };
  for (const nome of VARIAVEIS_DO_SCRIPT) delete ambiente[nome];
  Object.assign(ambiente, { GITHUB_OUTPUT: saidas, GITHUB_STEP_SUMMARY: resumo }, env);
  // spawn assíncrono: o servidor local roda neste processo e precisa do event loop livre.
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const filho = spawn(process.execPath, [script], { env: ambiente, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
      let stdout = "";
      let stderr = "";
      filho.stdout!.setEncoding("utf8").on("data", (parte: string) => { stdout += parte; });
      filho.stderr!.setEncoding("utf8").on("data", (parte: string) => { stderr += parte; });
      filho.on("error", reject);
      filho.on("close", codigo => resolve({ code: codigo, stdout, stderr }));
    },
  );
  const ler = (arquivo: string) => (fs.existsSync(arquivo) ? fs.readFileSync(arquivo, "utf8") : "");
  return { code, stdout, stderr, saidas: ler(saidas), resumo: ler(resumo) };
}

// O stdout traz exatamente uma linha JSON.
function linhaJson(stdout: string) {
  const linhas = stdout.trim().split("\n");
  expect(linhas).toHaveLength(1);
  return JSON.parse(linhas[0]);
}

describe("CLI contra um servidor local", { timeout: 20_000 }, () => {
  const clientVersion = readClientVersion(fs.readFileSync(API_GO, "utf8"));
  const appVersion = officialAppVersion(clientVersion);

  it("sai com 0 e status accepted quando a Proton responde Code 1000", async () => {
    const servidor = await subirServidor({ status: 200, corpo: { Code: 1000 } }, "version: 99.0.0\ntime: 2026/11/06 08:03\n");
    const resultado = await rodarCli(servidor.env);
    expect(resultado.code, resultado.stderr).toBe(0);
    expect(linhaJson(resultado.stdout)).toEqual({
      status: "accepted", clientVersion, arch: "x86-64", appVersion,
      httpStatus: 200, code: 1000, message: null, latestVersion: "99.0.0", behind: true,
    });
    // Os mesmos cabeçalhos do helper, derivados do ClientVersion de api.go.
    expect(servidor.cabecalhos).toHaveLength(1);
    expect(servidor.cabecalhos[0]).toMatchObject({
      "x-pm-appversion": appVersion,
      "user-agent": officialUserAgent(clientVersion),
      "content-type": "application/json",
    });
    expect(resultado.saidas).toBe([
      "status=accepted", `client_version=${clientVersion}`, "latest_version=99.0.0", "code=1000",
      `app_version=${appVersion}`, "http_status=200", "message=", "",
    ].join("\n"));
    expect(resultado.resumo).toContain("**aceita**");
    expect(resultado.stderr).toContain("99.0.0");
  });

  it("sai com 1 e status rejected quando a Proton responde 422/5003", async () => {
    const servidor = await subirServidor({ status: 422, corpo: RECUSA }, `version: ${clientVersion}\n`);
    const resultado = await rodarCli({ ...servidor.env, PROTON_APP_VERSION: "linux-vpn@4.17.2" });
    expect(resultado.code, resultado.stderr).toBe(1);
    expect(linhaJson(resultado.stdout)).toEqual({
      status: "rejected", clientVersion, arch: "x86-64", appVersion: "linux-vpn@4.17.2",
      httpStatus: 422, code: 5003, message: RECUSA.Error, latestVersion: clientVersion, behind: false,
    });
    expect(servidor.cabecalhos.map(cabecalho => cabecalho["x-pm-appversion"])).toEqual(["linux-vpn@4.17.2"]);
    expect(resultado.saidas).toBe([
      "status=rejected", `client_version=${clientVersion}`, `latest_version=${clientVersion}`, "code=5003",
      "app_version=linux-vpn@4.17.2", "http_status=422", `message=${RECUSA.Error}`, "",
    ].join("\n"));
    expect(resultado.resumo).toContain("**recusada**");
    expect(resultado.stderr).toContain("Atualize ClientVersion");
  });

  it("confere o par literal de um helper antigo, como o workflow faz com a release macOS", async () => {
    const servidor = await subirServidor({ status: 422, corpo: RECUSA }, "version: 6.1.2\n");
    const resultado = await rodarCli({
      ...servidor.env,
      PROTON_CLIENT_VERSION: "4.17.2",
      PROTON_APP_VERSION: "linux-vpn@4.17.2",
      PROTON_USER_AGENT: "ProtonVPN/4.17.2 (Linux; Ubuntu)",
    });
    expect(resultado.code, resultado.stderr).toBe(1);
    expect(linhaJson(resultado.stdout)).toMatchObject({
      status: "rejected", clientVersion: "4.17.2", appVersion: "linux-vpn@4.17.2", code: 5003, latestVersion: "6.1.2", behind: true,
    });
    expect(servidor.cabecalhos).toHaveLength(1);
    expect(servidor.cabecalhos[0]).toMatchObject({
      "x-pm-appversion": "linux-vpn@4.17.2",
      "user-agent": "ProtonVPN/4.17.2 (Linux; Ubuntu)",
    });
  });

  it("sai com 2 e status invalid_request quando a Proton recusa o cabeçalho da checagem", async () => {
    const servidor = await subirServidor({ status: 400, corpo: MALFORMADO });
    const resultado = await rodarCli(servidor.env);
    expect(resultado.code, resultado.stderr).toBe(2);
    expect(linhaJson(resultado.stdout)).toMatchObject({
      status: "invalid_request", httpStatus: 400, code: 2064, message: MALFORMADO.Error,
    });
    expect(servidor.cabecalhos).toHaveLength(1);
    expect(resultado.saidas).toContain("status=invalid_request\n");
    // A mensagem ecoa o cabeçalho: no output ela sai sem crases e aspas.
    expect(resultado.saidas).toContain("message=Application platform and product must be separated by a dash (-) (in foo bar)\n");
    expect(resultado.resumo).toContain("**requisição inválida**");
    expect(resultado.stderr).not.toContain("Atualize ClientVersion");
  });

  it("sai com 0 e avisa quando o resultado é inconclusivo", async () => {
    const servidor = await subirServidor({ status: 422, corpo: { Code: 2028, Error: "Too many recent requests" } });
    const resultado = await rodarCli(servidor.env);
    expect(resultado.code, resultado.stderr).toBe(0);
    expect(linhaJson(resultado.stdout)).toMatchObject({ status: "inconclusive", httpStatus: 422, code: 2028 });
    expect(resultado.saidas).toContain("status=inconclusive\n");
    expect(resultado.stderr).toContain("inconclusiva");
  });

  it("PROTON_CLIENT_VERSION e PROTON_ARCH mudam o x-pm-appversion e o User-Agent", async () => {
    const servidor = await subirServidor({ status: 200, corpo: { Code: 1000 } });
    const resultado = await rodarCli({ ...servidor.env, PROTON_CLIENT_VERSION: "6.1.2", PROTON_ARCH: "aarch64" });
    expect(resultado.code, resultado.stderr).toBe(0);
    expect(linhaJson(resultado.stdout)).toMatchObject({
      status: "accepted", clientVersion: "6.1.2", arch: "aarch64", appVersion: "linux-vpn-gui@6.1.2+aarch64",
    });
    expect(servidor.cabecalhos[0]).toMatchObject({ "x-pm-appversion": "linux-vpn-gui@6.1.2+aarch64", "user-agent": UA });
    expect(resultado.resumo).toContain("`aarch64`");
  });

  it("sai com 2, sem consultar a Proton, quando PROTON_CLIENT_VERSION não é X.Y.Z", async () => {
    const servidor = await subirServidor({ status: 200, corpo: { Code: 1000 } });
    const resultado = await rodarCli({ ...servidor.env, PROTON_CLIENT_VERSION: "6.1" });
    expect(resultado.code, resultado.stderr).toBe(2);
    expect(resultado.stdout).toBe("");
    expect(resultado.stderr).toContain('versão do cliente inválida em PROTON_CLIENT_VERSION: "6.1"');
    expect(servidor.pedidos).toEqual([]);
    expect(resultado.saidas).toBe("");
  });

  it("sai com 2 quando não consegue ler o api.go", async () => {
    const raiz = pastaTemporaria();
    fs.mkdirSync(path.join(raiz, "scripts"));
    const copia = path.join(raiz, "scripts", "check-proton-app-version.mjs");
    fs.copyFileSync(SCRIPT, copia);
    const servidor = await subirServidor({ status: 200, corpo: { Code: 1000 } });
    const resultado = await rodarCli(servidor.env, copia);
    expect(resultado.code, resultado.stderr).toBe(2);
    expect(resultado.stdout).toBe("");
    expect(resultado.stderr).toContain("não foi possível ler tools/proton-confgen/internal/constants/api.go");
    expect(servidor.pedidos).toEqual([]);
  });
});
