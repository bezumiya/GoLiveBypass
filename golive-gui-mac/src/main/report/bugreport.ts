// Relato de bug do macOS: mesmo cliente da GUI Windows/Linux (golive-gui/electron/bugreport.ts),
// mesma API (https://bugs.golivebypass.dev/bugs/v1/reports) e mesmas garantias de privacidade:
//   L1 - padroes regex (credenciais em URL, headers de auth, tokens, e-mail, home do usuario)
//   L2 - ocorrencias literais do home e da conta Proton salva
//   L3 - varredura final: segredo sobrevivente = NADA sai da maquina
// O log vem do gui.log (~/Library/Logs/GoLiveBypass) e do ring do logger, com o resumo no topo.

import * as fs from 'fs';
import * as path from 'path';
import * as logger from './logger';
import { montarResumo } from './relato-resumo';
import { cortarDoFim, redigir, segredosRemanescentes, type SegredosConhecidos } from './redact';

export const BUG_API_URL = 'https://bugs.golivebypass.dev/bugs/v1/reports';
export const BUG_BLOCK_STATUS_URL = 'https://bugs.golivebypass.dev/bugs/v1/block-status';
// Token compartilhado da API de bugs (o mesmo da GUI). Extraivel por design (app distribuido);
// o escopo dele e so criar issue num repo publico, com rate limit por IP.
export const BUG_API_TOKEN = 'c3d0bff691ecc3ddc6f6ca10037b9ac967c62547e681d3749204e50800504511';

const LOG_TAIL_BYTES = 96 * 1024;
const LOG_TOTAL_MAX = 240 * 1024;
// O GitHub recusa body > 64KB e a API corta o log no meio: o log ja sai dentro desse orcamento,
// com prioridade para o fim da sessao atual (mesma conta da GUI, #379/#399).
const LOG_ISSUE_MAX = 52 * 1024;
const LOG_GUI_ANTERIOR_MAX = 8 * 1024;
const LOG_RESUMO_FONTE_BYTES = 512 * 1024;
const DESC_MAX = 8 * 1024;
const TITLE_MAX = 200;

export interface ReportPayload { title: string; description?: string; includeLogs: boolean }

export interface ReportResult {
  ok: boolean;
  issueUrl?: string;
  issueNumber?: number;
  error?: string;
  blocked?: boolean;
  retryAfter?: number;
}

export interface ReportDeps {
  home: string;
  logFile: string;
  /** Conta Proton salva (so para a redacao local; nunca entra no payload). */
  protonUsername: string | null;
  meta: Record<string, string>;
  fetch: typeof fetch;
}

export function lerCauda(file: string, maxBytes = LOG_TAIL_BYTES): string {
  try {
    const buf = fs.readFileSync(file);
    const pedaco = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
    let texto = pedaco.toString('utf8');
    if (pedaco.length < buf.length) texto = texto.slice(texto.indexOf('\n') + 1); // linha partida fora
    return texto;
  } catch {
    return '';
  }
}

export function coletarSegredos(home: string, protonUsername: string | null): SegredosConhecidos {
  const segredos = [home, path.basename(home), protonUsername?.trim() ?? ''];
  return [...new Set(segredos.filter(s => s.length >= 3))];
}

/** Bloco de log do relato (resumo + ring + gui.log anterior ao ring), ja redigido. */
export function montarLog(logFile: string, segredos: SegredosConhecidos, tokenApi: string): string {
  const recente = logger.getRecent();

  // O gui.log complementa o ring: so interessa o que VEIO ANTES da primeira linha do ring.
  const anteriores: string[] = [];
  let complemento = '';
  const guiLog = lerCauda(logFile);
  if (guiLog) {
    const primeiraDoRing = recente.split('\n').find(l => l.trim() !== '');
    const inicio = primeiraDoRing ? guiLog.indexOf(logger.semRepeticao(primeiraDoRing)) : -1;
    complemento = inicio >= 0 ? guiLog.slice(0, inicio) : guiLog;
    if (complemento.trim()) {
      anteriores.push('=== gui.log (antes do ring buffer) ===');
      anteriores.push(cortarDoFim(complemento.trimEnd(), LOG_GUI_ANTERIOR_MAX));
    }
  }

  // O resumo abre o relato e nunca e cortado; le uma cauda bem maior do gui.log que a do corpo.
  const fonteResumo = lerCauda(logFile, LOG_RESUMO_FONTE_BYTES) || `${complemento}\n${recente}`;
  const resumo = montarResumo(fonteResumo, logger.stamp());

  const titulo = '=== sessao macOS (ring buffer) ===';
  const resto = [resumo, ...anteriores].join('\n');
  const cotaRing = Math.max(8 * 1024, LOG_ISSUE_MAX - Buffer.byteLength(resto, 'utf8') - titulo.length - 2);
  return redigir([resumo, titulo, cortarDoFim(recente, cotaRing), ...anteriores].join('\n'), segredos, tokenApi);
}

