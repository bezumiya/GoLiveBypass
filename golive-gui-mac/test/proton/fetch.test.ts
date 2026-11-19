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

import { lastJson, normalizeRoutes, chosenFromJson, normalizePlan } from '../../src/main/proton/fetch';

describe('saídas do proton-confgen', () => {
  it('pega a última linha JSON e ignora texto', () => {
    expect(lastJson('aviso\n{"a":1}\n{"b":2}\nfim')).toEqual({ b: 2 });
    expect(lastJson('nada')).toBeNull();
  });
  it('rotas: só os campos usados, ping inválido sai', () => {
    expect(normalizeRoutes([{ server: 'US-FREE#1', country: 'US', city: 'Miami', load: 40, pingMs: 0, extra: 1 }, { nome: 'x' }]))
      .toEqual([{ server: 'US-FREE#1', country: 'US', city: 'Miami', load: 40 }]);
    expect(normalizeRoutes(null)).toEqual([]);
  });
  it('resultado do speed test traz as velocidades', () => {
    expect(chosenFromJson({ success: true, server: 'US-FREE#7', country: 'US', city: 'NY', pingMs: 120, downloadMbps: 25.8, uploadMbps: 6.6 }))
      .toEqual({ server: 'US-FREE#7', country: 'US', city: 'NY', pingMs: 120, downloadMbps: 25.8, uploadMbps: 6.6 });
    expect(chosenFromJson({ success: false, server: 'x' })).toBeNull();
  });
  it('plano: MaxTier inválido nunca vira Free', () => {
    expect(normalizePlan({ success: true, maxTier: 0, planTitle: 'Proton VPN Free' })).toEqual({ status: 'free', maxTier: 0, planTitle: 'Proton VPN Free' });
    expect(normalizePlan({ success: true, maxTier: 2 })).toEqual({ status: 'premium', maxTier: 2 });
    expect(normalizePlan({ success: true, maxTier: 0, planName: 'free', planTitle: '' })).toEqual({ status: 'free', maxTier: 0 });
    expect(normalizePlan({ success: true })).toBeNull();
    expect(normalizePlan({ success: false, maxTier: 0 })).toBeNull();
  });
});

import { classifyFailure } from '../../src/main/proton/fetch';

/** Resposta do helper novo quando a Proton recusa a versão do app (HTTP 422, código 5003). */
const VERSAO_RECUSADA_JSON = {
  success: false,
  error: 'authentication failed: failed to get auth info: Proton no longer accepts this app version (code 5003); update GoLiveBypass',
  code: 'APP_VERSION_UNSUPPORTED',
  retryable: false,
};

