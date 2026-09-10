import { describe, expect, it } from 'vitest';
import {
  hasValidManualRoutePing,
  isManualRouteActionable,
  isManualRouteSelectable,
  recommendManualRoute,
  reduceManualRouteEvent,
  sortManualRouteCandidates,
  type ManualRouteCandidate,
} from '../src/proton-manual-selection';

function candidate(
  server: string,
  pingMs?: number,
  pingStatus: ManualRouteCandidate['pingStatus'] = pingMs && pingMs > 0 && pingMs < 999
    ? 'success'
    : 'failed',
  overrides: Partial<ManualRouteCandidate> = {},
): ManualRouteCandidate {
  return {
    server,
    pingMs,
    pingStatus,
    preflightStatus: 'not-tested',
    speedStatus: 'not-tested',
    ...overrides,
  };
}

describe('agregado de seleção manual de rotas Proton', () => {
  it('agrega ping, preflight e velocidade na mesma rota', () => {
    let state = new Map<string, ManualRouteCandidate>();
    state = reduceManualRouteEvent(state, {
      phase: 'ping',
      server: 'US#8',
      pingMs: 188,
      status: 'success',
    });
    state = reduceManualRouteEvent(state, {
      phase: 'preparing',
      server: 'US#8',
      status: 'success',
    });
    state = reduceManualRouteEvent(state, {
      phase: 'testing',
      server: 'US#8',
      pingMs: 188,
      downloadMbps: 42.5,
      uploadMbps: 8.2,
      status: 'success',
    });

    expect(state.get('US#8')).toMatchObject({
      server: 'US#8',
      pingMs: 188,
      pingStatus: 'success',
      preflightStatus: 'success',
      speedStatus: 'success',
      downloadMbps: 42.5,
      uploadMbps: 8.2,
    });
  });

  it('preserva métricas quando a atualização posterior não as contém', () => {
    let state = new Map<string, ManualRouteCandidate>();
    state = reduceManualRouteEvent(state, {
      phase: 'testing',
      server: 'US#8',
      pingMs: 188,
      downloadMbps: 42.5,
      uploadMbps: 8.2,
      status: 'success',
    });
    state = reduceManualRouteEvent(state, {
      phase: 'preparing',
      server: 'US#8',
      status: 'success',
    });

    expect(state.get('US#8')).toMatchObject({
      pingMs: 188,
      downloadMbps: 42.5,
      uploadMbps: 8.2,
      speedStatus: 'success',
    });
  });

  it('ignora eventos sem servidor e números não positivos', () => {
    const initial = new Map<string, ManualRouteCandidate>([
      ['US#8', candidate('US#8', 188)],
    ]);

    const withoutServer = reduceManualRouteEvent(initial, {
      phase: 'ping',
      pingMs: 120,
      status: 'success',
    });
    const withInvalidMetrics = reduceManualRouteEvent(withoutServer, {
      phase: 'testing',
      server: 'US#8',
      pingMs: 0,
      downloadMbps: -10,
      uploadMbps: Number.NaN,
      status: 'success',
    });

    expect(withoutServer).toEqual(initial);
    const route = withInvalidMetrics.get('US#8');
    expect(route).toMatchObject({ pingMs: 188 });
    expect(route).not.toHaveProperty('downloadMbps');
    expect(route).not.toHaveProperty('uploadMbps');
  });

  it('mantém o estado independente por fase quando a rota falha no preflight', () => {
    let state = new Map<string, ManualRouteCandidate>();
    state = reduceManualRouteEvent(state, {
      phase: 'ping',
      server: 'US#72',
      pingMs: 205,
      status: 'success',
    });
    state = reduceManualRouteEvent(state, {
      phase: 'preparing',
      server: 'US#72',
      status: 'failed',
    });

    const route = state.get('US#72');
    expect(route).toMatchObject({
      pingStatus: 'success',
      preflightStatus: 'failed',
      speedStatus: 'not-tested',
    });
    expect(route && isManualRouteSelectable(route)).toBe(false);
  });

  it('permite ping válido ainda sem preflight concluído', () => {
    const route = candidate('US#8', 188);

    expect(hasValidManualRoutePing(route)).toBe(true);
    expect(isManualRouteSelectable(route)).toBe(true);
    expect(hasValidManualRoutePing(candidate('US#8', undefined))).toBe(false);
    expect(hasValidManualRoutePing(candidate('US#8', 999))).toBe(false);
    expect(hasValidManualRoutePing(candidate('US#8', 188, 'failed'))).toBe(false);
    expect(isManualRouteSelectable(candidate('US#8', undefined))).toBe(false);
    expect(isManualRouteSelectable(candidate('US#8', 999))).toBe(false);
  });
  it('permite ação para rota catalogada sem ping e mantém recomendação medida', () => {
    const cataloged = candidate('NL#2', undefined, 'not-tested');
    expect(isManualRouteActionable(cataloged)).toBe(true);
    expect(isManualRouteSelectable(cataloged)).toBe(false);
    expect(isManualRouteActionable({ ...cataloged, pingStatus: 'failed' })).toBe(false);
    expect(isManualRouteActionable({ ...cataloged, preflightStatus: 'failed' })).toBe(false);
    expect(recommendManualRoute([cataloged])).toBeUndefined();
  });

  it('ordena ping válido crescente e deixa desconhecidos no fim', () => {
    const state = new Map([
      ['US#8', candidate('US#8', 188)],
      ['US#5', candidate('US#5', 197)],
      ['US#50', candidate('US#50', 198)],
      ['US#72', candidate('US#72', undefined, 'failed')],
      ['US#99', candidate('US#99', 999, 'success')],
    ]);

    expect(sortManualRouteCandidates(state.values()).map((route) => route.server))
      .toEqual(['US#8', 'US#5', 'US#50', 'US#72', 'US#99']);
  });

  it('resolve empates de ping pelo nome da rota', () => {
    const routes = [
      candidate('US#20', 150),
      candidate('us#10', 150),
      candidate('DE#1', 150),
    ];

    expect(sortManualRouteCandidates(routes).map((route) => route.server))
      .toEqual(['DE#1', 'us#10', 'US#20']);
  });

  it('recomenda a maior capacidade harmônica entre velocidades completas', () => {
    const routes = [
      candidate('US#8', 188, 'success', {
        downloadMbps: 80,
        uploadMbps: 10,
        speedStatus: 'success',
      }),
      candidate('US#5', 197, 'success', {
        downloadMbps: 42.5,
        uploadMbps: 8.2,
        speedStatus: 'success',
      }),
      candidate('US#50', 198, 'success', {
        downloadMbps: 50,
        uploadMbps: 50,
        speedStatus: 'success',
      }),
    ];

    expect(recommendManualRoute(routes)).toBe('US#50');
  });

  it('usa menor ping quando não há velocidade completa', () => {
    const routes = [
      candidate('US#8', 188, 'success', { downloadMbps: 42.5 }),
      candidate('US#5', 197),
      candidate('US#50', 198, 'success', {
        downloadMbps: 50,
        uploadMbps: 0,
        speedStatus: 'failed',
      }),
    ];

    expect(recommendManualRoute(routes)).toBe('US#8');
  });

  it('não recomenda uma rota explicitamente reprovada no preflight', () => {
    const routes = [
      candidate('US#8', 188, 'success', {
        downloadMbps: 100,
        uploadMbps: 100,
        speedStatus: 'success',
        preflightStatus: 'failed',
      }),
      candidate('US#5', 197),
    ];

    expect(recommendManualRoute(routes)).toBe('US#5');
  });

  it('retorna indefinido quando nenhuma rota é elegível', () => {
    expect(recommendManualRoute([
      candidate('US#72', undefined),
      candidate('US#99', 205, 'success', { preflightStatus: 'failed' }),
    ])).toBeUndefined();
  });
});
