// Watchdog do Tor embutido: vigia o daemon da porta 9060 durante uma sessao de modo tor.
//
// Por que existe: em modo tor o Tor na 9060 e a UNICA saida. Se o daemon morre ou trava no
// meio da sessao (rede do ISP, sleep, wi-fi), nada o vigia: o log mostra tunel.falha para
// sempre e o Discord fica no "carregando infinito" por horas (issues #49 e #51).
//
// Este modulo e PURO (sem Electron, sem rede, sem fx): so decide, dado o estado, se a acao
// e "ok", "restart" (matar e ressuscitar o daemon) ou "ignore". Quem executa e o main.ts,
// que injeta as probes (portaViva / torEntregando) — testavel com vitest sem mock de app.

export type TorWatchdogAction = "ok" | "restart" | "ignore";

export interface TorWatchdogProbes {
  /** Probe barato de TCP na porta (a porta aceita conexao?). */
  portaViva: (porta: number) => Promise<boolean>;
  /** Probe caro de tunel SOCKS ate o gateway (a porta realmente entrega?). */
  torEntregando: (porta: number, timeoutMs?: number) => Promise<boolean>;
}

/** Quantas falhas seguidas fazem o watchdog reiniciar o daemon (2: nao age por um timeout so). */
export const TOR_WATCHDOG_FAIL_LIMIT = 2;
/** A cada quanto o watchdog roda, em ms. */
export const TOR_WATCHDOG_MS = 30_000;
/** Timeout curto do probe de tunel dentro do watchdog (a sessao nao pode ficar 20s presa). */
export const TOR_WATCHDOG_PROBE_TIMEOUT_MS = 2_000;

export interface TorWatchdogState {
  /** A sessao atual esta no modo tor com bypass ativo? Se nao, nada a vigiar. */
  active: boolean;
  /** Falhas seguidas do probe. Zera quando o Tor volta a entregar. */
  failStreak: number;
  /** Porta em uso (padrao 9060). */
  porta: number;
}

export function createTorWatchdog(
  probes: TorWatchdogProbes,
  initialState: TorWatchdogState = { active: false, failStreak: 0, porta: 9060 },
) {
  let state: TorWatchdogState = { ...initialState };

  /** Seta se a sessao esta ativa (chamado pela GUI ao ativar/desativar). */
  function setActive(active: boolean): void {
    state.active = active;
    // Desativa zera a sequencia de falhas: um problema da sessao anterior nao conta aqui.
    if (!active) state.failStreak = 0;
  }

  /** Roda uma checagem e devolve a acao. Nao muta nada alem do contador interno. */
  async function check(): Promise<TorWatchdogAction> {
    if (!state.active) return "ignore";

    let alive = false;
    try {
      alive = await probes.portaViva(state.porta);
    } catch {
      alive = false;
    }

    if (alive) {
      // A porta atende, mas o proxy pode estar morto (cenario #49: porta aberta, tunel
      // timeout). So quem entrega de verdade conta como saudavel.
      try {
        alive = await probes.torEntregando(state.porta, TOR_WATCHDOG_PROBE_TIMEOUT_MS);
      } catch {
        alive = false;
      }
    }

    if (alive) {
      state.failStreak = 0;
      return "ok";
    }

    state.failStreak += 1;
    if (state.failStreak >= TOR_WATCHDOG_FAIL_LIMIT) {
      state.failStreak = 0;
      return "restart";
    }
    return "ok"; // primeira falha: ainda nao age (o Tor pode se recuperar sozinho)
  }

  return { check, setActive, getState: () => ({ ...state }) };
}

export type TorWatchdog = ReturnType<typeof createTorWatchdog>;
