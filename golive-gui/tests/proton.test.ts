import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import {
  findProtonConfgenExe,
  getProtonSessionFile,
  parseConfgenJson,
  runConfgen,
  checkProtonSession,
  loginProton,
  generateOptimalProtonConfig,
  getSavedSessionUsername,
  confirmSavedSessionIdentity,
  protonIdentityMatches,
  classifyProtonError,
  normalizeProtonPlanResult,
  normalizeProtonSessionResult,
} from "../electron/proton";
import { resolveConfgenBinary } from "./helpers/confgen-binary";

// Estes testes executam o helper Go de verdade; sem o binário compilado (e sem
// `go` para compilá-lo) eles pulam, pois sem ele o produto tentaria baixar o runtime.
const hasConfgen = resolveConfgenBinary() !== undefined;
const itConfgen = it.skipIf(!hasConfgen);

describe("ProtonVPN Integration & Sidecar", () => {
  it("registra as fases do helper sem expor sessão ou credenciais", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "electron/proton.ts"), "utf8");
    expect(source).toContain("ensureProtonConfgen");
    expect(source).toContain("logEvent");
    expect(source).toContain("safeConfgenArgs");
    expect(source).not.toContain("logger.info('proton', 'sessão");
  });

  it("gera perfis Proton com IPv6 para impedir saida direta fora do AllowedIPs", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "electron/proton.ts"), "utf8");
    const generation = source.slice(source.indexOf("export async function generateOptimalProtonConfig"));
    expect(generation).toContain("'-ipv6'");
  });

  it("processa o JSON final depois de uma mensagem de sessao salva", () => {
    const result = parseConfgenJson(
      'Using saved session (expires in 4 weeks)\n{"success":true,"server":"US-FREE#137","pingMs":34}\n',
    );

    expect(result).toEqual({ success: true, server: "US-FREE#137", pingMs: 34 });
  });

  itConfgen("encontra o binario proton-confgen compilado", () => {
    const exe = findProtonConfgenExe();
    expect(fs.existsSync(exe)).toBe(true);
    expect(path.basename(exe)).toMatch(/proton-confgen(\.exe)?$/);
  });

  it("calcula o caminho do arquivo de sessao proton corretamente", () => {
    const tmpDir = "/tmp/golive-test";
    const sessionFile = getProtonSessionFile(tmpDir);
    expect(sessionFile).toBe(path.join(tmpDir, "proton-session.json"));
  });

  itConfgen("recupera somente o usuario da sessao pelo contrato do helper", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proton-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "proton-session.json"), JSON.stringify({
        username: "conta@example.com",
        session: { AccessToken: "nao deve ser retornado", UID: "synthetic-uid" },
      }));
      await expect(getSavedSessionUsername(tmpDir)).resolves.toBe("conta@example.com");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("compara a identidade Proton sem falso negativo de caixa ou espacos", () => {
    expect(protonIdentityMatches(" Conta@Proton.Me ", "conta@proton.me")).toBe(true);
    expect(protonIdentityMatches("conta-a", "conta-b")).toBe(false);
  });

  it("confirma a sessao quando o arquivo fica visivel numa tentativa posterior", async () => {
    const leituras = ["", "", "conta@proton.me"];
    const confirmation = await confirmSavedSessionIdentity("/nao-usado", "Conta@Proton.Me", {
      attempts: 4,
      delayMs: 0,
      readUsername: () => leituras.shift() ?? "",
      wait: async () => {},
    });
    expect(confirmation).toEqual({ confirmed: true, savedUsername: "conta@proton.me", attempts: 3 });
  });

  it("mantem a ausencia como diagnostico depois das tentativas", async () => {
    const confirmation = await confirmSavedSessionIdentity("/nao-usado", "conta@proton.me", {
      attempts: 3,
      delayMs: 0,
      readUsername: () => "",
      wait: async () => {},
    });
    expect(confirmation).toEqual({ confirmed: false, savedUsername: "", attempts: 3 });
  });

  it("nao converte sucesso do sidecar em falso erro por releitura imediata", () => {
    const main = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const handler = main.slice(main.indexOf('ipcMain.handle("login-proton"'), main.indexOf('ipcMain.handle("logout-proton"'));
    expect(handler).toContain("confirmSavedSessionIdentity");
    expect(handler).toContain("void proton.confirmSavedSessionIdentity");
    expect(handler).not.toContain("savedUsername !== payload.username");
    expect(handler).not.toContain("a sessão não foi persistida");
  });

  it("classifica falhas de login em mensagens acionaveis", () => {
    expect(classifyProtonError("2FA_REQUIRED").code).toBe("TWO_FACTOR_REQUIRED");
    expect(classifyProtonError("CAPTCHA_REQUIRED").code).toBe("CAPTCHA_REQUIRED");
    expect(classifyProtonError("CAPTCHA_INVALID").code).toBe("CAPTCHA_INVALID");
    expect(classifyProtonError("invalid password").code).toBe("INVALID_CREDENTIALS");
    expect(classifyProtonError("Tempo limite excedido").code).toBe("TIMEOUT");
    // O prefixo genérico do helper cobre falha de transporte/protocolo também;
    // sem texto explícito de credencial, não pode acusar senha errada.
    const wrappedProtocol = classifyProtonError("authentication failed: Proton session verification returned an invalid HTTP status (200)");
    expect(wrappedProtocol.code).toBe("UNKNOWN");
    expect(wrappedProtocol.retryable).toBe(true);
    const missing = classifyProtonError("spawn proton-confgen ENOENT");
    expect(missing.code).toBe("MISSING_EXECUTABLE");
    expect(missing.retryable).toBe(true);
    expect(missing.message).not.toContain("Reinstale o GoLiveBypass");
    const persistence = classifyProtonError("failed to migrate session file: failed to commit session file: access denied");
    expect(persistence).toMatchObject({ code: "SESSION_PERSISTENCE", retryable: true });
    expect(persistence.message).toContain("senha não foi verificada");
  });

  it("classifica o plano somente quando MaxTier e valido", () => {
    expect(normalizeProtonPlanResult({
      success: true,
      maxTier: 0,
      planTitle: "Free",
    })).toMatchObject({ success: true, status: "free", maxTier: 0 });
    expect(normalizeProtonPlanResult({
      success: true,
      maxTier: 2,
      planTitle: "VPN Plus",
    })).toMatchObject({ success: true, status: "premium", maxTier: 2, planTitle: "VPN Plus" });
    expect(normalizeProtonPlanResult({ success: true })).toMatchObject({ success: false, status: "unknown" });
    expect(normalizeProtonPlanResult({ success: true, maxTier: -1 })).toMatchObject({ success: false, status: "unknown" });
    expect(normalizeProtonPlanResult({ success: false, status: "free", maxTier: 0 })).toMatchObject({ success: false, status: "unknown" });
  });

  it("separa sessao invalida de falha temporaria de verificacao", () => {
    expect(normalizeProtonSessionResult({ success: true, valid: true, username: "conta_teste", expiresIn: "3h0m0s" }))
      .toMatchObject({ valid: true, username: "conta_teste", expiresIn: "3h0m0s" });

    // Helper novo: codigo explicito no JSON.
    expect(normalizeProtonSessionResult({ success: false, valid: false, code: "NETWORK_ERROR", retryable: true, error: "sem rede" }))
      .toMatchObject({ valid: false, code: "NETWORK_ERROR", retryable: true });
    expect(normalizeProtonSessionResult({ success: false, valid: false, code: "INVALID_SESSION", retryable: false, error: "Sessão expirada ou não encontrada" }))
      .toMatchObject({ valid: false, code: "INVALID_SESSION", retryable: false });

    // Helper antigo (2.0.6): so a mensagem distingue, e ela nao pode virar logout.
    expect(normalizeProtonSessionResult({ success: false, valid: false, error: "Não foi possível verificar a sessão Proton temporariamente" }))
      .toMatchObject({ valid: false, code: "NETWORK_ERROR", retryable: true });
    expect(normalizeProtonSessionResult({ success: false, valid: false, error: "Sessão expirada ou não encontrada" }))
      .toMatchObject({ valid: false, code: "INVALID_SESSION", retryable: false });

    // Resposta ausente/estranha nunca vira "autenticado" nem "retryable".
    expect(normalizeProtonSessionResult(null)).toMatchObject({ valid: false, retryable: false });
    // Codigo desconhecido sem pista temporaria: invalido (o helper futuro marca retryable).
    expect(normalizeProtonSessionResult({ success: true, valid: false, code: "ALGO_NOVO" }))
      .toMatchObject({ valid: false, code: "INVALID_SESSION", retryable: false });
    expect(normalizeProtonSessionResult({ success: false, valid: false, code: "ALGO_NOVO", retryable: true }))
      .toMatchObject({ valid: false, retryable: true });
  });

  it("trata a versao do app recusada pela Proton como falha de verificacao, nao sessao invalida", () => {
    // Contrato do helper para -check-session.
    expect(normalizeProtonSessionResult({
      success: false,
      valid: false,
      error: "A Proton não aceita mais esta versão do GoLiveBypass",
      code: "APP_VERSION_UNSUPPORTED",
      retryable: true,
    }, "conta_teste")).toEqual({
      valid: false,
      code: "APP_VERSION_UNSUPPORTED",
      retryable: true,
      error: "A Proton não aceita mais esta versão do GoLiveBypass",
    });
    // Sem o campo retryable, o proprio codigo ja e retryable.
    expect(normalizeProtonSessionResult({ success: false, valid: false, code: "APP_VERSION_UNSUPPORTED" }))
      .toMatchObject({ valid: false, code: "APP_VERSION_UNSUPPORTED", retryable: true });
  });

  itConfgen("cria a pasta de dados antes de executar o login", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proton-test-"));
    const nested = path.join(root, "nested", "data");
    try {
      const res = await checkProtonSession(nested, "usuario_inexistente");
      expect(res.valid).toBe(false);
      expect(fs.existsSync(nested)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  itConfgen("inicia proton-confgen sem duplicar flags globais", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proton-test-"));
    try {
      const sessionFile = path.join(tmpDir, "dummy-session.json");
      // Regra de regressão: uma flag repetida aborta o helper antes de autenticar.
      const res = await runConfgen({
        args: [
          "-username", "teste_golive",
          "-session-file", sessionFile,
          "-check-session",
          "-json",
        ],
        timeoutMs: 5000,
      });

      expect(res.code).toBe(0);
      expect(res.json).toBeDefined();
      expect(res.json.valid).toBe(false);
      expect(typeof res.json.error).toBe("string");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("checkProtonSession valida obrigatoriedade do usuario", async () => {
    const res = await checkProtonSession("/tmp", "");
    expect(res.valid).toBe(false);
    expect(res.error).toBe("Usuário não especificado.");
  });

  itConfgen("checkProtonSession detecta sessao inexistente", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proton-test-"));
    try {
      const res = await checkProtonSession(tmpDir, "usuario_inexistente");
      expect(res.valid).toBe(false);
      expect(res.error).toBeTruthy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // O sidecar faz uma chamada real ao endpoint Proton; em CI/VM o DNS/TLS pode
  // demorar mais que o timeout padrão de 5s do Vitest. O timeout do produto é
  // 25s, portanto o teste deve aguardar essa mesma janela sem mascarar travas.
  itConfgen("loginProton reporta erro quando credenciais sao invalidas", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proton-test-"));
    try {
      const res = await loginProton(tmpDir, "usuario_falso_golive_xyz", "senha_incorreta_123");
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000);

  itConfgen("generateOptimalProtonConfig falha graciosamente se nao houver sessao ativa", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proton-test-"));
    try {
      const res = await generateOptimalProtonConfig(tmpDir, {
        username: "usuario_falso_golive",
        countries: "US",
        freeOnly: true,
        autoPing: true,
      });
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
