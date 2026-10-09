import { describe, it, expect } from 'vitest';
import { pickLowestPing } from '../../src/main/proton/fetch';

describe('pickLowestPing', () => {
  it('escolhe o menor ping e desempata pela carga', () => {
    const r = pickLowestPing([
      { server: 'MX-FREE#4', country: 'MX', city: 'Mexico City', load: 72, pingMs: 123 },
      { server: 'US-FREE#51', country: 'US', city: 'Miami', load: 81, pingMs: 116 },
      { server: 'US-FREE#95', country: 'US', city: 'Miami', load: 60, pingMs: 116 },
      { server: 'US-FREE#1', country: 'US', city: 'Ashburn', load: 10 },
    ]);
    expect(r).toEqual({ server: 'US-FREE#95', country: 'US', city: 'Miami', pingMs: 116 });
  });
  it('null quando nenhum servidor respondeu ao ping', () => {
    expect(pickLowestPing([{ server: 'US-FREE#1', country: 'US', city: 'Ashburn', load: 10 }])).toBeNull();
  });
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { ProtonFetcher, binaryMatchesManifest } from '../../src/main/proton/fetch';

describe('ProtonFetcher.run', () => {
  it('resolve quando o binário não existe, em vez de pendurar', async () => {
    const r = await new ProtonFetcher().run('/nao/existe/proton-confgen', []);
    expect(r.code).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.err).toMatch(/ENOENT/);
  });
  it('mata o processo e resolve com timedOut quando passa do limite', async () => {
    const r = await new ProtonFetcher(200).run('/bin/sleep', ['5']);
    expect(r.timedOut).toBe(true);
  });
});

describe('binaryMatchesManifest', () => {
  const setup = (content: string, sha?: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-pc-'));
    const bin = path.join(dir, 'proton-confgen');
    fs.writeFileSync(bin, content);
    if (sha !== undefined) fs.writeFileSync(path.join(dir, 'proton-confgen-manifest.json'), JSON.stringify({ universal: { sha256: sha } }));
    return bin;
  };
  const h = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
  it('aceita só quando o hash confere', async () => {
    expect(await binaryMatchesManifest(setup('abc', h('abc')))).toBe(true);
    expect(await binaryMatchesManifest(setup('abc', h('outro')))).toBe(false);
  });
  it('recusa sem manifesto', async () => {
    expect(await binaryMatchesManifest(setup('abc'))).toBe(false);
  });
});
