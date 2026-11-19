import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

export const PREFERRED_COUNTRIES = ['MX', 'US'];

/**
 * auto: mede o ping do catálogo e gera o de menor ping.
 * manual: valida e gera o servidor escolhido (-manual-probe).
 * speed: mede download/upload por um túnel em espaço de usuário (-speed-test), sem tocar nas rotas do Mac.
 * catalog: só lista as rotas com ping, sem gerar perfil.
 */
export type FetchMode = 'auto' | 'manual' | 'speed' | 'catalog';

export interface ProtonFetchOpts {
  username: string;
  password?: string;
  binDir: string;
  sessDir: string;
  confOut: string;
  mode?: FetchMode;
  server?: string;
  /** Servidores fora da escolha automática (troca de rota quando a atual cai). */
  exclude?: string[];
  /** Nome da conf persistente no painel do Proton (conf de outro aparelho). */
  deviceName?: string;
}

export interface ChosenServer {
  server: string;
  country: string;
  city: string;
  pingMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
}

export interface CatalogRoute { server: string; country: string; city: string; load: number; pingMs?: number }

export interface ProtonFetchResult {
  ok: boolean;
  error?: 'captcha' | 'auth_failed' | 'app_outdated' | 'no_servers' | 'binary_missing' | 'binary_integrity' | 'timeout' | 'unknown';
  detail?: string;
  /** Validade do certificado emitido (Unix, segundos). */
  expiresAt?: number;
  captchaUrl?: string;
  confPath?: string;
  chosen?: ChosenServer;
  routes?: CatalogRoute[];
}

interface RunResult { code: number | null; out: string; err: string; timedOut: boolean }

// O catálogo com ping de todos os servidores MX/US leva bem menos que isto
const RUN_TIMEOUT_MS = 3 * 60_000;
// O speed test valida até doze rotas e mede até seis (~3 min pelo próprio helper)
const SPEED_TIMEOUT_MS = 5 * 60_000;

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

export const confgenPath = (binDir: string) => path.join(binDir, '..', 'extra', 'proton-confgen', 'proton-confgen');

/** Servidor com menor ping medido; empate desempata pela menor carga. */
export function pickLowestPing(routes: CatalogRoute[]): ChosenServer | null {
  const measured = routes.filter(r => typeof r.pingMs === 'number' && r.pingMs > 0);
  if (measured.length === 0) return null;
  measured.sort((a, b) => a.pingMs! - b.pingMs! || a.load - b.load);
  const { server, country, city, pingMs } = measured[0];
  return { server, country, city, pingMs };
}

/** Última linha JSON da saída (o -json imprime um objeto por execução). */
export function lastJson(out: string): any {
  const lines = out.trim().split('\n').reverse();
  for (const l of lines) {
    try { const v = JSON.parse(l); if (v && typeof v === 'object') return v; } catch {}
  }
  return null;
}

/** Rotas do catálogo com os campos que a interface usa; descarta o resto. */
export function normalizeRoutes(raw: unknown): CatalogRoute[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r: any) => {
    if (typeof r?.server !== 'string' || !r.server) return [];
    const pingMs = Number(r.pingMs);
    return [{
      server: r.server,
      country: typeof r.country === 'string' ? r.country : '',
      city: typeof r.city === 'string' ? r.city : '',
      load: Number.isFinite(Number(r.load)) ? Number(r.load) : 100,
      ...(Number.isFinite(pingMs) && pingMs > 0 ? { pingMs } : {}),
    }];
  });
}

const finitePositive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Resultado de uma geração (-json): só os campos conhecidos, números conferidos. */
export function chosenFromJson(j: any): ChosenServer | null {
  if (!j || j.success !== true || typeof j.server !== 'string' || !j.server) return null;
  return {
    server: j.server,
    country: typeof j.country === 'string' ? j.country : '',
    city: typeof j.city === 'string' ? j.city : '',
    ...(finitePositive(j.pingMs) ? { pingMs: j.pingMs } : {}),
    ...(finitePositive(j.downloadMbps) ? { downloadMbps: j.downloadMbps } : {}),
    ...(finitePositive(j.uploadMbps) ? { uploadMbps: j.uploadMbps } : {}),
  };
}

