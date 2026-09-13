// O relato de bug precisa levar a prova de rota do Linux: o
// `wireguard_gateway_probe` grava handshake + HTTP code em
// <INSTALL_DIR>/logs/wireguard-diagnostics.log, e essa e a unica evidencia que
// sobrevive quando `wg` exige root (a telemetria da GUI fica "indisponivel").
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => state.root,
    getVersion: () => "2.0.6-beta-14",
    getLocale: () => "pt-BR",
    isPackaged: false,
  },
}));

import { montarLog } from "../electron/bugreport";

const SEGREDO = "protonusuario987654";
const PROBE =
  '2026-09-13T18:40:20-03:00 route.diagnostic mode=log-only {"ready":false,"state":"gateway_unreachable","httpCode":"000"}';

let xdgAnterior: string | undefined;
let localAnterior: string | undefined;

/** Cria a raiz de dados com o INSTALL_DIR que o report consulta. */
function cenario(): { dadosRaiz: string; installDir: string } {
  const dadosRaiz = fs.mkdtempSync(path.join(os.tmpdir(), "golive-report-"));
  process.env.XDG_DATA_HOME = path.join(dadosRaiz, "share");
  process.env.LOCALAPPDATA = path.join(dadosRaiz, "local");
  state.root = dadosRaiz;
  const installDir = process.platform === "win32"
    ? path.join(dadosRaiz, "local", "GoLiveBypass")
    : path.join(dadosRaiz, "share", "GoLiveBypass");
  fs.mkdirSync(path.join(installDir, "logs"), { recursive: true });
  return { dadosRaiz, installDir };
}

describe("pacote de logs do relato de bug", () => {
  beforeEach(() => {
    xdgAnterior = process.env.XDG_DATA_HOME;
    localAnterior = process.env.LOCALAPPDATA;
  });

  afterEach(() => {
    if (xdgAnterior === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = xdgAnterior;
    if (localAnterior === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = localAnterior;
  });

  it("inclui o diagnóstico de rota e passa o bloco novo pela redação existente", () => {
    const { dadosRaiz, installDir } = cenario();
    fs.writeFileSync(
      path.join(installDir, "logs", "wireguard-diagnostics.log"),
      `${PROBE}\n2026-09-13T18:41:20-03:00 contador=${SEGREDO}\n`,
      "utf8",
    );

    const saida = montarLog(dadosRaiz, [SEGREDO, dadosRaiz], "token-de-teste");

    expect(saida).toContain("=== wireguard-diagnostics.log (INSTALL_DIR) ===");
    expect(saida).toContain("gateway_unreachable");
    expect(saida).not.toContain(SEGREDO);
    fs.rmSync(dadosRaiz, { recursive: true, force: true });
  });

  it("sem o arquivo de diagnóstico não cria bloco vazio", () => {
    const { dadosRaiz } = cenario();

    const saida = montarLog(dadosRaiz, [dadosRaiz], "token-de-teste");

    expect(saida).not.toContain("wireguard-diagnostics.log");
    fs.rmSync(dadosRaiz, { recursive: true, force: true });
  });
});
