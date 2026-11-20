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
    expect(log).toContain("[10-28 12:00:00] [error][net] socks.falha (x3, ate 12:00:02)");
    expect(log).toContain("=== gui.log (antes do ring buffer) ===\n[11:00:00] [info][app] sessao.anterior");
    // O resumo do topo repete o erro de proposito; a sessao em si nao pode vir duas vezes.
    const corpo = log.slice(log.indexOf("=== sessao GUI (ring buffer) ==="));
    expect(corpo.split("[info][app] depois").length - 1).toBe(1);
    expect(corpo.split("[error][net] socks.falha").length - 1).toBe(1);
  });

  it("log legado grande nao empurra a falha recente da GUI para fora da issue (#379/#399)", () => {
    const dir = logsDir(raiz, process.platform);
    fs.mkdirSync(dir, { recursive: true });
    logger.initLogger(dir);
    // golivebypass.log do runtime legado no INSTALL_DIR, bem maior que a issue inteira.
    const installDir = path.join(raiz, "GoLiveBypass");
    fs.mkdirSync(installDir, { recursive: true });
    const legado = Array.from({ length: 3000 }, (_, i) => `20:26:${String(i % 60).padStart(2, "0")} escolhida socks5://10.0.0.${i % 250}:1080: ${i}ms, saida em US`).join("\n");
    fs.writeFileSync(path.join(installDir, "golivebypass.log"), `${legado}\n`);
    for (let i = 0; i < 900; i++) logger.info("discord", `script.trace | msg=[!] trace: linha de ruido ${i} ${"x".repeat(60)}`);
    logger.error("app", "Error occurred in handler for 'activate': FALHA-RECENTE");

    const log = montarLog(raiz, [], "token-de-teste");
    // Cabe na issue sem o corte cabeca+cauda da API (64KB menos meta e descricao).
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(56 * 1024);
    expect(log.startsWith("=== resumo ===")).toBe(true);
    expect(log).toContain("\n=== sessao GUI (ring buffer) ===\n");
    expect(log).toContain("FALHA-RECENTE");
    // O legado entra so pela cauda: a ultima linha do arquivo, nunca a primeira.
    expect(log).toContain("escolhida socks5://10.0.0.249:1080: 2999ms");
    expect(log).not.toContain("escolhida socks5://10.0.0.0:1080: 0ms");
  });

  it("log legado parado ha mais de um dia fica fora do relato", () => {
    const dir = logsDir(raiz, process.platform);
    fs.mkdirSync(dir, { recursive: true });
    logger.initLogger(dir);
    const installDir = path.join(raiz, "GoLiveBypass");
    fs.mkdirSync(installDir, { recursive: true });
    const arquivo = path.join(installDir, "golivebypass.log");
    fs.writeFileSync(arquivo, "escolhida socks5://10.0.0.1:1080: 12ms, saida em US\n");
    const doisDiasAtras = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(arquivo, doisDiasAtras, doisDiasAtras);
    logger.info("app", "sessao.atual");

    const log = montarLog(raiz, [], "token-de-teste");
    expect(log).toContain("sessao.atual");
    expect(log).not.toContain("golivebypass.log");
    expect(log).not.toContain("socks5://");
  });

  it("resumo sobrevive a uma sessao longa: ativacao, erro da tela e servidor no topo", () => {
    const dir = logsDir(raiz, process.platform);
    fs.mkdirSync(dir, { recursive: true });
    logger.initLogger(dir);
    logger.info("wiresock", "inicio de operacao serializada", { operation: "ativacao" });
    logger.info("proton", "servidor ótimo selecionado com sucesso", { server: "US-FREE#75", ping: 142 });
    logger.error("wiresock", "ativacao.falhou_revertida", { erro: "FALHA-DA-ATIVACAO", rollback: "ok" });
    logger.info("wiresock", "fim de operacao serializada", { operation: "ativacao", resultado: "erro", duracao_ms: 12345 });
    logger.warn("ui", "erro.exibido", { canal: "activate", mensagem: "MENSAGEM-DA-TELA" });
    // Ruido suficiente para o trecho acima sair do orcamento do ring na issue.
    for (let i = 0; i < 900; i++) logger.info("discord", `script.trace | msg=ruido ${i} ${"x".repeat(80)}`);

    const log = montarLog(raiz, [], "token-de-teste");
    const resumo = log.slice(0, log.indexOf("=== sessao GUI (ring buffer) ==="));
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(56 * 1024);
    expect(resumo).toMatch(/\] ativacao erro em 12\.3s/);
    expect(resumo).toContain("FALHA-DA-ATIVACAO");
    expect(resumo).toContain("servidor escolhido: US-FREE#75 (ping 142ms)");
    expect(resumo).toContain("MENSAGEM-DA-TELA");
    expect(resumo).toMatch(/relato enviado em \d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });
});
