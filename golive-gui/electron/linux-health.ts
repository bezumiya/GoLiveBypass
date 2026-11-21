export type LinuxHealthSnapshot = {
  netns: boolean;
  discordInNamespace: boolean;
  wg: { ok: boolean; handshakeAgoS: number | null; rxBytes: number | null; txBytes: number | null };
  probeReady: boolean;
};

export function classifyLinuxHealth(snapshot: LinuxHealthSnapshot): { healthy: boolean; reason: string } {
  if (!snapshot.netns) return { healthy: false, reason: "namespace WireGuard ausente" };
  if (!snapshot.discordInNamespace) return { healthy: false, reason: "Discord não está dentro do namespace WireGuard" };
  if (!snapshot.wg.ok) return { healthy: false, reason: "telemetria WireGuard indisponível" };
  if (snapshot.wg.handshakeAgoS === null) return { healthy: false, reason: "handshake WireGuard ausente" };
  if (snapshot.wg.handshakeAgoS > 180) return { healthy: false, reason: `handshake WireGuard antigo (${snapshot.wg.handshakeAgoS}s)` };
  if (snapshot.wg.rxBytes === null || snapshot.wg.txBytes === null || snapshot.wg.rxBytes <= 0 || snapshot.wg.txBytes <= 0) {
    return { healthy: false, reason: "tráfego WireGuard bidirecional ausente" };
  }
  if (!snapshot.probeReady) return { healthy: false, reason: "gateway Discord inacessível pelo túnel" };
  return { healthy: true, reason: "túnel e tráfego confirmados" };
}

/**
 * Limita o que o watchdog de 15 s grava no log. A primeira falha entra, a troca de motivo entra
 * na hora e o mesmo motivo volta depois de `intervaloMs`; a volta ao normal só entra se um aviso
 * chegou a ser registrado. O motivo e o instante do último registro NÃO são zerados pela leitura
 * saudável: com o túnel alternando falha/sucesso a cada rodada, zerar faria cada falha parecer
 * nova e o relato voltaria a encher de `tunel.diagnostico` + `tunel.diagnostico.normal`.
 */
export function criarRegistroDeDiagnostico(opcoes: { intervaloMs?: number; agora?: () => number } = {}) {
  const intervaloMs = opcoes.intervaloMs ?? 5 * 60_000;
  const agora = opcoes.agora ?? Date.now;
  let falhas = 0;
  let ultimoMotivo: string | null = null;
  let ultimoRegistroMs = Number.NEGATIVE_INFINITY;
  let avisoRegistrado = false;
  return {
    /** Falha observada: devolve o aviso a registrar, ou null quando suprimida. */
    falhou(motivo: string): { falhas: number } | null {
      falhas += 1;
      const instante = agora();
      if (motivo === ultimoMotivo && instante - ultimoRegistroMs < intervaloMs) return null;
      ultimoMotivo = motivo;
      ultimoRegistroMs = instante;
      avisoRegistrado = true;
      return { falhas };
    },
    /** Leitura saudável: devolve a volta ao normal a registrar, ou null se nenhum aviso entrou. */
    saudavel(): { falhasAntes: number } | null {
      const falhasAntes = falhas;
      falhas = 0;
      if (!avisoRegistrado) return null;
      avisoRegistrado = false;
      return { falhasAntes };
    },
    reiniciar(): void {
      falhas = 0;
      ultimoMotivo = null;
      ultimoRegistroMs = Number.NEGATIVE_INFINITY;
      avisoRegistrado = false;
    },
  };
}
