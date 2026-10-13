import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// Mesmo estilo do ativacao-guard: o main.ts nao e importavel sem Electron, entao as regras
// que importam sao presas pelo texto do codigo.
const main = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
const html = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
const renderer = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");

describe("reiniciar bypass e checar updates", () => {
  it("reiniciar refaz a ativacao inteira, sem a guarda de 'ja esta ativo com a mesma assinatura'", () => {
    const start = main.indexOf('ipcMain.handle("restart-bypass"');
    const body = main.slice(start, main.indexOf('ipcMain.handle("check-updates"', start));
    expect(body).toContain('assinaturaUltimaAtivacao = ""');
    expect(body).toContain("await activateBypass(null)");
    expect(body).toContain("cancelStartupBypassRestore()");
  });

  it("checar updates forca a consulta e o botao fica ao lado do Como funciona", () => {
    expect(main).toMatch(/ipcMain\.handle\("check-updates"[\s\S]{0,300}force: true/);
    expect(html).toMatch(/id="guideBtn"[\s\S]{0,900}id="checkUpdatesBtn"/);
  });
});

describe("janela redimensionavel", () => {
  it("e redimensionavel, com minimo, e o app para de forcar a altura apos resize manual", () => {
    const create = main.slice(main.indexOf("function createWindow()"), main.indexOf("function loadLogsPage"));
    expect(create).toContain("resizable: true");
    expect(create).toContain("minWidth:");
    expect(create).toContain("tamanhoManual = true");
    const handler = main.slice(main.indexOf('ipcMain.on("resize-window"'), main.indexOf("set-theme"));
    expect(handler).toMatch(/if \(tamanhoManual \|\| mainWindow\.isMaximized\(\)\) return;/);
    // A largura vem da janela, nao da constante fixa de 720.
    expect(handler).not.toContain("setContentSize(MAIN_WINDOW_WIDTH");
  });

  it("estreita, as colunas empilham na vertical", () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/style.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 560px\) \{[\s\S]{0,200}grid-template-columns: 1fr;/);
  });
});

describe("sondas e varreduras", () => {
  it("a sonda periodica que copiava um .exe para a pasta do Discord saiu do app", () => {
    expect(main).not.toContain("diagnoseWindowsRoute");
    expect(main).not.toContain("prepareDiscordScopeProbes(");
  });

  it("a leitura de trafego do tunel usa netsh e so cai no PowerShell se o netsh falhar", () => {
    const wiresock = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    const fn = wiresock.slice(wiresock.indexOf("export async function getWireSockAdapterTrafficAsync"));
    expect(fn.indexOf('"netsh"')).toBeGreaterThan(-1);
    expect(fn.indexOf('"netsh"')).toBeLessThan(fn.indexOf('"powershell.exe"'));
  });

  it("o card de trafego e o modo desenvolvedor ficam nas telas esperadas", () => {
    expect(html).toContain('id="trafficCard"');
    expect(html).toMatch(/id="settingsDialog"[\s\S]*id="devModeToggle"[\s\S]*id="guideDialog"/);
    expect(renderer).not.toContain("import.meta.env.DEV");
  });
});

describe("Sair com o bypass ativo nao trava", () => {
  const quit = main.slice(main.indexOf('app.on("before-quit"'), main.indexOf('app.on("window-all-closed"'));

  it("no Windows o Sair chama o deactivateAll direto, sem embrulhar na fila (que nao e reentrante)", () => {
    expect(quit).toContain("? deactivateAll()");
    expect(quit).not.toContain('withWireSockLifecycle("encerrar-windows"');
    // O deactivateAll se serializa sozinho: se deixasse de fazer isso, o Sair perderia a serializacao.
    const fn = main.slice(main.indexOf("async function deactivateAll("), main.indexOf("// O status do Windows e sempre lido"));
    expect(fn).toContain('withWireSockLifecycle("desativacao"');
  });

  it("a limpeza tem prazo: se travar, o app encerra assim mesmo", () => {
    expect(main).toContain("const QUIT_CLEANUP_TIMEOUT_MS = 90_000;");
    expect(quit).toContain("aguardarAte(limpeza, QUIT_CLEANUP_TIMEOUT_MS)");
    expect(quit).toMatch(/\.finally\(\(\) => app\.quit\(\)\)/);
  });
});
