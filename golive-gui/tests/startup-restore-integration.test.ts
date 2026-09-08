import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const mainSource = () => fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");

describe("integração da restauração automática do bypass", () => {
  it("só agenda restauração automática no Windows e com --hidden", () => {
    const src = mainSource();
    expect(src).toMatch(/if \(!IS_WINDOWS \|\| !launchedHidden\(\) \|\| !readBypassEnabled\(\)\)/);
    expect(src).toContain("void restoreBypassFromWindowsStartup()");
  });

  it("não deixa o otimizador do renderer concorrer com o boot oculto", () => {
    const src = mainSource();
    const handler = src.slice(src.indexOf('ipcMain.handle("optimize-proton-route"'), src.indexOf('ipcMain.handle("report-bug"'));
    expect(handler).toContain("startupRestoreInFlight");
    expect(handler).toContain("deferred: true");
  });

  it("cancela a restauração automática antes de ações que desligam o bypass", () => {
    const src = mainSource();
    const deactivate = src.slice(src.indexOf('ipcMain.handle("deactivate"'), src.indexOf('ipcMain.handle("restore-internet"'));
    const restore = src.slice(src.indexOf('ipcMain.handle("restore-internet"'), src.indexOf('ipcMain.handle("get-platform"'));
    const beforeQuit = src.slice(src.indexOf('app.on("before-quit"'), src.indexOf('app.on("window-all-closed"'));
    expect(deactivate).toContain("cancelStartupBypassRestore()");
    expect(restore).toContain("cancelStartupBypassRestore()");
    expect(beforeQuit).toContain("cancelStartupBypassRestore()");
  });

  it("preserva a preferência em falha e só a desliga após ação explícita concluída", () => {
    const src = mainSource();
    expect(src).toContain("bypassEnabled: true");
    expect(src).toContain("persistBypassEnabled(false)");
    const startup = src.slice(src.indexOf("function restoreBypassFromWindowsStartup"), src.indexOf("function recoverProtonUsername"));
    expect(startup).toContain("preferência preservada");
  });
});
