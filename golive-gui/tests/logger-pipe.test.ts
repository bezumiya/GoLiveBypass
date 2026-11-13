import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// Processo isolado: um "error" sem listener precisa realmente encerrar o Node,
// sem que o console ou os handlers de erro do Vitest escondam a regressao.
it.skipIf(process.platform !== "linux").each(["stdout", "stderr"] as const)(
  "mantem o processo e o arquivo de log com o pipe de %s fechado",
  async (saida) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-pipe-"));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const source = fs.readFileSync(path.resolve("electron/logger.ts"), "utf8");
      fs.writeFileSync(path.join(dir, "logger.cjs"), ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.CommonJS,
          esModuleInterop: true,
        },
      }).outputText);
      const fixture = path.join(dir, "fixture.cjs");
      fs.writeFileSync(fixture, `
        const fs = require("node:fs");
        const logger = require("./logger.cjs");
        logger.initLogger(__dirname);
        logger.patchConsole();
        process.once("message", () => {
          console.${saida === "stdout" ? "log" : "error"}("primeira escrita");
          setTimeout(() => {
            console.log("log depois");
            console.info("info depois");
            console.warn("warn depois");
            console.error("error depois");
            fs.writeFileSync(__dirname + "/recent.txt", logger.getRecent());
            process.disconnect();
          }, 50);
        });
      `);
      child = spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let output = "";
      const saudavel = saida === "stdout" ? "stderr" : "stdout";
      child[saudavel]!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      const running = child;
      const result = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        const timer = setTimeout(() => {
          running.kill("SIGKILL");
          reject(new Error("processo nao encerrou apos erro no pipe"));
        }, 5000);
        running.once("error", (error) => { clearTimeout(timer); reject(error); });
        running.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      // Fecha o leitor antes de autorizar a escrita. O SO produz EPIPE real.
      child[saida]!.destroy();
      child.send!("escrever");
      expect(await result, output).toEqual({ code: 0, signal: null });
      for (const name of ["gui.log", "recent.txt"]) {
        const log = fs.readFileSync(path.join(dir, name), "utf8");
        expect(log).toContain(`saida=${saida} codigo=EPIPE`);
        for (const msg of ["primeira escrita", "log depois", "info depois", "warn depois", "error depois"]) {
          expect(log).toContain(msg);
        }
      }
      expect(output).toContain(saida === "stdout" ? "warn depois" : "log depois");
    } finally {
      if (child?.exitCode === null) child.kill("SIGKILL");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  10_000,
);