// A Proton recusa o identificador de cliente desatualizado (HTTP 422, código 5003).
// O helper novo responde com o código APP_VERSION_UNSUPPORTED; o antigo, só com o
// texto "authentication failed with code: 5003", que o `auth.*fail` lia como senha errada.
const APP_OUTDATED_RE = /app_version_unsupported|with code: 50(01|03|05)\b|no longer (supported|accepts)/i;

export function classifyFailure(combined: string): ProtonFetchResult {
  if (lastJson(combined)?.code === 'APP_VERSION_UNSUPPORTED' || APP_OUTDATED_RE.test(combined)) {
    return { ok: false, error: 'app_outdated' };
  }
  if (/captcha|human.?verif|hv.?token|recaptcha|9001/i.test(combined)) {
    return { ok: false, error: 'captcha', captchaUrl: combined.match(/https?:\/\/\S+captcha\S*/i)?.[0] };
  }
  if (/incorrect.*password|invalid.*credential|auth.*fail|wrong.*password/i.test(combined)) {
    return { ok: false, error: 'auth_failed' };
  }
  if (/no.*server|zero.*server|sem.*servidor|nenhum servidor/i.test(combined)) {
    return { ok: false, error: 'no_servers' };
  }
  const detail = lastJson(combined)?.error;
  return { ok: false, error: 'unknown', ...(typeof detail === 'string' ? { detail: detail.slice(0, 300) } : {}) };
}

export interface ProtonPlan { status: 'free' | 'premium'; maxTier: number; planTitle?: string }

/** Contrato do -check-plan; MaxTier ausente ou inválido nunca vira "Free". */
export function normalizePlan(v: any): ProtonPlan | null {
  if (!v || v.success !== true || !Number.isInteger(v.maxTier) || v.maxTier < 0) return null;
  // planName é um código ("free", "vpn2022"); só o planTitle serve para a tela
  const title = typeof v.planTitle === 'string' && v.planTitle.trim() && v.planTitle.length <= 120 ? v.planTitle : null;
  return { status: v.maxTier === 0 ? 'free' : 'premium', maxTier: v.maxTier, ...(title ? { planTitle: title.trim() } : {}) };
}

/** Emite 'progress' (string) e 'done' (ProtonFetchResult) */
export class ProtonFetcher extends EventEmitter {
  private proc: child_process.ChildProcess | null = null;

  constructor(private readonly timeoutMs = RUN_TIMEOUT_MS) { super(); }

