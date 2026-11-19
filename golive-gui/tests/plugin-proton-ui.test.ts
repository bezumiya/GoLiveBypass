import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  formatProtonRoutePing,
  isProtonRouteSelectable,
  mergeProtonRouteCatalog,
  PROTON_APP_VERSION_UNSUPPORTED_MESSAGE,
  protonLoginPresentation,
  protonRouteStateLabel,
  recommendProtonRoute,
  reduceProtonRouteEvent,
  shouldMeasureRouteCatalogOnFailure,
  sortProtonRouteCandidates,
  type ProtonRouteCandidate,
} from "../../goLiveBypass/proton-manual-selection";


function candidate(server: string, overrides: Partial<ProtonRouteCandidate> = {}): ProtonRouteCandidate {
  return {
    server,
    pingStatus: "not-tested",
    preflightStatus: "not-tested",
    speedStatus: "not-tested",
    ...overrides,
  };
}


describe("modelo de rotas Proton do plugin", () => {
  it("preenche catálogo, ping, preflight e velocidade na mesma candidata", () => {
    let state = new Map<string, ProtonRouteCandidate>();
    state = reduceProtonRouteEvent(state, {
      phase: "catalog",
      server: "NL#2",
      country: "NL",
      city: "Amsterdam",
      tier: "Free",
      load: 21,
      score: 2,
    });

    expect(state.get("NL#2")).toMatchObject({ pingStatus: "pending", preflightStatus: "not-tested", speedStatus: "not-tested" });
    expect(state.get("NL#2")).not.toHaveProperty("pingMs");

    state = reduceProtonRouteEvent(state, {
      phase: "catalog",
      server: "NL#2",
      country: "NL",
      city: "Amsterdam",
      tier: "Free",
      load: 21,
      score: 2,
      pingMs: 188,
      status: "success",
    });
    state = reduceProtonRouteEvent(state, { phase: "preparing", server: "NL#2", status: "success" });
    state = reduceProtonRouteEvent(state, {
      phase: "testing",
      server: "NL#2",
      downloadMbps: 42.5,
      uploadMbps: 8.2,
      status: "success",
    });

    expect(state.get("NL#2")).toMatchObject({
      server: "NL#2",
      country: "NL",
      city: "Amsterdam",
      tier: "Free",
      load: 21,
      score: 2,
      pingMs: 188,
      pingStatus: "success",
      preflightStatus: "success",
      speedStatus: "success",
      downloadMbps: 42.5,
      uploadMbps: 8.2,
    });
    expect(isProtonRouteSelectable(state.get("NL#2")!)).toBe(true);
  });

  it("ignora ping fora da faixa válida e eventos de geração sem servidor", () => {
    let state = new Map<string, ProtonRouteCandidate>([[ "US#8", candidate("US#8", { pingMs: 188, pingStatus: "success" }) ]]);

    const withoutServer = reduceProtonRouteEvent(state, { phase: "ping", pingMs: 120, status: "success" });
    expect(withoutServer).toEqual(state);

    state = reduceProtonRouteEvent(withoutServer, { phase: "ping", server: "US#8", pingMs: 999, status: "success" });
    expect(state.get("US#8")).toMatchObject({ pingMs: 188, pingStatus: "success" });
    expect(state.get("US#8")).not.toHaveProperty("failureReason");
  });

  it("mantém estados independentes e não torna aplicável rota reprovada no preflight", () => {
    let state = new Map<string, ProtonRouteCandidate>();
    state = reduceProtonRouteEvent(state, { phase: "ping", server: "US#72", pingMs: 205, status: "success" });
    state = reduceProtonRouteEvent(state, { phase: "preparing", server: "US#72", status: "failed" });

    expect(state.get("US#72")).toMatchObject({
      pingStatus: "success",
      preflightStatus: "failed",
      speedStatus: "not-tested",
      failureReason: "Falha no túnel ou HTTPS",
    });
    expect(isProtonRouteSelectable(state.get("US#72")!)).toBe(false);
    expect(protonRouteStateLabel(state.get("US#72")!, { discoveryActive: false })).toBe("Falha no túnel ou HTTPS");

    state = reduceProtonRouteEvent(state, { phase: "preparing", server: "US#72", status: "success" });
    expect(state.get("US#72")).not.toHaveProperty("failureReason");
    expect(isProtonRouteSelectable(state.get("US#72")!)).toBe(true);
  });

  it("explica a linha sem medição pela fase da descoberta", () => {
    const catalogued = candidate("NL#2");
    expect(protonRouteStateLabel(catalogued, { discoveryActive: true })).toBe("Medindo ping");
    expect(protonRouteStateLabel(catalogued, { discoveryActive: false })).toBe("Indisponível");
    expect(protonRouteStateLabel(candidate("NL#2", { pingStatus: "failed" }), { discoveryActive: true })).toBe("Sem resposta ao ping");
    expect(formatProtonRoutePing(catalogued.pingMs)).toBe("—");
    expect(formatProtonRoutePing(188.4)).toBe("188 ms");
    expect(isProtonRouteSelectable(catalogued)).toBe(false);
  });

  it("preserva candidatas já medidas ao mesclar o catálogo final", () => {
    const measured = candidate("US#8", {
      pingMs: 205,
      pingStatus: "success",
      speedStatus: "success",
      downloadMbps: 42.5,
      uploadMbps: 8.2,
    });

    const merged = mergeProtonRouteCatalog(new Map([["US#8", measured]]), [
      { server: "US#8", country: "US", city: "New York", tier: "Free", load: 40, score: 1 },
      { server: "DE#4", country: "DE", city: "Berlin", tier: "Free", load: 19, score: 3, pingMs: 197, status: "success" },
      { server: "   ", country: "XX" },
    ]);

    expect(merged.get("US#8")).toMatchObject({ pingMs: 205, pingStatus: "success", speedStatus: "success", downloadMbps: 42.5, uploadMbps: 8.2, city: "New York" });
    expect(merged.get("DE#4")).toMatchObject({ pingMs: 197, pingStatus: "success" });
    expect(merged.size).toBe(2);
  });

  it("ordena por ping crescente com nome normalizado como desempate estável", () => {
    const routes = [
      candidate("US#50", { pingMs: 198, pingStatus: "success" }),
      candidate("us#10", { pingMs: 150, pingStatus: "success" }),
      candidate("DE#1", { pingMs: 150, pingStatus: "success" }),
      candidate("US#99", { pingMs: 999, pingStatus: "success" }),
      candidate("US#72", { pingMs: 205, pingStatus: "failed" }),
    ];

    expect(sortProtonRouteCandidates(routes).map(route => route.server)).toEqual(["DE#1", "us#10", "US#50", "US#72", "US#99"]);
  });

  it("recomenda por capacidade harmônica e nunca uma rota sem ping válido ou reprovada", () => {
    const routes = [
      candidate("US#8", { pingMs: 188, pingStatus: "success", speedStatus: "success", downloadMbps: 80, uploadMbps: 10 }),
      candidate("US#50", { pingMs: 198, pingStatus: "success", speedStatus: "success", downloadMbps: 50, uploadMbps: 50 }),
      candidate("NL#2", { pingMs: 150, pingStatus: "success" }),
    ];

    expect(recommendProtonRoute(routes)).toBe("US#50");
    expect(recommendProtonRoute(routes.filter(route => route.server !== "US#50"))).toBe("US#8");
    expect(recommendProtonRoute([
      candidate("US#9", { pingMs: 120, pingStatus: "success", preflightStatus: "failed", speedStatus: "success", downloadMbps: 90, uploadMbps: 90 }),
      candidate("NL#2", { pingMs: 150, pingStatus: "success" }),
    ])).toBe("NL#2");
    expect(recommendProtonRoute([candidate("US#72", { pingStatus: "failed" })])).toBeUndefined();
  });

  it("mede o catálogo depois da falha só quando não sobrou rota selecionável", () => {
    const noAnswer = candidate("US#99", { pingMs: 999, pingStatus: "success" });
    const failedPing = candidate("US#72", { pingStatus: "failed" });
    const failedPreflight = candidate("NL#2", { pingMs: 150, pingStatus: "success", preflightStatus: "failed" });
    const usable = candidate("MX#14", { pingMs: 126, pingStatus: "success" });

    expect(shouldMeasureRouteCatalogOnFailure([])).toBe(true);
    expect(shouldMeasureRouteCatalogOnFailure(undefined)).toBe(true);
    expect(shouldMeasureRouteCatalogOnFailure([noAnswer, failedPing])).toBe(true);
    expect(shouldMeasureRouteCatalogOnFailure([failedPreflight])).toBe(true);
    expect(shouldMeasureRouteCatalogOnFailure([failedPreflight, usable])).toBe(false);
  });
});

