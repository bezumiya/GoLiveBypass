import type { WgConfig } from '../../shared/types';

/**
 * Ranges Cloudflare usados pelo Discord (gateway, API e voz *.discord.media).
 * Split tunnel: só esse tráfego passa pela VPN; outros apps (ex.: Sonobus)
 * continuam na conexão direta do usuário.
 */
export const DISCORD_ALLOWED_IPS = '162.159.0.0/16, 104.16.0.0/12';

/** Ranges IPv6 da Cloudflare rejeitados com o túnel ativo, para o Discord cair no IPv4 tunelado. */
export const DISCORD_REJECT_V6 = ['2606:4700::/32', '2a06:98c0::/29'];

const CANONICAL_KEYS: Record<string, string> = {
  privatekey: 'PrivateKey', address: 'Address', listenport: 'ListenPort', mtu: 'MTU',
  publickey: 'PublicKey', presharedkey: 'PresharedKey', endpoint: 'Endpoint',
  persistentkeepalive: 'PersistentKeepalive',
};

/**
 * Mantém só as chaves que o helper aceita, com a capitalização canônica, e
 * troca o AllowedIPs pelos ranges do Discord. DNS e hooks (PostUp etc.) saem:
 * o helper os descartaria de qualquer forma.
 */
function normalize(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = CANONICAL_KEYS[line.slice(0, i).trim().toLowerCase()];
    if (key) out.push(`${key} = ${line.slice(i + 1).trim()}`);
  }
  return out;
}

/**
 * Sem keepalive o handshake só sai com tráfego para os ranges do Discord, e o
 * helper desiste em 15 s se o Discord estiver fechado.
 */
export const DEFAULT_KEEPALIVE = 25;

export function rewriteForSplitTunnel(c: WgConfig): string {
  const peer = normalize(c.peerLines);
  if (!peer.some(l => l.startsWith('PersistentKeepalive ='))) peer.push(`PersistentKeepalive = ${DEFAULT_KEEPALIVE}`);
  return [
    '[Interface]', ...normalize(c.interfaceLines), '',
    '[Peer]', ...peer, `AllowedIPs = ${DISCORD_ALLOWED_IPS}`, '',
  ].join('\n');
}
