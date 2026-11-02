import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import * as logger from "../electron/logger";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-log-"));
  logger._resetForTests();
  logger.initLogger(dir);
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ok
  }
});

describe("logger", () => {
  it("escreve no arquivo com formato [hora] [nivel][cat] msg | k=v", () => {
    logger.info("tor", "tunel.verificado", { ms: 342, porta: 9060 });

    const conteudo = fs.readFileSync(path.join(dir, "gui.log"), "utf8");
    expect(conteudo).toMatch(
      /\[\d{2}:\d{2}:\d{2}\] \[info\]\[tor\] tunel\.verificado \| ms=342 porta=9060/,
    );
  });

  it("dedupe: linhas repetidas consecutivas colapsam em (xN) no getRecent", () => {
    for (let i = 0; i < 5; i++) logger.error("net", "socks.falha", { motivo: "handshake" });

    const linhas = logger.getRecent().split("\n").filter(Boolean);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toContain("(x5)");
  });

  it("dedupe: rajada que dura varios segundos tambem colapsa, com a hora da ultima", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 28, 12, 0, 0));
      logger.info("app", "contexto.util");
      for (let i = 0; i < 120; i++) {
        logger.error("net", "socks.falha", { motivo: "handshake" });
        vi.advanceTimersByTime(1000);
      }
      logger.info("app", "depois");

      const linhas = logger.getRecent().split("\n").filter(Boolean);
      expect(linhas).toEqual([
        "[12:00:00] [info][app] contexto.util",
        "[12:00:00] [error][net] socks.falha | motivo=handshake (x120, ate 12:01:59)",
        "[12:02:00] [info][app] depois",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ring buffer respeita teto de bytes mantendo o fim", () => {
    for (let i = 0; i < 1200; i++) logger.info("app", `linha-${i}-${"p".repeat(200)}`);

    const recent = logger.getRecent();
    expect(Buffer.byteLength(recent)).toBeLessThanOrEqual(128 * 1024);
    expect(recent).toContain("linha-1199");
  });

  it("rotaciona o arquivo ao passar de 2MB (corta pra metade)", () => {
    const linhaGrande = "x".repeat(1024 * 1024);
    logger.info("app", linhaGrande);
    logger.info("app", linhaGrande);

    const size = fs.statSync(path.join(dir, "gui.log")).size;
    expect(size).toBeLessThan(2 * 1024 * 1024 + 2048);
  });

  it("initLogger sem pasta nao lanca e segue so com ring", () => {
    logger._resetForTests();
    logger.initLogger("/dev/null/caminho-impossivel");
    expect(() => logger.info("app", "sobrevive")).not.toThrow();
    expect(logger.getRecent()).toContain("sobrevive");
  });

  it("gera ids distintos e registra contexto operacional", () => {
    const operationId = logger.createOperationId("activation");
    const attemptId = logger.createOperationId("direct");
    logger.logEvent("info", "wiresock", "process.start", {
      app_session_id: "session-test",
      operation_id: operationId,
      attempt_id: attemptId,
      phase: "process",
      pid: 123,
    });

    const recent = logger.getRecent();
    expect(operationId).toMatch(/^activation-/);
    expect(attemptId).toMatch(/^direct-/);
    expect(recent).toContain("operation_id=" + operationId);
    expect(recent).toContain("phase=process");
  });

  it("redacta campos sensíveis e limita saídas de helper", () => {
    logger.logEvent("info", "proton", "helper.output", {
      password: "s3cr3t",
      token: "abc",
      stdout: "password=still-secret PrivateKey=xyz",
    });
    const recent = logger.getRecent();
    expect(recent).toContain("password=[redacted]");
    expect(recent).toContain("token=[redacted]");
    expect(recent).not.toContain("s3cr3t");
    expect(recent).not.toContain("still-secret");
    expect(logger.clipLogText("123456789", 5)).toBe("12345…");
    expect(logger.redactLogValue("PrivateKey=xyz")).toBe("PrivateKey=[redacted]");
  });

  it("tee de console absorve EIO e preserva no ring sem arquivo", () => {
    logger._resetForTests();
    logger.initLogger("/dev/null/caminho-impossivel");
    const throwsEio = (..._args: unknown[]): never => {
      const error = new Error("broken pipe") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    };
    const alvo = {
      log: throwsEio,
      info: throwsEio,
      warn: (..._args: unknown[]) => {},
      error: (..._args: unknown[]) => {},
    };
    const originalLog = alvo.log;
    const originalInfo = alvo.info;
    const restore = logger.patchConsole(alvo);
    try {
      const secondRestore = logger.patchConsole(alvo);
      secondRestore();
      expect(alvo.info).not.toBe(originalInfo);
      expect(() => alvo.info("mensagem-info")).not.toThrow();
      expect(() => alvo.log("mensagem-log")).not.toThrow();
      expect(logger.getRecent()).toContain("mensagem-info");
      expect(logger.getRecent()).toContain("mensagem-log");
    } finally {
      restore();
    }
    expect(alvo.log).toBe(originalLog);
    expect(alvo.info).toBe(originalInfo);
  });
});
