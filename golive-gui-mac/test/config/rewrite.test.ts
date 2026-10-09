import { describe, it, expect } from 'vitest';
import { parseWgConfig } from '../../src/main/config/parse';
import { rewriteForSplitTunnel } from '../../src/main/config/rewrite';

describe('rewriteForSplitTunnel', () => {
  it('restringe AllowedIPs aos ranges do Discord e tira DNS e hooks', () => {
    const text = rewriteForSplitTunnel(parseWgConfig(
      '[Interface]\nPrivateKey = a\nAddress = 10.0.0.2/32\nDNS = 10.2.0.1\nPostUp = touch /tmp/x\n' +
      '[Peer]\nPublicKey = b\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0, ::/0',
    ));
    expect(text).toContain('AllowedIPs = 162.159.0.0/16, 104.16.0.0/12');
    expect(text).not.toMatch(/0\.0\.0\.0\/0|::\/0|DNS|PostUp/);
  });

  it('põe PersistentKeepalive quando o conf não tem', () => {
    const text = rewriteForSplitTunnel(parseWgConfig('[Interface]\nPrivateKey = a\n[Peer]\nPublicKey = b\nEndpoint = 1.2.3.4:51820'));
    expect(text).toContain('PersistentKeepalive = 25');
  });

  it('normaliza a capitalização das chaves', () => {
    const text = rewriteForSplitTunnel(parseWgConfig(
      '[interface]\nprivatekey = a\naddress=10.0.0.2/32\n[peer]\npublickey = b\nendpoint=1.2.3.4:51820\npersistentkeepalive = 25',
    ));
    expect(text).toBe([
      '[Interface]', 'PrivateKey = a', 'Address = 10.0.0.2/32', '',
      '[Peer]', 'PublicKey = b', 'Endpoint = 1.2.3.4:51820', 'PersistentKeepalive = 25',
      'AllowedIPs = 162.159.0.0/16, 104.16.0.0/12', '',
    ].join('\n'));
  });
});
