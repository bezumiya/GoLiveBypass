import { describe, expect, it } from "vitest";
import { LOG_ISSUE_MAX, montarLog } from "../../goLiveBypass/bug-report";
import { carimbo, createPluginLogger, formatarLinhaDoArquivo, montarResumoDoPlugin } from "../../goLiveBypass/plugin-log";

describe("resumo do relatorio do plugin", () => {
  it("data no formato dd/mm/aaaa - hh:mm:ss, no horario local", () => {
    expect(carimbo(new Date(2026, 10, 15, 23, 0, 7))).toBe("15/11/2026 - 23:00:07");
    expect(carimbo(new Date(2026, 0, 2, 3, 4, 5).toISOString())).toBe("02/01/2026 - 03:04:05");
  });

  it("ativacao e relaunch ficam no topo mesmo quando o ring as descartou do corpo", () => {
    let agora = Date.UTC(2026, 10, 15, 23, 0, 0);
    const logger = createPluginLogger({ component: "plugin.native", now: () => new Date(agora += 1000) });
    logger.info("plugin.process.started");
    logger.info("operation.vpn-activation.started", { operation_id: "vpn-activation-a1" });
    logger.info("linux.network.ready", { operation_id: "vpn-activation-a1", phase: "active" });
    logger.info("relaunch.accepted", { operation_id: "vpn-activation-a1" }, { namespace: "glb-1" }, "comando de relaunch no namespace aceito com sucesso; encerrando processo atual");
    logger.info("plugin.process.started");
    logger.warn("relaunch.cliente_nao_subiu", {}, { namespace: "glb-1" });
    logger.error("operation.vpn-activation.failed", { operation_id: "vpn-activation-b2" }, { duration_ms: 4321, error: "ERRO-DA-TELA" });
    // Sessao longa depois: o ring do relato so leva o fim.
    for (let i = 0; i < 380; i++) logger.info("route.diagnostic", {}, { reason: `rota ${i} sem resposta no momento `.repeat(8) });

    // O ring ja descartou o comeco da sessao (o caso do relato que motivou o resumo).
    expect(logger.records().some(r => r.event === "linux.network.ready")).toBe(false);
    const resumo = montarResumoDoPlugin(logger.milestones(), new Date(agora));
    expect(resumo.startsWith(`=== resumo ===\nrelato enviado em ${carimbo(new Date(agora))}\n`)).toBe(true);
    expect(resumo).toMatch(/vpn-activation falhou em 4\.3s — ERRO-DA-TELA/);
    expect(resumo).toContain("linux.network.ready");
    expect(resumo).toContain("relaunch no namespace aceito");
    expect(resumo).toContain("relaunch.cliente_nao_subiu");
    expect(resumo).toContain(`aberturas do plugin: ${carimbo(new Date(Date.UTC(2026, 10, 15, 23, 0, 1)))}, ${carimbo(new Date(Date.UTC(2026, 10, 15, 23, 0, 5)))}`);
    expect(Buffer.byteLength(resumo, "utf8")).toBeLessThanOrEqual(4 * 1024 + 32);

    const log = montarLog({ ring: logger.getLog(), caudaArquivo: "", sessao: "", segredos: [], token: "token", resumo });
    expect(log.startsWith("=== resumo ===")).toBe(true);
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(LOG_ISSUE_MAX + 1024);
    // O corpo perdeu o comeco da sessao; o resumo nao.
    const corpo = log.slice(log.indexOf("=== plugin (memoria) ==="));
    expect(corpo).not.toContain("ERRO-DA-TELA");
    expect(log).toContain("ERRO-DA-TELA");
  });

  it("servidor escolhido pela busca entra no resumo mesmo com o ring cheio", () => {
    let agora = Date.UTC(2026, 10, 15, 23, 0, 0);
    const logger = createPluginLogger({ component: "plugin.native", now: () => new Date(agora += 1000) });
    logger.info("helper.completed", {}, { exit_code: 0, json: true });
    logger.info("helper.completed", {}, { exit_code: 0, json: true, server: "CA-FREE#19", ping_ms: 42, download_mbps: 31.5 });
    for (let i = 0; i < 420; i++) logger.info("route.diagnostic", {}, { reason: `rota ${i}` });
    expect(logger.records().some(r => r.event === "helper.completed")).toBe(false);
    expect(montarResumoDoPlugin(logger.milestones(), new Date(agora))).toContain("servidor escolhido: CA-FREE#19 (ping 42ms) em ");
  });

  it("aviso deduplicado aparece uma vez, com o horario da ultima ocorrencia e sem count duplicado", () => {
    let agora = Date.UTC(2026, 10, 15, 23, 0, 0);
    const logger = createPluginLogger({ component: "plugin.native", now: () => new Date(agora += 1000) });
    logger.warn("route.probe.failed", {}, { reason: "sem resposta" });
    logger.warn("route.probe.failed", {}, { reason: "sem resposta" });
    const linha = montarResumoDoPlugin(logger.milestones(), new Date(agora)).split("\n").find(l => l.includes("route.probe.failed")) ?? "";
    expect(linha).toContain("[2x no log]");
    expect(linha).not.toContain("count=");
    expect(linha).toContain(`[${carimbo(new Date(Date.UTC(2026, 10, 15, 23, 0, 2)))}]`);
  });

  it("aviso em excesso nao expulsa ativacao, relaunch e operacao do resumo", () => {
    let agora = Date.UTC(2026, 10, 15, 23, 0, 0);
    const logger = createPluginLogger({ component: "plugin.native", now: () => new Date(agora += 1000), maxEvents: 20 });
    logger.info("plugin.process.started");
    logger.info("operation.vpn-activation.started", { operation_id: "vpn-activation-a1" });
    logger.info("linux.network.ready", { operation_id: "vpn-activation-a1", phase: "active" });
    logger.info("relaunch.accepted", { operation_id: "vpn-activation-a1" }, { namespace: "glb-1" }, "relaunch no namespace aceito");
    logger.info("operation.vpn-activation.completed", { operation_id: "vpn-activation-a1" }, { duration_ms: 1200 });
    for (let i = 0; i < 200; i++) logger.warn("route.probe.failed", { stage: String(i) }, { erro: `falha ${i}` });

    // O ring pequeno perdeu a ativacao; a fila de estado do resumo nao.
    expect(logger.records().some(r => r.event === "linux.network.ready")).toBe(false);
    const resumo = montarResumoDoPlugin(logger.milestones(), new Date(agora));
    expect(resumo).toContain("linux.network.ready");
    expect(resumo).toContain("relaunch no namespace aceito");
    expect(resumo).toMatch(/vpn-activation ok em 1\.2s/);
    expect(resumo).toContain("aberturas do plugin: ");
    expect(resumo).toContain("route.probe.failed");
  });

  it("ring sem operacao nem aviso diz isso em vez de vir vazio", () => {
    expect(montarResumoDoPlugin([], new Date(2026, 0, 2, 3, 4, 5))).toBe(
      "=== resumo ===\nrelato enviado em 02/01/2026 - 03:04:05\n(nenhuma operacao, aviso ou erro no log)",
    );
  });
});

