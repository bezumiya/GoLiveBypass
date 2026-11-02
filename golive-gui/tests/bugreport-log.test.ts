import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("electron", () => ({ app: { getVersion: () => "0.0.0", getLocale: () => "pt-BR", getPath: () => os.tmpdir() } }));

import * as logger from "../electron/logger";
import { logsDir } from "../electron/logsDir";
import { montarLog } from "../electron/bugreport";

let raiz: string;
const envAntes = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_DATA_HOME: process.env.XDG_DATA_HOME };

beforeEach(() => {
  raiz = fs.mkdtempSync(path.join(os.tmpdir(), "golive-bugreport-log-"));
  // Hermetico nas duas plataformas: nada de ler o %LOCALAPPDATA% real.
  process.env.LOCALAPPDATA = raiz;
  process.env.XDG_DATA_HOME = raiz;
  logger._resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
  logger._resetForTests();
  for (const [k, v] of Object.entries(envAntes)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(raiz, { recursive: true, force: true });
});

describe("montarLog", () => {
  it("ring que comeca por uma linha repetida nao duplica a sessao do gui.log", () => {
    const dir = logsDir(raiz, process.platform);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "gui.log"), "[11:00:00] [info][app] sessao.anterior\n");
    logger.initLogger(dir);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 28, 12, 0, 0));
    for (let i = 0; i < 3; i++) {
      logger.error("net", "socks.falha");
      vi.advanceTimersByTime(1000);
    }
    logger.info("app", "depois");

    const log = montarLog(raiz, [], "token-de-teste");
    expect(log).toContain("[12:00:00] [error][net] socks.falha (x3, ate 12:00:02)");
    expect(log).toContain("=== gui.log (antes do ring buffer) ===\n[11:00:00] [info][app] sessao.anterior");
    expect(log.split("[info][app] depois").length - 1).toBe(1);
    expect(log.split("[error][net] socks.falha").length - 1).toBe(1);
  });
});
