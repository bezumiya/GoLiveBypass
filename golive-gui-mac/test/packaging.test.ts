import { describe, it, expect } from 'vitest';
import * as fs from 'fs';

describe('electron-builder.yml', () => {
  it('declara dmg arm64 e empacota resources/bin', () => {
    const y = fs.readFileSync('electron-builder.yml', 'utf8');
    expect(y).toMatch(/target:\s*\n?\s*-?\s*dmg/);
    expect(y).toContain('universal');
    expect(y).toContain('resources/bin');
    expect(y).toMatch(/notarize:\s*false/);
  });
});

import * as crypto from 'crypto';
import * as path from 'path';

describe('binários empacotados', () => {
  it('resources/bin confere com SHA256SUMS', () => {
    const sums = fs.readFileSync('resources/bin/SHA256SUMS', 'utf8').trim().split('\n');
    expect(sums.map(l => l.split(/\s+/)[1]).sort()).toEqual(['wg', 'wg-quick', 'wireguard-go']);
    for (const l of sums) {
      const [sha, name] = l.split(/\s+/);
      expect(crypto.createHash('sha256').update(fs.readFileSync(path.join('resources/bin', name))).digest('hex')).toBe(sha);
    }
  });
  it('ícones do app e da barra de menu existem e entram no build', () => {
    const y = fs.readFileSync('electron-builder.yml', 'utf8');
    expect(y).toContain('icon: build/icon.icns');
    expect(y).toContain('resources/tray');
    for (const f of ['build/icon.icns', 'resources/tray/iconTemplate.png', 'resources/tray/iconTemplate@2x.png']) expect(fs.existsSync(f)).toBe(true);
  });
  it('não empacota a cópia antiga do golivebypass.js', () => {
    expect(fs.existsSync('resources/extra/bypass')).toBe(false);
  });
});
