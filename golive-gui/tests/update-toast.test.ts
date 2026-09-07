import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = path.resolve(process.cwd());

describe("toast de atualização na GUI", () => {
  it("tem markup acessível e botão de fechamento", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    expect(html).toContain('id="updateToast"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="updateToastClose"');
  });

  it("recebe o aviso pelo preload e mostra uma mensagem temporária", () => {
    const preload = fs.readFileSync(path.join(root, "electron/preload.ts"), "utf8");
    const renderer = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
    expect(preload).toContain("onUpdateAvailable");
    expect(preload).toContain("update-available");
    expect(renderer).toContain("showUpdateToast");
    expect(renderer).toContain("setTimeout(hideUpdateToast, 5000)");
  });

  it("envia o aviso quando o updater termina de preparar o update", () => {
    const main = fs.readFileSync(path.join(root, "electron/main.ts"), "utf8");
    const updater = fs.readFileSync(path.join(root, "electron/updater.ts"), "utf8");
    expect(main).toContain('mainWindow.webContents.send("update-available", info)');
    expect(updater).toContain("UpdateReadyInfo");
    expect(updater).toContain("setUpdateReady(true, { version: pending.version");
  });
});