  run(bin: string, args: string[], stdin?: string, timeoutMs = this.timeoutMs): Promise<RunResult> {
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
      const timer = setTimeout(() => { proc.kill('SIGKILL'); finish(null, true); }, timeoutMs);
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

  /** Plano da conta pela sessão salva; não pede senha nem gera perfil. */
  async checkPlan(binDir: string, sessDir: string, username: string): Promise<ProtonPlan | null> {
    const bin = confgenPath(binDir);
    if (!fs.existsSync(bin) || !(await binaryMatchesManifest(bin))) return null;
    const r = await this.run(bin, [
      '-username', username, '-session-file', path.join(sessDir, 'session.json'), '-check-plan', '-json',
    ], undefined, 20_000);
    return r.code === 0 ? normalizePlan(lastJson(r.out)) : null;
  }

  private async fetchInner(opts: ProtonFetchOpts): Promise<void> {
    const done = (r: ProtonFetchResult) => { this.emit('done', r); };
    const bin = confgenPath(opts.binDir);
    if (!fs.existsSync(bin)) return done({ ok: false, error: 'binary_missing' });
    if (!(await binaryMatchesManifest(bin))) return done({ ok: false, error: 'binary_integrity' });
    fs.mkdirSync(opts.sessDir, { recursive: true });

    const mode = opts.mode ?? 'auto';
    // A senha vai pelo stdin (-stdin-secrets), nunca na linha de comando visível no `ps`.
    // Sem senha, o proton-confgen reutiliza a sessão salva em -session-file.
    const secrets = opts.password ? JSON.stringify({ password: opts.password }) : undefined;
    const exclude = (opts.exclude ?? []).filter(s => /^[\w#-]{1,40}$/.test(s));
    const device = opts.deviceName && /^[\w-]{1,40}$/.test(opts.deviceName) ? ['-device-name', opts.deviceName] : [];
    const expiresOf = (out: string) => {
      const v = lastJson(out)?.expiresAt;
      return Number.isInteger(v) && v > 0 ? { expiresAt: v as number } : {};
    };
    const common = [
      '-username', opts.username,
      ...(secrets ? ['-stdin-secrets'] : []),
      '-session-file', path.join(opts.sessDir, 'session.json'),
      '-free-only',
      '-countries', PREFERRED_COUNTRIES.join(','),
      '-json',
    ];

    if (mode === 'manual' || mode === 'speed') {
      if (mode === 'manual' && !opts.server) return done({ ok: false, error: 'unknown', detail: 'nenhum servidor escolhido' });
      this.emit('progress', mode === 'manual'
        ? `Validando ${opts.server}…`
        : 'Medindo download e upload das melhores rotas (até 3 min)…');
      const args = mode === 'manual'
        ? [...common, ...device, '-server', opts.server!, '-manual-probe', '-output', opts.confOut]
        : [...common, ...device, '-speed-test', ...(exclude.length ? ['-exclude-servers', exclude.join(',')] : []), '-output', opts.confOut];
      const r = await this.run(bin, args, secrets, mode === 'speed' ? SPEED_TIMEOUT_MS : this.timeoutMs);
      if (r.timedOut) return done({ ok: false, error: 'timeout' });
      const chosen = chosenFromJson(lastJson(r.out));
      const measured = mode === 'manual' || (chosen?.downloadMbps && chosen?.uploadMbps);
      if (r.code === 0 && chosen && measured && fs.existsSync(opts.confOut)) {
        this.emit('progress', 'Configuração obtida com sucesso!');
        return done({ ok: true, confPath: opts.confOut, chosen, ...expiresOf(r.out) });
      }
      if (r.code === 0 && chosen && !measured) {
        return done({ ok: false, error: 'unknown', detail: 'A medição não retornou velocidades válidas de download e upload.' });
      }
      return done(classifyFailure(r.out + r.err));
    }

    this.emit('progress', '[1/3] Medindo ping dos servidores do México e EUA…');
    const cat = await this.run(bin, [...common, '-route-catalog', '-auto-ping'], secrets);
    if (cat.timedOut) return done({ ok: false, error: 'timeout' });
    if (cat.code !== 0) return done(classifyFailure(cat.out + cat.err));

    const routes = normalizeRoutes(lastJson(cat.out)?.routes);
    if (mode === 'catalog') return done({ ok: true, routes });

    // Sem senha daqui em diante: a primeira execução já salvou a sessão
    const chosen = pickLowestPing(routes.filter(r => !exclude.includes(r.server)));

    this.emit('progress', chosen
      ? `[2/3] Melhor: ${chosen.server} (${chosen.city}) · ${chosen.pingMs} ms`
      : '[2/3] Nenhum ping respondeu; usando a escolha automática do Proton…');

    this.emit('progress', '[3/3] Gerando configuração WireGuard…');
    const gen = await this.run(bin, [
      ...common,
      ...device,
      ...(chosen ? ['-server', chosen.server] : ['-auto-ping', ...(exclude.length ? ['-exclude-servers', exclude.join(',')] : [])]),
      '-output', opts.confOut,
    ], secrets);

    if (gen.timedOut) return done({ ok: false, error: 'timeout' });
    if (gen.code === 0 && fs.existsSync(opts.confOut)) {
      this.emit('progress', 'Configuração obtida com sucesso!');
      const generated = chosenFromJson(lastJson(gen.out));
      const final = chosen ?? generated;
      return done({ ok: true, confPath: opts.confOut, routes, ...(final ? { chosen: final } : {}), ...expiresOf(gen.out) });
    }
    done(classifyFailure(gen.out + gen.err));
  }

  cancel(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
