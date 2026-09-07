import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import vm from "node:vm";
import ts from "typescript";
import {
  isAllowedProtonCaptchaNavigation,
  parseProtonCaptchaChallenge,
  validateProtonCaptchaResponse,
} from "../electron/proton-captcha";

describe("CAPTCHA Proton integrado", () => {
  it("aceita somente o desafio oficial servido por HTTPS", () => {
    const challenge = parseProtonCaptchaChallenge("https://vpn-api.proton.me/core/v4/captcha?Token=abc123");
    expect(challenge).toMatchObject({ challenge: "abc123", origin: "https://vpn-api.proton.me" });
    expect(parseProtonCaptchaChallenge("http://vpn-api.proton.me/core/v4/captcha?Token=abc123")).toBeNull();
    expect(parseProtonCaptchaChallenge("https://proton.me.evil.test/core/v4/captcha?Token=abc123")).toBeNull();
    expect(parseProtonCaptchaChallenge("https://vpn-api.proton.me/outro?Token=abc123")).toBeNull();
  });

  it("bloqueia navegação para fora da página oficial do desafio", () => {
    const challenge = parseProtonCaptchaChallenge("https://vpn-api.proton.me/core/v4/captcha?Token=abc123")!;
    expect(isAllowedProtonCaptchaNavigation(challenge.url, challenge)).toBe(true);
    expect(isAllowedProtonCaptchaNavigation("https://account.proton.me/login", challenge)).toBe(false);
    expect(isAllowedProtonCaptchaNavigation("https://evil.test/core/v4/captcha?Token=abc123", challenge)).toBe(false);
  });

  it("aceita apenas a resposta vinculada ao desafio atual", () => {
    expect(validateProtonCaptchaResponse("abc123:resposta", "abc123")).toBe(true);
    expect(validateProtonCaptchaResponse("outro:resposta", "abc123")).toBe(false);
    expect(validateProtonCaptchaResponse("abc123", "abc123")).toBe(false);
    expect(validateProtonCaptchaResponse(123, "abc123")).toBe(false);
  });

  it("preload encaminha mensagens válidas, ignora entradas inválidas e persiste duplicatas", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "electron/proton-captcha-preload.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const sent: unknown[] = [];
    let listener: ((event: { data?: unknown }) => void) | undefined;
    const module = { exports: {} as Record<string, unknown> };
    const context = {
      window: { addEventListener: (_type: string, fn: (event: { data?: unknown }) => void) => { listener = fn; } },
      module,
      exports: module.exports,
      require: (name: string) => name === "electron"
        ? { ipcRenderer: { send: (_channel: string, message: unknown) => sent.push(message) } }
        : { PROTON_CAPTCHA_IPC_CHANNEL: "proton-captcha-response" },
    };
    vm.runInNewContext(compiled, context);
    expect(listener).toBeDefined();
    listener!({ data: { type: "wrong", token: "challenge:ignored" } });
    listener!({ data: { type: "proton_captcha", token: 123 } });
    listener!({ data: { type: "proton_captcha", token: "x".repeat(16_385) } });
    listener!({ data: { type: "pm_captcha", token: "challenge:invalid" } });
    listener!({ data: { type: "proton_captcha", token: "challenge:valid" } });
    listener!({ data: { type: "proton_captcha", token: "challenge:duplicate" } });
    expect(sent).toEqual([
      { type: "pm_captcha", token: "challenge:invalid" },
      { type: "proton_captcha", token: "challenge:valid" },
      { type: "proton_captcha", token: "challenge:duplicate" },
    ]);
    expect((context as Record<string, unknown>).process).toBeUndefined();
  });

  it("abre uma janela isolada e repete o login sem expor token ao renderer", () => {
    const main = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const flow = main.slice(main.indexOf("async function solveProtonCaptcha"), main.indexOf('ipcMain.handle("logout-proton"'));
    expect(flow).toContain("nodeIntegration: false");
    expect(flow).toContain("contextIsolation: true");
    expect(flow).toContain("sandbox: true");
    expect(flow).toContain('setWindowOpenHandler(() => ({ action: "deny" }))');
    expect(flow).toContain("const captchaSession = captchaWindow.webContents.session");
    expect(flow).toContain('captchaSession.removeListener("will-download", preventDownload)');
    expect(flow).toContain("validateProtonCaptchaResponse");
    expect(flow).toContain("solved.token");
    expect(flow).not.toContain("shell.openExternal");
  });

  it("runner de regressao usa preload compilado e origem HTTPS interceptada", () => {
    const runner = fs.readFileSync(path.resolve(process.cwd(), "scripts/captcha-electron-regression.mjs"), "utf8");
    const main = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(runner).toContain("CAPTCHA_PRELOAD");
    expect(runner).toContain('protocol.handle("https"');
    expect(main).toContain("captchaWindow.loadURL(challenge.url)");
    expect(runner).toContain('url.hostname !== "proton.me"');
    expect(runner).not.toContain("about:blank");
    expect(runner).not.toContain("false &&");
  });
});
