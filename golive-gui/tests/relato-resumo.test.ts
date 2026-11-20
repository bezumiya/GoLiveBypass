import { describe, expect, it } from "vitest";
import { descreverFalhaDaTela, montarResumo } from "../electron/relato-resumo";

describe("montarResumo", () => {
  it("le linhas do formato antigo e do novo, e marca operacao sem fim", () => {
    const log = [
      "[11:00:00] [info][wiresock] inicio de operacao serializada | operation=desativacao",
      "[11:00:03] [info][wiresock] fim de operacao serializada | operation=desativacao",
      "[11-19 12:00:00] [info][wiresock] inicio de operacao serializada | operation=ativacao",
    ].join("\n");
    const resumo = montarResumo(log, "11-19 12:05:00");
    expect(resumo).toContain("relato enviado em 11-19 12:05:00");
    expect(resumo).toContain("  [11:00:03] desativacao\n");
    expect(resumo).toContain("  [11-19 12:00:00] ativacao em andamento");
  });

  it("agrupa avisos repetidos pelo evento e mostra o mais recente", () => {
    const log = [
      "[11-19 12:00:00] [warn][proton] falha na autenticação ProtonVPN | codigo_saida=1 erro=A",
      "[11-19 12:01:00] [warn][proton] falha na autenticação ProtonVPN | codigo_saida=1 erro=B",
      "[11-19 12:02:00] [warn][wg] handshake.velho | handshake_ha_s=400 (x3, ate 12:04:00)",
    ].join("\n");
    const resumo = montarResumo(log, "11-19 12:05:00");
    expect(resumo).toContain("erro=B [2x no log]");
    expect(resumo).not.toContain("erro=A");
    expect(resumo).toContain("handshake.velho");
  });

  it("sem nada relevante diz isso e respeita o teto", () => {
    expect(montarResumo("[11-19 12:00:00] [info][app] iniciado", "11-19 12:00:01")).toContain("(nenhuma operacao, aviso ou erro no log)");
    const muitos = Array.from({ length: 500 }, (_, i) => `[11-19 12:00:00] [warn][x${i}] evento.${i} | ${"detalhe ".repeat(40)}`).join("\n");
    expect(Buffer.byteLength(montarResumo(muitos, "11-19 12:00:01"), "utf8")).toBeLessThanOrEqual(4 * 1024 + 32);
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
