import { describe, expect, it } from "vitest";
import { descreverFalhaDaTela, montarResumo } from "../electron/relato-resumo";

describe("montarResumo", () => {
  it("le linhas do formato antigo (so hora) e do novo, e marca operacao sem fim", () => {
    const log = [
      "[11:00:00] [info][wiresock] inicio de operacao serializada | operation=desativacao",
      "[11:00:03] [info][wiresock] fim de operacao serializada | operation=desativacao",
      "[19/11/2026 - 12:00:00] [info][wiresock] inicio de operacao serializada | operation=ativacao",
    ].join("\n");
    const resumo = montarResumo(log, "19/11/2026 - 12:05:00");
    expect(resumo).toContain("relato enviado em 19/11/2026 - 12:05:00");
    expect(resumo).toContain("  [11:00:03] desativacao\n");
    expect(resumo).toContain("  [19/11/2026 - 12:00:00] ativacao em andamento");
  });

  it("agrupa avisos repetidos pelo evento e mostra o mais recente", () => {
    const log = [
      "[19/11/2026 - 12:00:00] [warn][proton] falha na autenticação ProtonVPN | codigo_saida=1 erro=A",
      "[19/11/2026 - 12:01:00] [warn][proton] falha na autenticação ProtonVPN | codigo_saida=1 erro=B",
      "[19/11/2026 - 12:02:00] [warn][wg] handshake.velho | handshake_ha_s=400 (x3, ate 12:04:00)",
    ].join("\n");
    const resumo = montarResumo(log, "19/11/2026 - 12:05:00");
    expect(resumo).toContain("erro=B [2x no log]");
    expect(resumo).not.toContain("erro=A");
    expect(resumo).toContain("handshake.velho");
  });

  it("erro da tela fica so na secao dele e o erro do handler agrupa pelo canal", () => {
    const log = [1, 2, 3, 4, 5, 6].flatMap((i) => [
      `[15/11/2026 - 22:4${i}:00] [warn][ui] erro.exibido | canal=activate mensagem=Falha ${i}`,
      `[15/11/2026 - 22:4${i}:00] [error][app] Error occurred in handler for 'activate': Error: Falha ${i}`,
    ]).join("\n");
    const resumo = montarResumo(log, "15/11/2026 - 23:00:00");
    const avisos = resumo.slice(resumo.indexOf("avisos e erros"));
    expect(avisos).not.toContain("erro.exibido");
    expect(avisos.match(/Error occurred in handler/g)).toHaveLength(1);
    expect(avisos).toContain("Falha 6 [6x no log]");
  });

  it("sem nada relevante diz isso e respeita o teto", () => {
    expect(montarResumo("[19/11/2026 - 12:00:00] [info][app] iniciado", "19/11/2026 - 12:00:01")).toContain("(nenhuma operacao, aviso ou erro no log)");
    const muitos = Array.from({ length: 500 }, (_, i) => `[19/11/2026 - 12:00:00] [warn][x${i}] evento.${i} | ${"detalhe ".repeat(40)}`).join("\n");
    expect(Buffer.byteLength(montarResumo(muitos, "19/11/2026 - 12:00:01"), "utf8")).toBeLessThanOrEqual(4 * 1024 + 32);
  });
});

describe("descreverFalhaDaTela", () => {
  it("le a mensagem de { success: false } e de excecao, e ignora sucesso", () => {
    expect(descreverFalhaDaTela({ success: false, code: "CAPTCHA_INVALID", message: "A verificação expirou." }))
      .toEqual({ codigo: "CAPTCHA_INVALID", mensagem: "A verificação expirou." });
    expect(descreverFalhaDaTela(new Error("Falha ao ativar"))).toEqual({ mensagem: "Falha ao ativar" });
    expect(descreverFalhaDaTela({ success: true, message: "ok" })).toBeNull();
    expect(descreverFalhaDaTela({ success: false })).toBeNull();
    expect(descreverFalhaDaTela(undefined)).toBeNull();
  });
});