describe("apresentação compartilhada dos erros de login", () => {
  it("mantém causas distintas e só devolve o foco à senha quando a credencial foi rejeitada", () => {
    const invalidCredentials = protonLoginPresentation({ code: "INVALID_CREDENTIALS" });
    const helperFailure = protonLoginPresentation({ code: "HELPER_ERROR" });
    const captchaInvalid = protonLoginPresentation({ code: "CAPTCHA_INVALID" });
    const captchaCancelled = protonLoginPresentation({ code: "CAPTCHA_CANCELLED" });

    expect(invalidCredentials.focusPassword).toBe(true);
    expect(helperFailure.focusPassword).toBe(false);
    expect(helperFailure.message).not.toBe(invalidCredentials.message);
    expect(captchaInvalid.message).not.toBe(captchaCancelled.message);
  });

  it("não deixa detalhe textual reclassificar credencial e preserva diagnóstico desconhecido", () => {
    const rejection = protonLoginPresentation({ code: "INVALID_CREDENTIALS", error: "authentication failed: protocol error" });
    const canonicalRejection = protonLoginPresentation({ code: "INVALID_CREDENTIALS" });
    expect(rejection).toEqual(canonicalRejection);
    expect(protonLoginPresentation({ code: "UNKNOWN", error: "rejeição desconhecida\ndo Proton" }).message).toBe("rejeição desconhecida do Proton");
    expect(protonLoginPresentation({ code: "CONFIGURATION_ERROR", error: "configuração inválida" }).message).toBe("configuração inválida");
  });

  it("versão recusada pela Proton pede atualização, sem culpar nem focar a senha", () => {
    const outdated = protonLoginPresentation({
      code: "APP_VERSION_UNSUPPORTED",
      error: "authentication failed: failed to get auth info: authentication failed with code: 5003",
    });
    expect(outdated).toEqual({
      message: "A Proton deixou de aceitar esta versão do GoLiveBypass. Atualize o GoLiveBypass para continuar.",
      focusPassword: false,
    });
    expect(outdated.message).not.toBe(protonLoginPresentation({ code: "INVALID_CREDENTIALS" }).message);
  });
});

