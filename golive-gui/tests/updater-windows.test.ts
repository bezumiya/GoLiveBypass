import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildWindowsUpdateScript,
  spawnWindowsUpdateHelper,
  isQuittingForUpdate,
  markQuittingForUpdate,
} from "../electron/updater";

describe("updater-windows", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-updater-win-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ok
    }
  });

  it("gera o script de atualizacao batch corretamente", () => {
    const target = "C:\\MyApp\\app.exe";
    const downloaded = "C:\\Temp\\update.exe";

    const script = buildWindowsUpdateScript(target, downloaded);
    expect(script).toContain('set "TARGET=C:\\MyApp\\app.exe"');
    expect(script).toContain('set "DOWNLOADED=C:\\Temp\\update.exe"');
    expect(script).toContain('move /y "%DOWNLOADED%" "%TARGET%"');
    expect(script).toContain('start "" "%TARGET%"');
  });

  it("substitui o arquivo assim que o helper e disparado", async () => {
    const target = path.join(tempDir, "target_app.txt");
    const downloaded = path.join(tempDir, "new_app.txt");

    fs.writeFileSync(target, "conteudo-antigo");
    fs.writeFileSync(downloaded, "conteudo-novo");

    const helperOk = spawnWindowsUpdateHelper(target, downloaded);
    expect(helperOk).toBe(true);

    // Aguarda o helper do cmd.exe concluir
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === "conteudo-novo") {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(fs.readFileSync(target, "utf8")).toBe("conteudo-novo");
  });

  it("gerencia a flag de encerramento por update (markQuittingForUpdate / isQuittingForUpdate)", () => {
    markQuittingForUpdate();
    expect(isQuittingForUpdate()).toBe(true);
  });
});
