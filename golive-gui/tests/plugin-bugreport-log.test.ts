import { describe, expect, it } from "vitest";
import { LOG_ISSUE_MAX, montarLog } from "../../goLiveBypass/bug-report";
import { carimbo, createPluginLogger, montarResumoDoPlugin } from "../../goLiveBypass/plugin-log";

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
});