type SessionCheck = { valid: boolean; code?: string; error?: string };

// index.tsx importa Vencord e não roda fora do Discord: as funções puras do status
// da sessão são carregadas por AST, como controllerSettings() em plugin-proton-runtime.
function sessionStatusFunctions() {
  const source = fs.readFileSync(path.resolve(process.cwd(), "../goLiveBypass/index.tsx"), "utf8");
  const parsed = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["protonSessionStatusTitle", "protonSessionStatusDetail", "protonMissingPasswordMessage"]);
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""));
  const code = ts.transpileModule(`${functions.map(node => node.getText(parsed)).join("\n")}
exports.title = protonSessionStatusTitle;
exports.detail = protonSessionStatusDetail;
exports.missingPassword = protonMissingPasswordMessage;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: Record<string, any> = {};
  vm.runInNewContext(code, { exports, PROTON_APP_VERSION_UNSUPPORTED_MESSAGE });
  return {
    source,
    found: functions.length,
    title: exports.title as (code?: string) => string,
    detail: exports.detail as (session: SessionCheck) => string,
    missingPassword: exports.missingPassword as (session: SessionCheck | null) => string,
  };
}

describe("status da sessão Proton no painel do plugin", () => {
  const VERSAO_RECUSADA = "A Proton deixou de aceitar esta versão do GoLiveBypass. Atualize o GoLiveBypass para continuar.";
  const recusada: SessionCheck = { valid: false, code: "APP_VERSION_UNSUPPORTED", error: VERSAO_RECUSADA };

  it("versão recusada mostra só a mensagem de atualização, sem título genérico nem pedido de senha", () => {
    const { found, title, detail, missingPassword } = sessionStatusFunctions();
    expect(found).toBe(3);
    expect(PROTON_APP_VERSION_UNSUPPORTED_MESSAGE).toBe(VERSAO_RECUSADA);
    expect(`${title(recusada.code)}${detail(recusada)}`).toBe(VERSAO_RECUSADA);
    expect(missingPassword(recusada)).toBe(VERSAO_RECUSADA);
  });

  it("os outros motivos continuam com título, detalhe e pedido de senha como antes", () => {
    const { title, detail, missingPassword } = sessionStatusFunctions();
    const semRede: SessionCheck = { valid: false, code: "NETWORK_ERROR", error: "Sem rede." };
    expect(`${title(semRede.code)}${detail(semRede)}`).toBe("Rede indisponível para verificar a sessão · Sem rede.");
    expect(title("UNKNOWN")).toBe("Não foi possível verificar a sessão");
    expect(missingPassword(semRede)).toBe("Sem rede. Informe a senha para entrar novamente.");
    expect(missingPassword({ valid: false, code: "INVALID_SESSION", error: "Sessão Proton não encontrada." }))
      .toBe("Informe a senha para iniciar uma nova sessão ou renovar a sessão atual.");
    expect(missingPassword(null)).toBe("Informe a senha para iniciar uma nova sessão ou renovar a sessão atual.");
  });

  it("as três telas do status e o continuar sem senha usam essas funções", () => {
    const { source } = sessionStatusFunctions();
    expect(source.match(/\{protonSessionStatusTitle\(session\.code\)\}<\/strong>\{protonSessionStatusDetail\(session\)\}/g)).toHaveLength(2);
    expect(source).toContain("`${protonSessionStatusTitle(session.code)}${protonSessionStatusDetail(session)}`");
    expect(source).toContain("setError(protonMissingPasswordMessage(session));");
    expect(source).not.toMatch(/session\.error \? ` · \$\{session\.error\}`/);
  });
});
