import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { decideProtonSession, protonSessionUnverifiedMessage } from "../src/proton-session";

const AVISO_GENERICO = "Não consegui confirmar sua sessão Proton agora. A ativação com a rota já preparada continua disponível.";
const AVISO_VERSAO_RECUSADA = "A Proton deixou de aceitar esta versão do GoLiveBypass. A ativação com a rota já preparada continua disponível; para entrar ou trocar de rota, atualize o GoLiveBypass.";

describe("Decisão de sessão Proton no painel", () => {
  it("mantém a conta conectada quando a verificação falha por rede ou helper", () => {
    // rede/API fora do ar por instantes
    expect(decideProtonSession({ valid: false, retryable: true })).toBe("unverified");
    // helper ou timeout
    expect(decideProtonSession({ valid: false, retryable: true })).toBe("unverified");
  });

  it("derruba a conta apenas em sessão realmente inválida", () => {
    expect(decideProtonSession({ valid: false, retryable: false })).toBe("logged-out");
    expect(decideProtonSession({ valid: false })).toBe("logged-out");
    expect(decideProtonSession(undefined)).toBe("logged-out");
  });

  it("trata sessão válida como autenticada", () => {
    expect(decideProtonSession({ valid: true })).toBe("authenticated");
    expect(decideProtonSession({ valid: true, retryable: true })).toBe("authenticated");
  });

  it("mantém a conta conectada quando a Proton recusa a versão do app", () => {
    const check = { valid: false, code: "APP_VERSION_UNSUPPORTED", retryable: true };
    expect(decideProtonSession(check)).toBe("unverified");
    // Versão recusada nunca vira logout, nem se o retryable faltar ou vier falso.
    expect(decideProtonSession({ valid: false, code: "APP_VERSION_UNSUPPORTED" })).toBe("unverified");
    expect(decideProtonSession({ valid: false, code: "APP_VERSION_UNSUPPORTED", retryable: false })).toBe("unverified");
    expect(protonSessionUnverifiedMessage(check)).toBe(AVISO_VERSAO_RECUSADA);
  });

  it("mantém o aviso genérico para as demais falhas de verificação", () => {
    expect(protonSessionUnverifiedMessage({ valid: false, code: "NETWORK_ERROR", retryable: true })).toBe(AVISO_GENERICO);
    expect(protonSessionUnverifiedMessage({ valid: false, retryable: true })).toBe(AVISO_GENERICO);
    expect(protonSessionUnverifiedMessage(undefined)).toBe(AVISO_GENERICO);
  });

  it("a GUI não volta a bloquear a ativação pela verificação de sessão isolada", () => {
    const renderer = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    // #312/#316/#317: `valid: false` transitório deslogava a conta e travava o botão.
    expect(renderer).toContain("decideProtonSession(chk)");
    expect(renderer).toContain("setProtonFeedback(protonSessionUnverifiedMessage(chk), 'busy');");
    expect(renderer).not.toMatch(/if \(chk\.valid\)/);
    expect(renderer).toContain("hasSelectedConf = isProtonAuthenticated || protonProfileReady;");
  });
});
