import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
// @ts-expect-error módulo .mjs sem tipos
import { createPayload, publishPayload, preflightErrors, postflightErrors, releaseTag, expectedAssets } from '../scripts/release-guard.mjs';

const ok = { version: '0.6.0', updateRepo: undefined, protonSha: 'a'.repeat(64), protonManifestSha: 'a'.repeat(64) };
const files = Object.fromEntries(expectedAssets('0.6.0').map((n: string) => [n, `/x/${n}`]));

describe('release macOS nunca vira latest', () => {
  it('criação e publicação sempre mandam make_latest "false"', () => {
    expect(createPayload({ version: '0.6.0', target: 'abc', notes: '' })).toMatchObject({ make_latest: 'false', draft: true, prerelease: false });
    expect(createPayload({ version: '0.7.0-beta-1', target: 'abc', notes: '' })).toMatchObject({ make_latest: 'false', prerelease: true });
    expect(publishPayload()).toEqual({ draft: false, make_latest: 'false' });
  });

  it('tag própria do macOS, separada das tags vX.Y.Z da GUI', () => {
    expect(releaseTag('0.6.0')).toBe('macos-v0.6.0');
  });

  it('falha se a release virou latest ou mudou a latest', () => {
    const release = { tag_name: 'macos-v0.6.0', prerelease: false, assets: expectedAssets('0.6.0').map((name: string) => ({ name })) };
    expect(postflightErrors({ version: '0.6.0', release, latestTagBefore: 'v2.0.9', latestTagAfter: 'v2.0.9', dmgSha256: 'x' })).toEqual([]);
    expect(postflightErrors({ version: '0.6.0', release, latestTagBefore: 'v2.0.9', latestTagAfter: 'macos-v0.6.0', dmgSha256: 'x' }))
      .toContain('macos-v0.6.0 virou /releases/latest');
  });

  it('falha com asset faltando, sobrando ou digest diferente', () => {
    const base = { version: '0.6.0', latestTagBefore: 'v2.0.9', latestTagAfter: 'v2.0.9', dmgSha256: 'b'.repeat(64) };
    const only = { tag_name: 'macos-v0.6.0', prerelease: false, assets: [{ name: 'GoLiveBypass-macos-0.6.0-universal.dmg' }] };
    expect(postflightErrors({ ...base, release: only })[0]).toMatch(/assets publicados/);
    const wrong = { tag_name: 'macos-v0.6.0', prerelease: false, assets: [
      { name: 'GoLiveBypass-macos-0.6.0-universal.dmg', digest: `sha256:${'c'.repeat(64)}` },
      { name: 'GoLiveBypass-macos-0.6.0-universal.dmg.sha256' },
    ] };
    expect(postflightErrors({ ...base, release: wrong })).toContain('o digest do DMG publicado não confere com o arquivo local');
  });
});

describe('preflight', () => {
  it('passa com DMG, sidecar e app coerentes com o repositório oficial', () => {
    expect(preflightErrors({ version: '0.6.0', repo: 'bezumiya/GoLiveBypass', files, bundled: ok })).toEqual([]);
  });
  it('recusa DMG que atualiza de outro repositório', () => {
    const e = preflightErrors({ version: '0.6.0', repo: 'bezumiya/GoLiveBypass', files, bundled: { ...ok, updateRepo: 'GabrielRanna/GoLiveBypass' } });
    expect(e.join()).toMatch(/busca atualizações em GabrielRanna/);
  });
  it('recusa sem assets, com versão errada ou proton-confgen sem manifesto', () => {
    expect(preflightErrors({ version: '0.6.0', repo: 'bezumiya/GoLiveBypass', files: {}, bundled: ok }).join()).toMatch(/asset ausente/);
    expect(preflightErrors({ version: '0.6.0', repo: 'bezumiya/GoLiveBypass', files, bundled: { ...ok, version: '0.5.1' } }).join()).toMatch(/0\.5\.1/);
    expect(preflightErrors({ version: '0.6.0', repo: 'bezumiya/GoLiveBypass', files, bundled: { ...ok, protonManifestSha: undefined } }).join()).toMatch(/manifesto/);
  });
});

describe('workflow de release', () => {
  it('publica só pelo script com guarda', () => {
    const wf = fs.readFileSync('../.github/workflows/release-macos.yml', 'utf8');
    expect(wf).toContain('npm run release:mac');
    expect(wf).toContain('--publish-draft');
    expect(fs.readFileSync('scripts/release-mac.mjs', 'utf8')).toMatch(/draft: true, make_latest: 'false'/);
    expect(wf).not.toMatch(/make_latest:\s*true|--latest\b/);
  });
});
