import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { enableFakeNitroIfUnset, vencordSettingsPath, isVencordInjected } from '../src/main/vencord/inject';

describe('enableFakeNitroIfUnset', () => {
  const homeWith = (settings?: object) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-v-'));
    if (settings) {
      const p = vencordSettingsPath(home);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(settings));
    }
    return home;
  };
  const read = (home: string) => JSON.parse(fs.readFileSync(vencordSettingsPath(home), 'utf8'));

  it('nunca religa um FakeNitro que o usuário desligou', () => {
    const home = homeWith({ plugins: { FakeNitro: { enabled: false, transformEmojis: true } } });
    expect(enableFakeNitroIfUnset(home)).toBe(false);
    expect(read(home).plugins.FakeNitro).toEqual({ enabled: false, transformEmojis: true });
  });
  it('liga quando nunca foi escolhido, preservando o resto', () => {
    const home = homeWith({ themeLinks: ['x'], plugins: { Other: { enabled: true } } });
    expect(enableFakeNitroIfUnset(home)).toBe(true);
    const s = read(home);
    expect(s.plugins.FakeNitro.enabled).toBe(true);
    expect(s.plugins.Other).toEqual({ enabled: true });
    expect(s.themeLinks).toEqual(['x']);
  });
  it('cria o arquivo se não existir', () => {
    const home = homeWith();
    expect(enableFakeNitroIfUnset(home)).toBe(true);
    expect(read(home).plugins.FakeNitro.enabled).toBe(true);
  });
  it('não reescreve um settings.json ilegível', () => {
    const home = homeWith();
    const p = vencordSettingsPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{quebrado');
    expect(enableFakeNitroIfUnset(home)).toBe(false);
    expect(fs.readFileSync(p, 'utf8')).toBe('{quebrado');
  });
});

describe('isVencordInjected', () => {
  it('detecta pelo _app.asar', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-d-'));
    fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
    expect(isVencordInjected(app)).toBe(false);
    fs.writeFileSync(path.join(app, 'Contents', 'Resources', '_app.asar'), '');
    expect(isVencordInjected(app)).toBe(true);
  });
});

import { canModifyApp } from '../src/main/vencord/inject';

describe('canModifyApp', () => {
  const makeApp = () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-p-'));
    const res = path.join(app, 'Contents', 'Resources');
    fs.mkdirSync(res, { recursive: true });
    return { app, res };
  };

  it('true quando dá para escrever no bundle, sem deixar o arquivo de teste', () => {
    const { app, res } = makeApp();
    expect(canModifyApp(app)).toBe(true);
    expect(fs.readdirSync(res)).toEqual([]);
  });

  // O root escreve mesmo sem permissão de escrita, então o caso negado não se reproduz
  it.skipIf(process.getuid?.() === 0)('false quando a escrita é negada', () => {
    const { app, res } = makeApp();
    fs.chmodSync(res, 0o555);
    try { expect(canModifyApp(app)).toBe(false); } finally { fs.chmodSync(res, 0o755); }
  });
});

import { injectVencord, AppManagementDenied } from '../src/main/vencord/inject';

describe('injectVencord', () => {
  it.skipIf(process.getuid?.() === 0)('sem permissão, não grava nada no settings do Vencord', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-v-'));
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-d-'));
    const res = path.join(app, 'Contents', 'Resources');
    fs.mkdirSync(res, { recursive: true });
    fs.chmodSync(res, 0o555);
    try {
      await expect(injectVencord({ home, discordApp: app, cacheDir: path.join(home, 'c'), log: () => {} }))
        .rejects.toBeInstanceOf(AppManagementDenied);
      expect(fs.existsSync(vencordSettingsPath(home))).toBe(false);
    } finally { fs.chmodSync(res, 0o755); }
  });
});
