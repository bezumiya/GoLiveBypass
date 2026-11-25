import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as logger from '../../src/main/report/logger';
import { comRegistro, nivelDaMensagem } from '../../src/main/report/ops';
import { montarResumo } from '../../src/main/report/relato-resumo';

beforeEach(() => logger._resetForTests());

describe('comRegistro', () => {
  it('registra ação com resultado e duração, e a falha como erro.exibido', async () => {
    const router = comRegistro(async (canal) => canal === 'tunnel:activate' ? { error: 'helper', detail: 'senha cancelada' } : { ok: true });
    await router('tunnel:activate', undefined);
    await router('proton:logout', undefined);
    const log = logger.getRecent();
    expect(log).toContain('fim de operacao serializada | operation=tunnel:activate resultado=erro');
    expect(log).toContain('erro.exibido | canal=tunnel:activate codigo=helper mensagem=senha cancelada');
    expect(log).toContain('operation=proton:logout resultado=ok');
    const resumo = montarResumo(log, logger.stamp());
    expect(resumo).toContain('tunnel:activate erro');
    expect(resumo).toContain('tunnel:activate (helper): senha cancelada');
  });

  it('ok:false com código vira erro', async () => {
    await comRegistro(async () => ({ ok: false, error: 'app_outdated' }))('proton:fetch', { username: 'u', password: 'segredo' });
    const log = logger.getRecent();
    expect(log).toContain('resultado=erro');
    expect(log).toContain('codigo=app_outdated');
    expect(log).not.toContain('segredo');
  });

  it('lista errors do config:import vira a mensagem da tela', async () => {
    await comRegistro(async () => ({ ok: false, errors: ['O arquivo não tem um bloco [Peer].'], warnings: [] }))('config:import', { rawText: 'x' });
    expect(logger.getRecent()).toContain('erro.exibido | canal=config:import mensagem=O arquivo não tem um bloco [Peer].');
  });

  it('não registra canais de leitura', async () => {
    const inner = vi.fn(async () => ({ ok: false, error: 'x' }));
    await comRegistro(inner)('tunnel:status', undefined);
    expect(inner).toHaveBeenCalled();
    expect(logger.getRecent()).toBe('');
  });

  it('exceção é registrada e repassada', async () => {
    await expect(comRegistro(async () => { throw new Error('boom'); })('tunnel:restart', undefined)).rejects.toThrow('boom');
    expect(logger.getRecent()).toContain('erro.exibido | canal=tunnel:restart mensagem=boom');
  });
});

describe('nivelDaMensagem', () => {
  it('falha vira warn', () => {
    expect(nivelDaMensagem('Falha ao ativar: helper')).toBe('warn');
    expect(nivelDaMensagem('A rota X parou de responder; procurando outra…')).toBe('warn');
    expect(nivelDaMensagem('Rota trocada para BR#1')).toBe('info');
  });
});
