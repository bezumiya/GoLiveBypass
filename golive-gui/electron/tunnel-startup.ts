/**
 * O serviço/interface WireGuard pode existir antes de o filtro de rede e o
 * primeiro caminho até o peer terminarem de se acomodar. Esta espera é apenas
 * uma janela de estabilização local: não faz probe, não verifica geolocalização
 * e não transforma diagnóstico de rota em condição de ativação.
 */
export const TUNNEL_STARTUP_SETTLE_MS = 2_000;

export type TunnelStartupSleep = (milliseconds: number) => Promise<void>;

export function waitForTunnelStartupSettle(
  sleep: TunnelStartupSleep = (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  return sleep(TUNNEL_STARTUP_SETTLE_MS);
}
