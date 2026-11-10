// Extraído de main.ts para ser testável sem carregar o processo principal.
// As ultimas linhas do stderr do script viram a mensagem de erro na UI. O ruido imutavel de
// distro imutavel (Bluefin/Bazzite preenchem LD_PRELOAD da sessao: "ERROR: ld.so: object ...
// cannot be preloaded" em cada filho) ocupava o fim do stderr e escondia o erro de verdade
// (issue #108) -- filtrado aqui antes de qualquer tail.
// O standalone colore o stderr com ANSI. Em algumas sessões Wayland/Flatpak o
// byte ESC chega ao Electron como U+FFFD, deixando sequências literais como
// "�[36m" na mensagem. Removemos os dois formatos antes de mostrar o erro.
export function stripAnsiCodes(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/(?:\x1b|\u009b|\uFFFD)\[[0-?]*[ -/]*[@-~]/g, "");
}

export function tailErroScript(stderr: string, linhas: number): string {
  const uteis = stripAnsiCodes(stderr)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^ERROR: ld\.so:/.test(l))
    // Passos informativos do teardown ocupavam as ultimas linhas e viravam a
    // mensagem de erro da UI, escondendo o "[X] ..." que explica a falha.
    .filter((l) => !/^\[\*\]\s*Removendo namespace de rede/i.test(l))
    .filter((l) => !/^\[OK\]\s*Tunel WireGuard encerrado/i.test(l));
  const fim = uteis.slice(-linhas);
  // O rollback roda no trap de saida, DEPOIS do "[X] ...": as linhas dele (reabertura,
  // log do Discord, backend grafico) empurravam a causa para fora do tail e a UI so
  // mostrava "Rollback: ..." (#405/#421/#422). A causa vai na frente quando ficou de fora.
  const causa = [...uteis].reverse().find((l) => /^\[X\]\s/.test(l));
  if (causa && !fim.includes(causa)) return [causa, ...fim.slice(-(linhas - 1))].join("\n");
  return fim.join("\n");
}
