import { describe, it, expect, vi } from 'vitest';
import { PhoneConfService, PHONE_CONF_TTL_MS, type PhoneDeps } from '../../src/main/phone/service';

const RAW = `[Interface]
PrivateKey = cHJpdmF0ZWtleXByaXZhdGVrZXlwcml2YXRla2V5MTI=
Address = 10.2.0.2/32
DNS = 10.2.0.1

[Peer]
PublicKey = cHVibGlja2V5cHVibGlja2V5cHVibGlja2V5cHViMTI=
AllowedIPs = 0.0.0.0/0
Endpoint = 1.2.3.4:51820
`;

const ROUTES = [
  { server: 'US-FREE#7', country: 'US', city: 'Miami', load: 30, pingMs: 160 },
  { server: 'MX-FREE#16', country: 'MX', city: 'Queretaro', load: 50, pingMs: 120 },
];

function setup(over: Partial<PhoneDeps> = {}) {
  const files = new Map<string, { data: string; mode?: number }>();
  const timers: { fn: () => void; ms: number }[] = [];
  const calls: any[] = [];
  const deps: PhoneDeps = {
    fetch: vi.fn(async (o: any) => {
      calls.push(o);
      if (o.mode === 'catalog') return { ok: true, routes: ROUTES };
      files.set(o.confOut, { data: RAW });
      return { ok: true, chosen: { server: o.server, country: 'MX', city: 'Queretaro', pingMs: 120 }, expiresAt: 1824000000 };
    }),
    tmpPath: () => '/tmp/phone-raw-1.conf',
    readFile: p => files.get(p)!.data,
    writeFile: (p, data, mode) => { files.set(p, { data, mode }); },
    rm: p => { files.delete(p); },
    exists: p => files.has(p),
    saveMeta: vi.fn(),
    now: () => new Date('2026-10-21T12:00:00Z'),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    isBusy: () => false,
    isCloudSynced: p => p.includes('/Library/Mobile Documents/'),
    ...over,
  };
  return { svc: new PhoneConfService(deps), deps, files, timers, calls };
}