const bloqueado = (retryAfter: number): ReportResult => ({
  ok: false,
  blocked: true,
  retryAfter,
  error: `Você está bloqueado por enviar reports em excesso. Tente de novo em ${retryAfter}s.`,
});

export async function submitBugReport(payload: ReportPayload, d: ReportDeps): Promise<ReportResult> {
  const title = payload.title.trim().slice(0, TITLE_MAX);
  if (!title) return { ok: false, error: 'Informe um resumo do problema.' };

  // Titulo e descricao tambem passam pela redacao, mesmo sem anexar logs.
  const segredos = coletarSegredos(d.home, d.protonUsername);
  const corpo: { title: string; description: string; log?: string; meta: Record<string, string> } = {
    title: redigir(title, segredos, BUG_API_TOKEN),
    description: redigir((payload.description ?? '').slice(0, DESC_MAX), segredos, BUG_API_TOKEN),
    meta: d.meta,
  };
  if (payload.includeLogs) corpo.log = cortarDoFim(montarLog(d.logFile, segredos, BUG_API_TOKEN), LOG_TOTAL_MAX);

  // L3 — ultima barreira: se algum segredo conhecido sobreviveu, nada sai daqui.
  if (segredosRemanescentes(JSON.stringify(corpo), segredos, BUG_API_TOKEN).length > 0) {
    logger.error('report', 'envio bloqueado: segredo remanescente no payload');
    return { ok: false, error: 'Envio bloqueado por segurança: um dado sensível apareceu no relato. O report NÃO foi enviado.' };
  }

  try {
    const block = await consultarBlockStatus(d.fetch);
    if (block.blocked) {
      logger.warn('report', 'bloqueado por rate limit antes do envio', { retry_after: block.retryAfter });
      return bloqueado(block.retryAfter);
    }

    const res = await d.fetch(BUG_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BUG_API_TOKEN}` },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 201) {
      const data = (await res.json()) as { issue_url?: string; issue_number?: number };
      logger.info('report', 'enviado', { issue: data.issue_number });
      return { ok: true, issueUrl: data.issue_url, issueNumber: data.issue_number };
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? 60) || 60;
      logger.warn('report', 'bloqueado por rate limit no envio', { retry_after: retryAfter });
      return bloqueado(retryAfter);
    }
    if (res.status === 401) return { ok: false, error: 'Autenticação recusada pelo servidor.' };
    if (res.status === 413) return { ok: false, error: 'Report grande demais. Tente sem os logs.' };
    logger.error('report', 'servidor recusou', { status: res.status });
    return { ok: false, error: `O servidor recusou o report (HTTP ${res.status}).` };
  } catch (err) {
    const e = err as Error;
    logger.warn('report', 'falha de rede no envio', { erro: e.message });
    const offline = e.name === 'TimeoutError' || e.name === 'AbortError';
    return {
      ok: false,
      error: offline
        ? 'Sem resposta do servidor (rede/timeout). Verifique sua conexão.'
        : 'Não consegui enviar o report. Verifique sua conexão.',
    };
  }
}

// GET /v1/block-status. Falha na consulta = nao bloqueado; o POST da o veredito (429 cobre).
async function consultarBlockStatus(f: typeof fetch): Promise<{ blocked: boolean; retryAfter: number }> {
  try {
    const res = await f(BUG_BLOCK_STATUS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${BUG_API_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status !== 200) return { blocked: false, retryAfter: 0 };
    const data = (await res.json()) as { blocked?: boolean; retry_after?: number };
    return { blocked: data.blocked === true, retryAfter: Math.max(1, Math.round(data.retry_after ?? 0)) };
  } catch {
    return { blocked: false, retryAfter: 0 };
  }
}
