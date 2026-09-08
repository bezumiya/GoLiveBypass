import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const mainSource = () => fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");

describe("preferência persistida do bypass", () => {
  it("persiste true somente após ativação concluída", () => {
    const src = mainSource();
    const activation = src.slice(src.indexOf("async function executarAtivacao"), src.indexOf("async function deactivateAll"));
    expect(activation).toContain("persistBypassEnabled(true)");
    expect(activation.lastIndexOf("persistBypassEnabled(true)")).toBeGreaterThan(activation.indexOf("startProtonFailoverMonitor()"));
  });

  it("não apaga a preferência no encerramento limpo", () => {
    const src = mainSource();
    const beforeQuit = src.slice(src.indexOf('app.on("before-quit"'), src.indexOf('app.on("window-all-closed"'));
    expect(beforeQuit).not.toContain("persistBypassEnabled(false)");
  });

  it("desativação explícita só persiste false depois da operação", () => {
    const src = mainSource();
    const handler = src.slice(src.indexOf('ipcMain.handle("deactivate"'), src.indexOf('ipcMain.handle("restore-internet"'));
    expect(handler.indexOf("await deactivateAll()")).toBeLessThan(handler.indexOf("persistBypassEnabled(false)"));
  });
});
