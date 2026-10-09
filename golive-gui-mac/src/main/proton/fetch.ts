import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

export const PREFERRED_COUNTRIES = ['MX', 'US'];

export interface ProtonFetchOpts {
  username: string;
  password?: string;
  binDir: string;
  sessDir: string;
  confOut: string;
}

export interface ChosenServer { server: string; country: string; city: string; pingMs?: number }

export interface ProtonFetchResult {
  ok: boolean;
  error?: 'captcha' | 'auth_failed' | 'no_servers' | 'binary_missing' | 'binary_integrity' | 'timeout' | 'unknown';
  detail?: string;
  captchaUrl?: string;
  confPath?: string;
  chosen?: ChosenServer;
}

interface RunResult { code: number | null; out: string; err: string; timedOut: boolean }

// O catálogo com ping de todos os servidores MX/US leva bem menos que isto
const RUN_TIMEOUT_MS = 3 * 60_000;

/** O binário só roda se o hash bater com o manifesto gerado por scripts/build-proton.mjs. */
export async function binaryMatchesManifest(bin: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await fs.promises.readFile(path.join(path.dirname(bin), 'proton-confgen-manifest.json'), 'utf8'));
    const expected = String(manifest?.universal?.sha256 ?? '');
    if (!/^[0-9a-f]{64}$/.test(expected)) return false;
    // Em stream: o binário tem ~29 MB e isto roda no processo principal
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(bin)) hash.update(chunk);
    return hash.digest('hex') === expected;
  } catch { return false; }
}

interface CatalogRoute { server: string; country: string; city: string; load: number; pingMs?: number }

/** Servidor com menor ping medido; empate desempata pela menor carga. */
export function pickLowestPing(routes: CatalogRoute[]): ChosenServer | null {
  const measured = routes.filter(r => typeof r.pingMs === 'number' && r.pingMs > 0);
  if (measured.length === 0) return null;
  measured.sort((a, b) => a.pingMs! - b.pingMs! || a.load - b.load);
  const { server, country, city, pingMs } = measured[0];
  return { server, country, city, pingMs };
}

function classifyFailure(combined: string): ProtonFetchResult {
  if (/captcha|human.?verif|hv.?token|recaptcha|9001/i.test(combined)) {
    return { ok: false, error: 'captcha', captchaUrl: combined.match(/https?:\/\/\S+captcha\S*/i)?.[0] };
  }
  if (/incorrect.*password|invalid.*credential|auth.*fail|wrong.*password/i.test(combined)) {
    return { ok: false, error: 'auth_failed' };
  }
  if (/no.*server|zero.*server|sem.*servidor|nenhum servidor/i.test(combined)) {
    return { ok: false, error: 'no_servers' };
  }
  return { ok: false, error: 'unknown' };
}

/** Emite 'progress' (string) e 'done' (ProtonFetchResult) */
export class ProtonFetcher extends EventEmitter {
  private proc: child_process.ChildProcess | null = null;

  constructor(private readonly timeoutMs = RUN_TIMEOUT_MS) { super(); }

  run(bin: string, args: string[], stdin?: string): Promise<RunResult> {
    return new Promise(resolve => {
      let out = '';
      let err = '';
      let settled = false;
      const finish = (code: number | null, timedOut = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.proc = null;
        resolve({ code, out, err, timedOut });
      };
      const proc = child_process.spawn(bin, args, { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      const timer = setTimeout(() => { proc.kill('SIGKILL'); finish(null, true); }, this.timeoutMs);
      proc.stdin?.on('error', () => {});
      if (stdin !== undefined) proc.stdin?.end(stdin);
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('error', e => { err += String(e); finish(null); });
      proc.on('close', code => finish(code));
    });
  }

  async fetch(opts: ProtonFetchOpts): Promise<void> {
    try {
      await this.fetchInner(opts);
    } catch (e) {
      this.emit('done', { ok: false, error: 'unknown', detail: String((e as Error)?.message ?? e) } satisfies ProtonFetchResult);
    }
  }

  private async fetchInner(opts: ProtonFetchOpts): Promise<void> {
    const bin = path.join(opts.binDir, '..', 'extra', 'proton-confgen', 'proton-confgen');
    if (!fs.existsSync(bin)) {
      this.emit('done', { ok: false, error: 'binary_missing' } satisfies ProtonFetchResult);
      return;
    }
    if (!(await binaryMatchesManifest(bin))) {
      this.emit('done', { ok: false, error: 'binary_integrity' } satisfies ProtonFetchResult);
      return;
    }
    fs.mkdirSync(opts.sessDir, { recursive: true });

    // A senha vai pelo stdin (-stdin-secrets), nunca na linha de comando visível no `ps`.
    // Sem senha, o proton-confgen reutiliza a sessão salva em -session-file.
    const secrets = opts.password ? JSON.stringify({ password: opts.password }) : undefined;
    const common = [
      '-username', opts.username,
      ...(secrets ? ['-stdin-secrets'] : []),
      '-session-file', path.join(opts.sessDir, 'session.json'),
      '-free-only',
      '-countries', PREFERRED_COUNTRIES.join(','),
      '-json',
    ];

    this.emit('progress', '[1/3] Medindo ping dos servidores do México e EUA…');
    const cat = await this.run(bin, [...common, '-route-catalog', '-auto-ping'], secrets);
    if (cat.timedOut) { this.emit('done', { ok: false, error: 'timeout' } satisfies ProtonFetchResult); return; }
    if (cat.code !== 0) {
      this.emit('done', classifyFailure(cat.out + cat.err));
      return;
    }

    let chosen: ChosenServer | null = null;
    try {
      const last = cat.out.trim().split('\n').pop() ?? '';
      chosen = pickLowestPing(JSON.parse(last).routes ?? []);
    } catch { /* catálogo ilegível: cai na escolha automática */ }

    this.emit('progress', chosen
      ? `[2/3] Melhor: ${chosen.server} (${chosen.city}) · ${chosen.pingMs} ms`
      : '[2/3] Nenhum ping respondeu; usando a escolha automática do Proton…');

    this.emit('progress', '[3/3] Gerando configuração WireGuard…');
    const gen = await this.run(bin, [
      ...common,
      ...(chosen ? ['-server', chosen.server] : ['-auto-ping']),
      '-output', opts.confOut,
    ], secrets);

    if (gen.timedOut) { this.emit('done', { ok: false, error: 'timeout' } satisfies ProtonFetchResult); return; }
    if (gen.code === 0 && fs.existsSync(opts.confOut)) {
      this.emit('progress', 'Configuração obtida com sucesso!');
      this.emit('done', { ok: true, confPath: opts.confOut, ...(chosen ? { chosen } : {}) } satisfies ProtonFetchResult);
      return;
    }
    this.emit('done', classifyFailure(gen.out + gen.err));
  }

  cancel(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
