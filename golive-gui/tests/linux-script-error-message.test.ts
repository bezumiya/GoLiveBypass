import { describe, expect, it } from "vitest";
import { stripAnsiCodes, tailErroScript } from "../electron/script-stderr";

// O que se prova aqui e o que a UI mostra quando o script Linux falha, porque e essa
// string que vai para o usuario e para o relato de bug.

describe("mensagem de erro do script Linux", () => {
  it("nao come os prefixos literais [*], [OK] e [!] do script", () => {
    // O standalone colore com ANSI e o ESC as vezes chega como U+FFFD; o filtro
    // precisa remover so a sequencia real, sem engolir o texto entre colchetes.
    expect(stripAnsiCodes("  [*] Removendo namespace de rede")).toBe("  [*] Removendo namespace de rede");
    expect(stripAnsiCodes("  [OK] Tunel WireGuard encerrado.")).toBe("  [OK] Tunel WireGuard encerrado.");
    expect(stripAnsiCodes("  [!] sem privilegio")).toBe("  [!] sem privilegio");
    expect(stripAnsiCodes("\u001b[36m  [OK] ok\u001b[0m")).toBe("  [OK] ok");
    expect(stripAnsiCodes("�[36m  [X] falhou")).toBe("  [X] falhou");
  });

  it("mostra a causa real em vez dos passos informativos do teardown", () => {
    const stderr = [
      "\u001b[2m  [*]\u001b[0m Removendo namespace de rede 'discord-vpn' e interface WireGuard",
      "\u001b[32m  [OK]\u001b[0m Tunel WireGuard encerrado.",
      "\u001b[31m  [X]\u001b[0m Discord nao iniciou dentro do namespace WireGuard. Verifique o log em /home/u/.local/share/GoLiveBypass/logs.",
    ].join("\n");
    expect(tailErroScript(stderr, 3)).toBe(
      "[X] Discord nao iniciou dentro do namespace WireGuard. Verifique o log em /home/u/.local/share/GoLiveBypass/logs.",
    );
  });

  it("mantem a causa na frente quando o rollback do trap escreve depois dela (#422)", () => {
    // Ordem real: fail() imprime o [X] e sai; o trap reabre o Discord fora do tunel e
    // as linhas dele vinham por ultimo, deixando so "Rollback: ..." na janela de erro.
    const stderr = [
      "  [!] O WireGuard ficou pronto, mas o processo do Discord nao iniciou.",
      "\u001b[31m  [X]\u001b[0m Discord nao iniciou dentro do namespace WireGuard: abra o Discord fora do bypass para ver o erro; saida do launcher: GPU process isn't usable. Goodbye.; log: /home/u/.local/share/GoLiveBypass/logs/discord-vpn-1.log.",
      "  [!] Rollback: bypass nao ativado; reabrindo o Discord sem o namespace WireGuard.",
      "  Backend grafico: wayland | Wayland=wayland-1 | portal=ausente",
      "  Log do Discord: /home/u/.local/share/GoLiveBypass/logs/discord-vpn-2.log",
      "  [!] Rollback: Discord reaberto sem bypass; a ativacao falhou e precisa ser repetida.",
    ].join("\n");
    const mensagem = tailErroScript(stderr, 3).split("\n");
    expect(mensagem).toHaveLength(3);
    expect(mensagem[0]).toMatch(/^\[X\] Discord nao iniciou dentro do namespace WireGuard: .*GPU process isn't usable/);
    expect(mensagem[2]).toBe("[!] Rollback: Discord reaberto sem bypass; a ativacao falhou e precisa ser repetida.");
  });

  it("sem [X] continua devolvendo apenas o fim do stderr", () => {
    const stderr = ["[*] Configurando interface WireGuard 'wg-discord' no namespace 'discord-vpn'", "fopen: Permission denied", "[!] Rollback: removendo o namespace WireGuard incompleto."].join("\n");
    expect(tailErroScript(stderr, 2)).toBe("fopen: Permission denied\n[!] Rollback: removendo o namespace WireGuard incompleto.");
  });
});
