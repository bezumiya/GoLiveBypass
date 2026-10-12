export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 40));
  const delayMs = Math.max(0, options.delayMs ?? 250);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await condition()) return true;
    await sleep(delayMs);
  }
  return await condition();
}

export type ProcessProbeState = "running" | "stopped" | "unknown";
export type ProcessProbe = () => ProcessProbeState | Promise<ProcessProbeState>;

// Falha de observacao nao e prova de encerramento. Em particular, tasklist/pgrep pode
// falhar transitoriamente enquanto o processo continua segurando a rota anterior.
export async function waitForProcessStopped(
  probe: ProcessProbe,
  options: Parameters<typeof waitForCondition>[1] = {},
): Promise<boolean> {
  return waitForCondition(async () => (await probe()) === "stopped", options);
}

export async function waitForProcessRunning(
  probe: ProcessProbe,
  options: Parameters<typeof waitForCondition>[1] = {},
): Promise<boolean> {
  return waitForCondition(async () => (await probe()) === "running", options);
}

// Nomes de imagem (minusculos) da saida de `tasklist /FO CSV /NH`: a 1a coluna de cada linha.
export function runningImageNames(tasklistCsv: string): Set<string> {
  const names = new Set<string>();
  for (const line of tasklistCsv.split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line);
    if (match) names.add(match[1].toLowerCase());
  }
  return names;
}

// Chama onStopped uma unica vez quando a sonda confirmar "stopped" ("unknown" nao conta).
// Retorna o cancelamento. Sem polling sobreposto: um tick lento nao empilha outro.
export function whenProcessStops(
  probe: ProcessProbe,
  onStopped: () => void,
  options: { intervalMs?: number; schedule?: (tick: () => Promise<void>) => () => void } = {},
): () => void {
  let done = false;
  let busy = false;
  const tick = async () => {
    if (done || busy) return;
    busy = true;
    try {
      if ((await probe()) === "stopped" && !done) {
        done = true;
        stop();
        onStopped();
      }
    } catch {
      // sonda falhou: tenta de novo no proximo tick
    } finally {
      busy = false;
    }
  };
  const schedule = options.schedule ?? ((fn) => {
    const timer = setInterval(() => void fn(), options.intervalMs ?? 5_000);
    return () => clearInterval(timer);
  });
  const stop = schedule(tick);
  return () => {
    done = true;
    stop();
  };
}
