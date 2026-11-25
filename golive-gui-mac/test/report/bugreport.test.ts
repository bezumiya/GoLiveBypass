import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as logger from '../../src/main/report/logger';
import { BUG_API_TOKEN, BUG_API_URL, BUG_BLOCK_STATUS_URL, submitBugReport, type ReportDeps } from '../../src/main/report/bugreport';

const HOME = '/Users/fulano';
let dir: string;

function deps(fetchImpl: ReportDeps['fetch'], over: Partial<ReportDeps> = {}): ReportDeps {
  return { home: HOME, logFile: path.join(dir, 'gui.log'), protonUsername: 'contaproton', meta: { versao: '0.9.0' }, fetch: fetchImpl, ...over };
}

function okFetch() {
  return vi.fn(async (url: any, init?: any) => {
    if (url === BUG_BLOCK_STATUS_URL) return new Response(JSON.stringify({ blocked: false }), { status: 200 });
    return new Response(JSON.stringify({ issue_url: 'https://github.com/bezumiya/GoLiveBypass/issues/1', issue_number: 1 }), { status: 201 });
  });
}

const corpoEnviado = (f: ReturnType<typeof okFetch>) => JSON.parse(f.mock.calls.find(c => c[0] === BUG_API_URL)![1].body);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-report-'));
  logger._resetForTests();
  logger.initLogger(dir);
});

describe('submitBugReport', () => {
  it('exige resumo', async () => {
    const f = okFetch();
    expect(await submitBugReport({ title: '  ', includeLogs: true }, deps(f))).toEqual({ ok: false, error: 'Informe um resumo do problema.' });
    expect(f).not.toHaveBeenCalled();
  });

  it('envia com token, meta e log que abre com o resumo e sai redigido', async () => {
    logger.info('app', 'inicio de operacao serializada', { operation: 'tunnel:activate' });
    logger.warn('tunnel', `ativacao falhou | home=${HOME}/Library conta=contaproton`);
    logger.warn('ui', 'erro.exibido', { canal: 'tunnel:activate', codigo: 'helper', mensagem: 'contaproton@proton.me sem permissão' });
    logger.info('app', 'fim de operacao serializada', { operation: 'tunnel:activate', resultado: 'erro', duracao_ms: 1200 });
    const f = okFetch();
    const r = await submitBugReport({ title: 'falhou para contaproton', description: 'veja', includeLogs: true }, deps(f));
    expect(r).toEqual({ ok: true, issueUrl: 'https://github.com/bezumiya/GoLiveBypass/issues/1', issueNumber: 1 });

    const call = f.mock.calls.find(c => c[0] === BUG_API_URL)!;
    expect(call[1].headers.Authorization).toBe(`Bearer ${BUG_API_TOKEN}`);
    const corpo = corpoEnviado(f);
    expect(corpo.meta).toEqual({ versao: '0.9.0' });
    expect(corpo.log.startsWith('=== resumo ===')).toBe(true);
    expect(corpo.log).toContain('tunnel:activate erro em 1.2s');
    expect(corpo.log).toContain('erros mostrados na tela:');
    expect(corpo.log).toContain('=== sessao macOS (ring buffer) ===');
    const tudo = JSON.stringify(corpo);
    expect(tudo).not.toContain('contaproton');
    expect(tudo).not.toContain('fulano');
    expect(tudo).not.toContain(BUG_API_TOKEN);
  });

  it('sem logs não manda o campo log', async () => {
    logger.info('app', 'qualquer');
    const f = okFetch();
    await submitBugReport({ title: 'x', includeLogs: false }, deps(f));
    expect(corpoEnviado(f).log).toBeUndefined();
  });

  it('respeita o bloqueio consultado antes do envio', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ blocked: true, retry_after: 90 }), { status: 200 }));
    const r = await submitBugReport({ title: 'x', includeLogs: false }, deps(f as any));
    expect(r).toMatchObject({ ok: false, blocked: true, retryAfter: 90 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('429 no envio vira bloqueio com Retry-After', async () => {
    const f = vi.fn(async (url: any) => url === BUG_BLOCK_STATUS_URL
      ? new Response('{}', { status: 500 })
      : new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    expect(await submitBugReport({ title: 'x', includeLogs: false }, deps(f as any))).toMatchObject({ blocked: true, retryAfter: 30 });
  });

  it('falha de rede vira mensagem', async () => {
    const f = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const r = await submitBugReport({ title: 'x', includeLogs: false }, deps(f as any));
    expect(r).toEqual({ ok: false, error: 'Não consegui enviar o report. Verifique sua conexão.' });
  });

  it('lê o gui.log de antes do ring sem repetir a sessão', async () => {
    fs.writeFileSync(path.join(dir, 'gui.log'), '[01/11/2026 - 10:00:00] [warn][app] sessao antiga\n');
    logger.initLogger(dir);
    logger.info('app', 'sessao nova');
    const f = okFetch();
    await submitBugReport({ title: 'x', includeLogs: true }, deps(f));
    const log: string = corpoEnviado(f).log;
    expect(log).toContain('=== gui.log (antes do ring buffer) ===');
    expect(log.match(/sessao nova/g)).toHaveLength(1);
  });
});