describe('PhoneConfService.generate', () => {
  it('QR: escolhe o menor ping, valida com nome de dispositivo e não devolve a conf em texto', async () => {
    const { svc, deps, files, calls } = setup();
    const r = await svc.generate('qr');
    expect(calls[0]).toMatchObject({ mode: 'catalog' });
    expect(calls[1]).toMatchObject({ mode: 'manual', server: 'MX-FREE#16', deviceName: 'GoLiveBypass-Celular' });
    expect(r).toMatchObject({ ok: true, meta: { server: 'MX-FREE#16', expiresAt: 1824000000, generatedAt: '2026-10-21T12:00:00.000Z' } });
    expect(r.ok && r.qr?.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(JSON.stringify(r)).not.toContain('PrivateKey');
    expect(deps.saveMeta).toHaveBeenCalledTimes(1);
    expect(files.has('/tmp/phone-raw-1.conf')).toBe(false);
  });

  it('arquivo: sem QR; salva 0600 com a conf do celular e apaga quando pedido', async () => {
    const { svc, files } = setup();
    const r = await svc.generate('file');
    expect(r.ok && r.qr).toBeFalsy();
    const dest = '/Users/u/Desktop/GoLiveBypass.conf';
    expect(svc.saveTo(dest)).toEqual({ ok: true });
    expect(files.get(dest)!.mode).toBe(0o600);
    expect(files.get(dest)!.data).toContain('AllowedIPs = 162.159.0.0/16');
    expect(svc.savedPaths()).toEqual([dest]);
    expect(svc.deleteSaved()).toBe(true);
    expect(files.has(dest)).toBe(false);
    expect(svc.savedPaths()).toEqual([]);
  });

  it('lembra de todos os arquivos salvos, inclusive de gerações anteriores, e apaga todos', async () => {
    const { svc, files } = setup();
    await svc.generate('file');
    svc.saveTo('/Users/u/Downloads/a.conf');
    svc.saveTo('/Users/u/Downloads/a.conf');
    await svc.generate('file');
    svc.saveTo('/Users/u/Downloads/b.conf');
    expect(svc.savedPaths()).toEqual(['/Users/u/Downloads/a.conf', '/Users/u/Downloads/b.conf']);
    svc.clear();
    expect(svc.savedPaths()).toHaveLength(2);
    expect(svc.deleteSaved()).toBe(true);
    expect(files.has('/Users/u/Downloads/a.conf') || files.has('/Users/u/Downloads/b.conf')).toBe(false);
    expect(svc.savedPaths()).toEqual([]);
  });

  it('recusa salvar onde o iCloud sincroniza, como a Mesa com Mesa e Documentos ligados', async () => {
    const { svc, files } = setup({ isCloudSynced: p => p.startsWith('/Users/u/Desktop/') });
    await svc.generate('file');
    expect(svc.saveTo('/Users/u/Desktop/GoLiveBypass.conf')).toEqual({ ok: false, error: 'cloud_folder' });
    expect(files.has('/Users/u/Desktop/GoLiveBypass.conf')).toBe(false);
  });

  it('recusa salvar dentro do iCloud Drive', async () => {
    const { svc, files } = setup();
    await svc.generate('file');
    const dest = '/Users/u/Library/Mobile Documents/com~apple~CloudDocs/x.conf';
    expect(svc.saveTo(dest)).toEqual({ ok: false, error: 'cloud_folder' });
    expect(files.has(dest)).toBe(false);
  });

  it('salvar sem conf gerada', () => {
    expect(setup().svc.saveTo('/Users/u/Desktop/x.conf')).toEqual({ ok: false, error: 'no_conf' });
  });

  it('catálogo sem ping → no_routes', async () => {
    const { svc } = setup({ fetch: vi.fn(async () => ({ ok: true, routes: [{ server: 'X', country: 'US', city: 'Y', load: 1 }] })) });
    expect(await svc.generate('qr')).toEqual({ ok: false, error: 'no_routes' });
  });

  it('teste do servidor falhou → probe_failed, sem detail e com o temporário apagado', async () => {
    const files = new Map<string, any>();
    const { svc } = setup({
      fetch: vi.fn(async (o: any) => {
        if (o.mode === 'catalog') return { ok: true, routes: ROUTES };
        files.set(o.confOut, RAW);
        return { ok: false, error: 'unknown', detail: 'PrivateKey = abc' };
      }),
      exists: p => files.has(p),
      rm: p => { files.delete(p); },
    });
    const r = await svc.generate('qr');
    expect(r).toEqual({ ok: false, error: 'probe_failed' });
    expect(files.size).toBe(0);
  });

  it('servidor que falha no teste: tenta os próximos por ping, até 3', async () => {
    const files = new Map<string, any>();
    const tried: string[] = [];
    const routes = [...ROUTES, { server: 'US-FREE#9', country: 'US', city: 'NY', load: 10, pingMs: 170 }, { server: 'US-FREE#3', country: 'US', city: 'LA', load: 10, pingMs: 180 }];
    const mk = (okOn: string | null) => setup({
      fetch: vi.fn(async (o: any) => {
        if (o.mode === 'catalog') return { ok: true, routes };
        tried.push(o.server);
        if (o.server !== okOn) return { ok: false, error: 'unknown' };
        files.set(o.confOut, RAW);
        return { ok: true, chosen: { server: o.server, country: 'US', city: 'NY' } };
      }),
      readFile: p => files.get(p),
      exists: p => files.has(p),
      rm: p => { files.delete(p); },
    });
    const r = await mk('US-FREE#9').svc.generate('qr');
    expect(tried).toEqual(['MX-FREE#16', 'US-FREE#7', 'US-FREE#9']);
    expect(r).toMatchObject({ ok: true, meta: { server: 'US-FREE#9' } });
    tried.length = 0;
    expect(await mk(null).svc.generate('qr')).toEqual({ ok: false, error: 'probe_failed' });
    expect(tried).toHaveLength(3);
  });

  it('sessão expirada e timeout passam direto', async () => {
    const auth = setup({ fetch: vi.fn(async () => ({ ok: false, error: 'auth_failed' })) });
    expect(await auth.svc.generate('qr')).toEqual({ ok: false, error: 'auth_failed' });
    const slow = setup({ fetch: vi.fn(async () => ({ ok: false, error: 'timeout' })) });
    expect(await slow.svc.generate('qr')).toEqual({ ok: false, error: 'timeout' });
  });

  it('versão do app recusada passa direto, no catálogo e no teste, sem tentar outras rotas', async () => {
    const catalog = setup({ fetch: vi.fn(async () => ({ ok: false, error: 'app_outdated' })) });
    expect(await catalog.svc.generate('qr')).toEqual({ ok: false, error: 'app_outdated' });

    // A recusa vale para qualquer servidor: trocar de rota só gastaria mais duas tentativas
    const tried: string[] = [];
    const probe = setup({
      fetch: vi.fn(async (o: any) => {
        if (o.mode === 'catalog') return { ok: true, routes: ROUTES };
        tried.push(o.server);
        return { ok: false, error: 'app_outdated' };
      }),
    });
    expect(await probe.svc.generate('qr')).toEqual({ ok: false, error: 'app_outdated' });
    expect(tried).toEqual(['MX-FREE#16']);
  });

  it('busy quando o Mac já busca rota ou outra geração está em andamento', async () => {
    const mac = setup({ isBusy: () => true });
    expect(await mac.svc.generate('qr')).toEqual({ ok: false, error: 'busy' });
    expect(mac.deps.fetch).not.toHaveBeenCalled();
    const two = setup();
    const first = two.svc.generate('qr');
    expect(two.svc.generating).toBe(true);
    expect(await two.svc.generate('qr')).toEqual({ ok: false, error: 'busy' });
    await first;
    expect(two.svc.generating).toBe(false);
  });

  it('fechar o painel no meio descarta o resultado e segura o bloqueio até o processo terminar', async () => {
    const { svc } = setup();
    const p = svc.generate('qr');
    svc.clear();
    expect(svc.generating).toBe(true);
    expect(await svc.generate('qr')).toEqual({ ok: false, error: 'busy' });
    expect(await p).toEqual({ ok: false, error: 'unknown' });
    expect(svc.generating).toBe(false);
    expect(svc.saveTo('/Users/u/Desktop/x.conf')).toEqual({ ok: false, error: 'no_conf' });
  });

  it('a conf expira da memória depois de 5 minutos', async () => {
    const { svc, timers } = setup();
    await svc.generate('file');
    const t = timers.find(x => x.ms === PHONE_CONF_TTL_MS)!;
    expect(PHONE_CONF_TTL_MS).toBe(300_000);
    t.fn();
    expect(svc.saveTo('/Users/u/Desktop/x.conf')).toEqual({ ok: false, error: 'no_conf' });
  });
});