describe("log do relatorio do plugin", () => {
  it("cabe na issue e preserva o fim do ring quando o plugin-vpn.log antigo e grande", () => {
    const antigo = Array.from({ length: 4000 }, (_, i) => `00:${String(i % 60).padStart(2, "0")}:00.000 [info] [plugin.native] antigo ${i} ${"y".repeat(40)}`);
    const ring = Array.from({ length: 1500 }, (_, i) => `01:00:${String(i % 60).padStart(2, "0")}.000 [info] [plugin.native] helper.progress_sampled ${i} ${"z".repeat(60)}`);
    ring.push("01:59:59.000 [error] [plugin.native] operation.vpn-activation.failed | error=FALHA-RECENTE");
    // A cauda do arquivo contem o ring inteiro depois das linhas antigas.
    const log = montarLog({
      ring: ring.join("\n"),
      caudaArquivo: [...antigo, ...ring].join("\n"),
      sessao: "GoLiveBypass, diagnostico",
      segredos: [],
      token: "token",
    });
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(LOG_ISSUE_MAX + 1024);
    expect(log).toContain("FALHA-RECENTE");
    expect(log).toContain("=== plugin-vpn.log (antes do ring) ===");
    expect(log).toContain("antigo 3999");
    expect(log).not.toContain("antigo 0 ");
  });

  it("cauda JSONL do arquivo vira o mesmo texto do ring e entra antes dele", () => {
    const registro = (event: string, ts: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      schema_version: 1, ts, level: "info", component: "plugin.native", event, count: 1, first_ts: ts, last_ts: ts, ...extra,
    });
    const antigo = registro("plugin.process.started", "2026-11-14T23:00:00.000Z");
    const atual = registro("operation.vpn-activation.started", "2026-11-15T23:00:00.000Z", { operation_id: "vpn-activation-a1" });
    const ring = formatarLinhaDoArquivo(atual);
    expect(ring).toContain("operation.vpn-activation.started");

    // O arquivo é JSONL; sem converter, a primeira linha do ring não seria encontrada e a cauda
    // anterior a ele seria descartada por complementoDaCauda.
    const cauda = [antigo, atual].map(formatarLinhaDoArquivo).join("\n");
    const log = montarLog({ ring, caudaArquivo: cauda, sessao: "", segredos: [], token: "token" });
    expect(log).toContain("=== plugin-vpn.log (antes do ring) ===");
    expect(log).toContain("plugin.process.started");
  });
});
