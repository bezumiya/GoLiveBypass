export type LinuxHealthSnapshot = {
  netns: boolean;
  discordInNamespace: boolean;
  wg: { ok: boolean; handshakeAgoS: number | null; rxBytes: number | null; txBytes: number | null };
  probeReady: boolean;
};

export function classifyLinuxHealth(snapshot: LinuxHealthSnapshot): { healthy: boolean; reason: string } {
  if (!snapshot.netns) return { healthy: false, reason: "namespace WireGuard ausente" };
  if (!snapshot.discordInNamespace) return { healthy: false, reason: "Discord não está dentro do namespace WireGuard" };
  if (!snapshot.wg.ok) {
    // Ler o handshake do `wg` exige root; o probe do gateway ja foi coletado sem pedir
    // senha (sudo -n) e diz se ha caminho ate o Discord. Sem separar os dois, um tunel
    // morto e um sudo indisponivel viram a mesma linha de log.
    return {
      healthy: false,
      reason: snapshot.probeReady
        ? "telemetria WireGuard indisponível (gateway Discord acessível pelo túnel)"
        : "gateway Discord inacessível pelo túnel (telemetria WireGuard indisponível)",
    };
  }
  if (snapshot.wg.handshakeAgoS === null) return { healthy: false, reason: "handshake WireGuard ausente" };
  if (snapshot.wg.handshakeAgoS > 180) return { healthy: false, reason: `handshake WireGuard antigo (${snapshot.wg.handshakeAgoS}s)` };
  if (snapshot.wg.rxBytes === null || snapshot.wg.txBytes === null || snapshot.wg.rxBytes <= 0 || snapshot.wg.txBytes <= 0) {
    return { healthy: false, reason: "tráfego WireGuard bidirecional ausente" };
  }
  if (!snapshot.probeReady) return { healthy: false, reason: "gateway Discord inacessível pelo túnel" };
  return { healthy: true, reason: "túnel e tráfego confirmados" };
}
