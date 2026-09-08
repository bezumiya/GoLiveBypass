import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = path.resolve(process.cwd());

describe("card de atualização na GUI", () => {
  it("tem markup acessível, fica oculto até haver update e oferece aplicação", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    expect(html).toContain('id="updateCard"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="updateCardApply"');
    expect(html).toContain('hidden>');
  });

  it("recebe o aviso pelo preload e mantém o card até aplicar", () => {
    const preload = fs.readFileSync(path.join(root, "electron/preload.ts"), "utf8");
    const renderer = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
    expect(preload).toContain("onUpdateAvailable");
    expect(preload).toContain("update-available");
    expect(preload).toContain("applyPendingUpdate");
    expect(renderer).toContain("showUpdateCard");
    expect(renderer).toContain("applyUpdateFromCard");
    expect(renderer).not.toContain("setTimeout(hideUpdateToast, 5000)");
    expect(renderer).toContain("hideUpdateCard();");
  });

  it("envia o aviso quando o updater termina de preparar o update", () => {
    const main = fs.readFileSync(path.join(root, "electron/main.ts"), "utf8");
    const updater = fs.readFileSync(path.join(root, "electron/updater.ts"), "utf8");
    expect(main).toContain('mainWindow.webContents.send("update-available", info)');
    expect(main).toContain('ipcMain.handle("apply-pending-update"');
    expect(updater).toContain("UpdateReadyInfo");
    expect(updater).toContain("setUpdateReady(true, { version: pending.version");
  });
});
