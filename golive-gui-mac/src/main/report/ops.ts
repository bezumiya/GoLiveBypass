// Registro das acoes da janela no log, no formato que o resumo do relato le (relato-resumo.ts):
// "inicio/fim de operacao serializada" com resultado e duracao, e "erro.exibido" com o que a
// pessoa viu na tela. Mesma ideia do wrapper de ipcMain.handle da GUI Windows/Linux.

import * as logger from './logger';
import { descreverFalhaDaTela, resultadoDaOperacao } from './relato-resumo';

// Canais de acao (a pessoa clicou). Leituras (status, routes, settings:get...) ficam fora:
// devolvem "sem sessao" e afins como resultado normal e so encheriam a lista.
export const CANAIS_DE_ACAO = new Set([
  'config:import', 'tunnel:activate', 'tunnel:deactivate', 'tunnel:restart', 'tunnel:restoreNetwork',
  'proton:fetch', 'proton:logout', 'vencord:retry', 'vencord:setOptIn',
  'app:downloadUpdate', 'phone:generate', 'phone:save',
]);

// O Mac devolve { error: 'codigo', detail } sem ok:false em varias acoes do tunel.
function normalizar(valor: unknown): unknown {
  if (!valor || typeof valor !== 'object') return valor;
  const r = valor as Record<string, unknown>;
  if (typeof r.error === 'string' && r.ok === undefined && r.success === undefined) {
    return { ok: false, code: r.error, error: typeof r.detail === 'string' && r.detail ? r.detail : r.error };
  }
  if (r.ok === false && typeof r.error === 'string') {
    return { ...r, code: r.error, error: typeof r.detail === 'string' && r.detail ? r.detail : r.error };
  }
  return valor;
}

function registrarFalha(canal: string, valor: unknown) {
  const falha = descreverFalhaDaTela(valor);
  if (!falha) return;
  logger.warn('ui', 'erro.exibido', {
    canal,
    ...(falha.codigo ? { codigo: falha.codigo } : {}),
    mensagem: logger.redactLogValue(falha.mensagem, 'mensagem'),
  });
}

export function comRegistro(router: (canal: string, payload: any) => Promise<unknown>) {
  return async (canal: string, payload: any): Promise<unknown> => {
    if (!CANAIS_DE_ACAO.has(canal)) return router(canal, payload);
    logger.info('app', 'inicio de operacao serializada', { operation: canal });
    const inicio = Date.now();
    let resultado = 'ok';
    try {
      const valor = await router(canal, payload);
      const normal = normalizar(valor);
      resultado = resultadoDaOperacao(normal);
      registrarFalha(canal, normal);
      return valor;
    } catch (error) {
      resultado = 'erro';
      registrarFalha(canal, error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      logger.info('app', 'fim de operacao serializada', { operation: canal, resultado, duracao_ms: Date.now() - inicio });
    }
  };
}

// Mensagens do painel de log (sendToWindow('log', ...)): falha vira warn para o resumo pegar.
export function nivelDaMensagem(msg: string): logger.Nivel {
  return /\b(falh|não deu|nao deu|erro|parou de responder|não responde)/i.test(msg) ? 'warn' : 'info';
}
