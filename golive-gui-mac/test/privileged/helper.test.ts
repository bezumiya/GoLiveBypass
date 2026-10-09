import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { helperScript, sudoersContent, binsHash, HELPER_BINS } from '../../src/main/privileged/helper';

describe('helperScript', () => {
  const s = helperScript();

  it('é bash válido', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glb-')), 'helper');
    fs.writeFileSync(f, s);
    expect(() => execFileSync('bash', ['-n', f])).not.toThrow();
  });

  it('não mexe no IPv6 do sistema inteiro', () => {
    expect(s).not.toContain('setv6off');
    expect(s).not.toContain('-alias');
  });

  const runSanitizer = (conf: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-'));
    const src = path.join(dir, 'in.conf');
    fs.writeFileSync(src, conf);
    const awk = s.match(/awk -v allowed='([^']+)' '([\s\S]+?)' "\$src"/);
    expect(awk).not.toBeNull();
    return execFileSync('awk', ['-v', `allowed=${awk![1]}`, awk![2], src], { encoding: 'utf8' });
  };

  it('sanitize aceita chaves em qualquer capitalização e com CRLF', () => {
    const out = runSanitizer('[interface]\r\nprivatekey=k\r\nAddress = 10.2.0.2/32\r\n[PEER]\r\npublickey = p\r\nENDPOINT= 1.2.3.4:51820\r\n');
    expect(out).toBe([
      '[Interface]', 'PrivateKey = k', 'Address = 10.2.0.2/32',
      '[Peer]', 'AllowedIPs = 162.159.0.0/16, 104.16.0.0/12', 'PublicKey = p', 'Endpoint = 1.2.3.4:51820', '',
    ].join('\n'));
  });

  it('o hash dos binários entra no script', () => {
    expect(helperScript('abc123')).toContain('# bins: abc123');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-b-'));
    for (const b of HELPER_BINS) fs.writeFileSync(path.join(dir, b), b);
    const h1 = binsHash(dir);
    fs.writeFileSync(path.join(dir, 'wg-quick'), 'mudou');
    expect(binsHash(dir)).not.toBe(h1);
  });

  it('sudoers libera up/down para o grupo admin, sem coringas', () => {
    expect(sudoersContent()).toMatch(/^%admin ALL=\(root\) NOPASSWD: \/Library\/PrivilegedHelperTools\/GoLiveBypass\/helper up, \/Library\/PrivilegedHelperTools\/GoLiveBypass\/helper down$/m);
    expect(sudoersContent()).not.toContain('*');
  });

  it('sanitize força AllowedIPs do Discord e descarta PostUp/DNS', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-'));
    const src = path.join(dir, 'in.conf');
    fs.writeFileSync(src, [
      '[Interface]', 'PrivateKey = k', 'Address = 10.2.0.2/32', 'DNS = 10.2.0.1', 'PostUp = touch /tmp/pwn',
      '[Peer]', 'PublicKey = p', 'AllowedIPs = 0.0.0.0/0, ::/0', 'Endpoint = 1.2.3.4:51820',
    ].join('\n'));
    const awk = s.match(/awk -v allowed='([^']+)' '([\s\S]+?)' "\$src"/);
    expect(awk).not.toBeNull();
    const out = execFileSync('awk', ['-v', `allowed=${awk![1]}`, awk![2], src], { encoding: 'utf8' });
    expect(out).toContain('AllowedIPs = 162.159.0.0/16, 104.16.0.0/12');
    expect(out).not.toMatch(/0\.0\.0\.0\/0|::\/0|PostUp|DNS/);
    expect(out).toContain('Endpoint = 1.2.3.4:51820');
  });
});

import { hasV6Rejects } from '../../src/main/privileged/helper';

describe('hasV6Rejects', () => {
  it('acha as rejeições IPv6 do helper no netstat', () => {
    expect(hasV6Rejects([
      'Destination                             Gateway                                 Flags         Netif Expire',
      '2606:4700::/32                          ::1                                     UGRSc                 lo0',
    ].join('\n'))).toBe(true);
    expect(hasV6Rejects('2606:4700::/32  fe80::1%en0  UGSc  en0\ndefault  fe80::1%en0  UGcg  en0')).toBe(false);
  });
});
