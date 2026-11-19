import { pickLowestPing, type ProtonFetchResult } from '../proton/fetch';
import { buildPhoneConf, PHONE_DEVICE_NAME } from './phone-conf';
import { confToQrDataUrl } from './qr';
import type { PhoneMeta } from '../../shared/types';

export type { PhoneMeta };

export type PhoneError = 'busy' | 'no_routes' | 'probe_failed' | 'auth_failed' | 'app_outdated' | 'timeout' | 'invalid_conf' | 'unknown';

export interface PhoneDeps {
  fetch(opts: { mode: 'catalog' | 'manual'; server?: string; deviceName?: string; confOut: string }): Promise<ProtonFetchResult>;
  tmpPath(): string;
  readFile(p: string): string;
  writeFile(p: string, data: string, mode: number): void;
  rm(p: string): void;
  exists(p: string): boolean;
  saveMeta(m: PhoneMeta): void;
  now(): Date;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  isBusy(): boolean;
  isCloudSynced(p: string): boolean;
}

export const PHONE_CONF_TTL_MS = 300_000;
const PROBE_ATTEMPTS = 3;

type GenerateResult = { ok: true; meta: PhoneMeta; qr?: string } | { ok: false; error: PhoneError };

/**
 * Gera a conf do celular sem tocar na do Mac. A conf com a chave privada vive
 * só aqui, em memória, até o painel fechar, o prazo vencer ou outra geração.
 */
export class PhoneConfService {
  private conf: string | null = null;
  private saved: string[] = [];
  private timer: unknown = null;
  private run = 0;
  private busy = false;

  constructor(private readonly d: PhoneDeps) {}

  get generating(): boolean { return this.busy; }

  async generate(delivery: 'qr' | 'file'): Promise<GenerateResult> {
    if (this.busy || this.d.isBusy()) return { ok: false, error: 'busy' };
    this.clear();
    const run = ++this.run;
    this.busy = true;
    const tmp = this.d.tmpPath();
    try {
      const cat = await this.d.fetch({ mode: 'catalog', confOut: tmp });
      if (run !== this.run) return { ok: false, error: 'unknown' };
      if (!cat.ok) return { ok: false, error: passThrough(cat.error) };
      let left = cat.routes ?? [];
      let best = pickLowestPing(left);
      if (!best) return { ok: false, error: 'no_routes' };

      // Gerar de novo escolheria o mesmo servidor: quem falha no teste dá a vez ao próximo por ping
      let gen: ProtonFetchResult = { ok: false, error: 'unknown' };
      for (let attempt = 0; best && attempt < PROBE_ATTEMPTS; attempt++) {
        gen = await this.d.fetch({ mode: 'manual', server: best.server, deviceName: PHONE_DEVICE_NAME, confOut: tmp });
        if (run !== this.run) return { ok: false, error: 'unknown' };
        // Conta, versão do app recusada e demora não dependem do servidor: trocar de rota não ajuda
        if (gen.ok || isServerIndependent(gen.error)) break;
        const failed = best.server;
        left = left.filter(r => r.server !== failed);
        best = pickLowestPing(left);
      }
      if (!gen.ok) return { ok: false, error: isServerIndependent(gen.error) ? gen.error : 'probe_failed' };
      if (!best) return { ok: false, error: 'probe_failed' };

      const built = buildPhoneConf(this.d.readFile(tmp));
      if (!built.ok) return { ok: false, error: 'invalid_conf' };

      const chosen = gen.chosen ?? best;
      const meta: PhoneMeta = {
        server: chosen.server, country: chosen.country, city: chosen.city,
        ...(gen.expiresAt ? { expiresAt: gen.expiresAt } : {}),
        generatedAt: this.d.now().toISOString(),
      };
      this.conf = built.conf;
      this.timer = this.d.setTimer(() => this.forget(), PHONE_CONF_TTL_MS);
      this.d.saveMeta(meta);
      return delivery === 'qr' ? { ok: true, meta, qr: confToQrDataUrl(built.conf) } : { ok: true, meta };
    } catch {
      return { ok: false, error: 'unknown' };
    } finally {
      if (this.d.exists(tmp)) this.d.rm(tmp);
      this.busy = false;
    }
  }

  saveTo(path: string): { ok: true } | { ok: false; error: 'no_conf' | 'cloud_folder' } {
    if (!this.conf) return { ok: false, error: 'no_conf' };
    if (this.d.isCloudSynced(path)) return { ok: false, error: 'cloud_folder' };
    this.d.writeFile(path, this.conf, 0o600);
    if (!this.saved.includes(path)) this.saved.push(path);
    return { ok: true };
  }

  /** Todo .conf salvo nesta sessão, de qualquer geração: cada um tem uma chave. */
  savedPaths(): string[] { return [...this.saved]; }

  deleteSaved(): boolean {
    if (!this.saved.length) return false;
    for (const p of this.saved) if (this.d.exists(p)) this.d.rm(p);
    this.saved = [];
    return true;
  }

  /**
   * Painel fechado: descarta a conf e o resultado de uma geração em andamento.
   * O bloqueio só sai quando o proton-confgen dela terminar: dois processos
   * não podem disputar a mesma sessão salva.
   */
  clear(): void {
    this.run++;
    this.forget();
  }

  private forget(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
    this.conf = null;
  }
}

/** Falhas que não dependem do servidor escolhido e chegam ao painel como vieram. */
function isServerIndependent(e: ProtonFetchResult['error']): e is 'auth_failed' | 'app_outdated' | 'timeout' {
  return e === 'auth_failed' || e === 'app_outdated' || e === 'timeout';
}

function passThrough(e: ProtonFetchResult['error']): PhoneError {
  return isServerIndependent(e) ? e : 'unknown';
}
