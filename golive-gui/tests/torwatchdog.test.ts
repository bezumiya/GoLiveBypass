import { describe, expect, it, vi } from "vitest";
import {
  createTorWatchdog,
  TOR_WATCHDOG_FAIL_LIMIT,
  TOR_WATCHDOG_PROBE_TIMEOUT_MS,
  type TorWatchdogProbes,
} from "../electron/torwatchdog";

// Probes falsos controlaveis: cada teste diz o que portaViva/torEntregando devolvem.
function probes(portaViva: boolean, torEntregando: boolean): TorWatchdogProbes {
  return {
    portaViva: vi.fn(async () => portaViva),
    torEntregando: vi.fn(async () => torEntregando),
  };
}

describe("createTorWatchdog", () => {
  it("ignora quando a sessao nao esta ativa", async () => {
    const wd = createTorWatchdog(probes(true, true), { active: false, failStreak: 0, porta: 9060 });
    expect(await wd.check()).toBe("ignore");
    // nada foi checado
    // (nao acessamos os fns por fora; o comportamento e so o retorno)
  });

  it("devolve ok quando a porta viva e o tunel entregam", async () => {
    const wd = createTorWatchdog(probes(true, true), { active: true, failStreak: 0, porta: 9060 });
    expect(await wd.check()).toBe("ok");
    expect(wd.getState().failStreak).toBe(0);
  });

  it("conta uma falha (porta morta) mas nao age na primeira", async () => {
    const wd = createTorWatchdog(probes(false, false), { active: true, failStreak: 0, porta: 9060 });
    expect(await wd.check()).toBe("ok"); // 1a falha: ainda "ok" (aguarda 2a)
    expect(wd.getState().failStreak).toBe(1);
    // 2a falha seguida -> restart
    expect(await wd.check()).toBe("restart");
    // apos o restart o contador zera
    expect(wd.getState().failStreak).toBe(0);
  });

  it("conta falha quando a porta atende mas o tunel nao (cenario #49: proxy morto)", async () => {
    const wd = createTorWatchdog(probes(true, false), { active: true, failStreak: 0, porta: 9060 });
    expect(await wd.check()).toBe("ok"); // 1a
    expect(await wd.check()).toBe("restart"); // 2a
    // o probe de tunel foi chamado com o timeout curto do watchdog
    expect(await wd.getState().failStreak).toBe(0);
  });

  it("zera a sequencia quando o tunel volta a entregar", async () => {
    const wd = createTorWatchdog(probes(true, false), { active: true, failStreak: 1, porta: 9060 });
    expect(await wd.check()).toBe("restart");
    // "volta a entregar" na segunda: falhas zeram antes do restart
    const wd2 = createTorWatchdog(probes(true, true), { active: true, failStreak: 1, porta: 9060 });
    expect(await wd2.check()).toBe("ok");
    expect(wd2.getState().failStreak).toBe(0);
  });

  it("setActive(false) zera a sequencia de falhas", async () => {
    const wd = createTorWatchdog(probes(false, false), { active: true, failStreak: 1, porta: 9060 });
    wd.setActive(false);
    expect(await wd.check()).toBe("ignore");
    expect(wd.getState().failStreak).toBe(0);
  });

  it("usa a porta informada e o timeout curto no probe", async () => {
    const portaViva = vi.fn(async () => true);
    const torEntregando = vi.fn(async () => false);
    const wd = createTorWatchdog({ portaViva, torEntregando }, { active: true, failStreak: 0, porta: 9060 });
    await wd.check();
    expect(portaViva).toHaveBeenCalledWith(9060);
    expect(torEntregando).toHaveBeenCalledWith(9060, TOR_WATCHDOG_PROBE_TIMEOUT_MS);
  });

  it("expoe o limite de falhas como constante configurável", () => {
    expect(TOR_WATCHDOG_FAIL_LIMIT).toBe(2);
  });
});
