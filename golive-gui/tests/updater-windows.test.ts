import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import cp from "child_process";
import { tryReplace, isQuittingForUpdate, markQuittingForUpdate } from "../electron/updater";

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

  it("substitui arquivo existente por novo arquivo via renomeacao para .old", async () => {
    const target = path.join(tempDir, "GoLiveBypass.exe");
    const downloaded = path.join(tempDir, "GoLiveBypass-update.exe");

    fs.writeFileSync(target, "versao-antiga");
    fs.writeFileSync(downloaded, "versao-nova");

    const result = await tryReplace(target, downloaded);
    expect(result).toBe(true);

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("versao-nova");
    expect(fs.existsSync(`${target}.old`)).toBe(true);
    expect(fs.readFileSync(`${target}.old`, "utf8")).toBe("versao-antiga");
  });

  it("remove .old previo antes de substituir quando o processo anterior ja morreu", async () => {
    const target = path.join(tempDir, "GoLiveBypass.exe");
    const downloaded = path.join(tempDir, "GoLiveBypass-update.exe");
    const oldTarget = `${target}.old`;

    fs.writeFileSync(oldTarget, "lixo-de-update-anterior");
    fs.writeFileSync(target, "versao-1");
    fs.writeFileSync(downloaded, "versao-2");

    const result = await tryReplace(target, downloaded);
    expect(result).toBe(true);

    expect(fs.readFileSync(target, "utf8")).toBe("versao-2");
    expect(fs.readFileSync(oldTarget, "utf8")).toBe("versao-1");
  });

  it("substitui com sucesso um executavel em execucao no Windows", async () => {
    const target = path.join(tempDir, "running_app.exe");
    const downloaded = path.join(tempDir, "new_app.exe");

    // Copia o node.exe atual para simular um executavel real em execucao
    fs.copyFileSync(process.execPath, target);
    fs.writeFileSync(downloaded, "conteudo-nova-versao");

    // Inicia o target como processo filho para prender o arquivo no OS
    const child = cp.spawn(target, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

    try {
      // Verifica que o Windows bloqueia a exclusao direta do executavel em execucao
      let deleteFailed = false;
      try {
        fs.unlinkSync(target);
      } catch {
        deleteFailed = true;
      }
      expect(deleteFailed).toBe(true);

      // tryReplace deve conseguir renomear para .old e gravar o novo executavel no target
      const result = await tryReplace(target, downloaded);
      expect(result).toBe(true);

      expect(fs.readFileSync(target, "utf8")).toBe("conteudo-nova-versao");
      expect(fs.existsSync(`${target}.old`)).toBe(true);
    } finally {
      child.kill();
    }
  });

  it("gerencia a flag de encerramento por update (markQuittingForUpdate / isQuittingForUpdate)", () => {
    markQuittingForUpdate();
    expect(isQuittingForUpdate()).toBe(true);
  });
});
