import { describe, it, expect, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0', getAppPath: () => '/x', getPath: () => '/tmp' } }));
import { pickRelease, expectedSha256 } from '../src/main/updater';

const dmg = (v: string, extra: object = {}) => ({ name: `GoLiveBypass-macos-${v}-universal.dmg`, browser_download_url: `https://x/${v}.dmg`, ...extra });

describe('pickRelease', () => {
  const releases = [
    { tag_name: 'v2.0.10-beta-3', prerelease: true, assets: [{ name: 'GoLiveBypass.exe' }] },
    { tag_name: 'v2.0.9', assets: [{ name: 'GoLiveBypass.exe' }, { name: 'GoLiveBypass.dmg' }] },
    { tag_name: 'macos-v0.6.0', assets: [dmg('0.6.0')] },
    { tag_name: 'macos-v0.7.0', assets: [dmg('0.7.0')] },
    { tag_name: 'macos-v0.8.0', draft: true, assets: [dmg('0.8.0')] },
  ];
  it('pega a maior versão macOS, ignorando releases da GUI, drafts e prereleases', () => {
    expect(pickRelease(releases, '0.5.1', 'arm64')?.version).toBe('0.7.0');
  });
  it('nada quando já está na última', () => {
    expect(pickRelease(releases, '0.7.0', 'arm64')).toBeNull();
  });
  it('aceita tags vX.Y.Z de forks', () => {
    expect(pickRelease([{ tag_name: 'v0.6.0', assets: [dmg('0.6.0')] }], '0.5.1')?.version).toBe('0.6.0');
  });
});

describe('expectedSha256', () => {
  it('usa o digest do GitHub', async () => {
    expect(await expectedSha256(dmg('0.6.0', { digest: `sha256:${'A'.repeat(64)}` }), [])).toBe('a'.repeat(64));
  });
  it('cai no sidecar .sha256', async () => {
    const a = dmg('0.6.0');
    const side = { name: `${a.name}.sha256`, browser_download_url: 'https://x/side' };
    expect(await expectedSha256(a, [a, side], async () => `${'b'.repeat(64)}  ${a.name}\n`)).toBe('b'.repeat(64));
  });
  it('null sem hash publicado ou com sidecar inválido', async () => {
    const a = dmg('0.6.0');
    expect(await expectedSha256(a, [a])).toBeNull();
    const side = { name: `${a.name}.sha256`, browser_download_url: 'https://x/side' };
    expect(await expectedSha256(a, [a, side], async () => 'lixo')).toBeNull();
  });
});
