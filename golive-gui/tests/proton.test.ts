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
} from "../electron/proton";

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

  it("encontra o binario proton-confgen compilado", () => {
    const exe = findProtonConfgenExe();
    expect(fs.existsSync(exe)).toBe(true);
    expect(path.basename(exe)).toMatch(/proton-confgen(\.exe)?$/);
  });

  it("calcula o caminho do arquivo de sessao proton corretamente", () => {
    const tmpDir = "/tmp/golive-test";
    const sessionFile = getProtonSessionFile(tmpDir);
    expect(sessionFile).toBe(path.join(tmpDir, "proton-session.json"));
  });

  it("recupera somente o usuario da sessao persistida", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proton-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "proton-session.json"), JSON.stringify({
        username: "conta@example.com",
        session: { AccessToken: "nao deve ser retornado" },
      }));
      expect(getSavedSessionUsername(tmpDir)).toBe("conta@example.com");
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
    const missing = classifyProtonError("spawn proton-confgen ENOENT");
    expect(missing.code).toBe("MISSING_EXECUTABLE");
    expect(missing.retryable).toBe(true);
    expect(missing.message).not.toContain("Reinstale o GoLiveBypass");
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

  it("cria a pasta de dados antes de executar o login", async () => {
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

  it("executa proton-confgen e processa JSON retornado", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proton-test-"));
    try {
      const sessionFile = path.join(tmpDir, "dummy-session.json");
      const res = await runConfgen({
        args: [
          "-username", "teste_golive",
          "-session-file", sessionFile,
          "-check-session",
          "-json",
        ],
        timeoutMs: 5000,
      });

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

  it("checkProtonSession detecta sessao inexistente", async () => {
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
  it("loginProton reporta erro quando credenciais sao invalidas", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proton-test-"));
    try {
      const res = await loginProton(tmpDir, "usuario_falso_golive_xyz", "senha_incorreta_123");
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000);

  it("generateOptimalProtonConfig falha graciosamente se nao houver sessao ativa", async () => {
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