describe('ProtonFetcher.fetch com binário falso', () => {
  // Monta binDir/../extra/proton-confgen com um script e o manifesto do seu hash.
  const fake = (json: object, writeConf = true, exitCode = 0) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-fake-'));
    const dir = path.join(root, 'extra', 'proton-confgen');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'bin'));
    const script = [
      '#!/bin/sh',
      `echo "$@" > "${path.join(root, 'args')}"`,
      writeConf ? 'while [ $# -gt 0 ]; do [ "$1" = "-output" ] && echo "[Interface]" > "$2"; shift; done' : '',
      `echo '${JSON.stringify(json)}'`,
      ...(exitCode ? [`exit ${exitCode}`] : []),
    ].join('\n');
    const bin = path.join(dir, 'proton-confgen');
    fs.writeFileSync(bin, script, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'proton-confgen-manifest.json'),
      JSON.stringify({ universal: { sha256: crypto.createHash('sha256').update(script).digest('hex') } }));
    return {
      args: () => fs.readFileSync(path.join(root, 'args'), 'utf8'),
      opts: { username: 'u', binDir: path.join(root, 'bin'), sessDir: path.join(root, 'sess'), confOut: path.join(root, 'out.conf') },
    };
  };
  const run = (f: ProtonFetcher, opts: object) =>
    new Promise<any>(res => { f.once('done', res); void f.fetch(opts as any); });

  it('manual valida o servidor escolhido com -manual-probe', async () => {
    const f = fake({ success: true, server: 'MX-FREE#16', country: 'MX', city: 'Queretaro', pingMs: 140 });
    const r = await run(new ProtonFetcher(), { ...f.opts, mode: 'manual', server: 'MX-FREE#16' });
    expect(r).toMatchObject({ ok: true, chosen: { server: 'MX-FREE#16', pingMs: 140 } });
    expect(f.args()).toMatch(/-server MX-FREE#16 -manual-probe/);
  });

  it('manual sem servidor nem chega a rodar o binário', async () => {
    const f = fake({ success: true });
    const r = await run(new ProtonFetcher(), { ...f.opts, mode: 'manual' });
    expect(r).toMatchObject({ ok: false, error: 'unknown' });
  });

  it('conf de outro dispositivo leva -device-name e devolve a validade', async () => {
    const f = fake({ success: true, server: 'MX-FREE#16', country: 'MX', city: 'Queretaro', expiresAt: 1824000000 });
    const r = await run(new ProtonFetcher(), { ...f.opts, mode: 'manual', server: 'MX-FREE#16', deviceName: 'GoLiveBypass-iPhone' });
    expect(r).toMatchObject({ ok: true, expiresAt: 1824000000 });
    expect(f.args()).toMatch(/-device-name GoLiveBypass-iPhone/);
    expect(f.args()).toMatch(/-server MX-FREE#16 -manual-probe/);
  });

  it('catálogo nunca leva -device-name, e nome inválido é ignorado', async () => {
    const cat = fake({ success: true, routes: [] });
    await run(new ProtonFetcher(), { ...cat.opts, mode: 'catalog', deviceName: 'GoLiveBypass-iPhone' });
    expect(cat.args()).not.toMatch(/-device-name/);
    const bad = fake({ success: true, server: 'MX-FREE#16', country: 'MX', city: 'Q' });
    await run(new ProtonFetcher(), { ...bad.opts, mode: 'manual', server: 'MX-FREE#16', deviceName: 'x; rm -rf' });
    expect(bad.args()).not.toMatch(/-device-name/);
  });

  it('speed aceita só com download e upload medidos', async () => {
    const ok = fake({ success: true, server: 'US-FREE#7', country: 'US', city: 'NY', downloadMbps: 22.7, uploadMbps: 8.7 });
    expect(await run(new ProtonFetcher(), { ...ok.opts, mode: 'speed', exclude: ['US-FREE#1'] }))
      .toMatchObject({ ok: true, chosen: { server: 'US-FREE#7', downloadMbps: 22.7 } });
    expect(ok.args()).toMatch(/-speed-test -exclude-servers US-FREE#1/);
    expect(ok.args()).not.toMatch(/-require-discord/);

    const semMedida = fake({ success: true, server: 'US-FREE#7', country: 'US', city: 'NY' });
    expect(await run(new ProtonFetcher(), { ...semMedida.opts, mode: 'speed' }))
      .toEqual({ ok: false, error: 'unknown', detail: 'A medição não retornou velocidades válidas de download e upload.' });
  });

  it('login recusado pela versão do app chega como app_outdated; senha errada continua auth_failed', async () => {
    const outdated = fake(VERSAO_RECUSADA_JSON, false, 1);
    expect(await run(new ProtonFetcher(), { ...outdated.opts, password: 'senha' })).toEqual({ ok: false, error: 'app_outdated' });
    expect(outdated.args()).toMatch(/-route-catalog/);

    const wrong = fake({ success: false, error: 'authentication failed: incorrect username or password', code: 'INVALID_CREDENTIALS', retryable: false }, false, 1);
    expect(await run(new ProtonFetcher(), { ...wrong.opts, password: 'errada' })).toEqual({ ok: false, error: 'auth_failed' });
  });
});

describe('classificação das falhas do proton-confgen', () => {
  it('versão do app recusada vira app_outdated, antes da regra de senha', () => {
    expect(classifyFailure(`${JSON.stringify(VERSAO_RECUSADA_JSON)}\n`)).toEqual({ ok: false, error: 'app_outdated' });
    // O código estruturado basta, mesmo sem o texto em inglês.
    expect(classifyFailure('{"success":false,"error":"falhou","code":"APP_VERSION_UNSUPPORTED","retryable":false}\n'))
      .toEqual({ ok: false, error: 'app_outdated' });
    // Helper antigo: só o texto, que o `auth.*fail` lia como senha errada.
    expect(classifyFailure('{"success":false,"error":"authentication failed: failed to get auth info: authentication failed with code: 5003"}\n'))
      .toEqual({ ok: false, error: 'app_outdated' });
    expect(classifyFailure('Error: authentication failed: failed to get auth info: authentication failed with code: 5003\n'))
      .toEqual({ ok: false, error: 'app_outdated' });
    expect(classifyFailure('This version of the app is no longer supported')).toEqual({ ok: false, error: 'app_outdated' });
    expect(classifyFailure('authentication failed with code: 5001').error).toBe('app_outdated');
    expect(classifyFailure('authentication failed with code: 5005').error).toBe('app_outdated');
  });

  it('senha errada e outros códigos continuam como antes', () => {
    expect(classifyFailure('{"success":false,"error":"authentication failed: incorrect username or password","code":"INVALID_CREDENTIALS","retryable":false}\n'))
      .toEqual({ ok: false, error: 'auth_failed' });
    expect(classifyFailure('Error: authentication failed: incorrect username or password\n')).toEqual({ ok: false, error: 'auth_failed' });
    expect(classifyFailure('authentication failed with code: 50031').error).toBe('auth_failed');
    expect(classifyFailure('{"success":false,"error":"CAPTCHA verification required","code":"CAPTCHA_REQUIRED"}\n').error).toBe('captcha');
  });

  it('a tela tem a mensagem de atualização para app_outdated e mantém a de senha', () => {
    const renderer = fs.readFileSync('src/renderer/renderer.ts', 'utf8');
    expect(renderer).toMatch(/app_outdated:\s*'A Proton deixou de aceitar esta versão do GoLiveBypass\. Atualize o GoLiveBypass para continuar\.'/);
    expect(renderer).toMatch(/auth_failed:\s*'Usuário ou senha incorretos\.'/);
    expect(renderer).toMatch(/app_outdated:\s*errMsgs\.app_outdated/);
  });
});
