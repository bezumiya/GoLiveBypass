import { describe, expect, it } from "vitest";
import { runningImageNames, waitForCondition, waitForProcessRunning, waitForProcessStopped, whenProcessStops } from "../electron/wait-condition";

describe("espera de lifecycle", () => {
  it("retorna assim que o recurso encerra", async () => {
    let calls = 0;
    const stopped = await waitForCondition(() => ++calls >= 3, {
      attempts: 10,
      delayMs: 1,
      sleep: async () => {},
    });
    expect(stopped).toBe(true);
    expect(calls).toBe(3);
  });

  it("expira de forma deterministica quando a sessao antiga nunca encerra", async () => {
    let calls = 0;
    let sleeps = 0;
    const stopped = await waitForCondition(() => {
      calls++;
      return false;
    }, {
      attempts: 4,
      delayMs: 1,
      sleep: async () => { sleeps++; },
    });
    expect(stopped).toBe(false);
    expect(sleeps).toBe(4);
    expect(calls).toBe(5);
  });

  it("nao aceita falha de sondagem como processo encerrado", async () => {
    let calls = 0;
    const stopped = await waitForProcessStopped(() => {
      calls++;
      return calls < 3 ? "unknown" : "stopped";
    }, { attempts: 4, delayMs: 1, sleep: async () => {} });
    expect(stopped).toBe(true);
    expect(calls).toBe(3);
  });

  it("expira quando a unica resposta e desconhecida", async () => {
    const stopped = await waitForProcessStopped(() => "unknown", {
      attempts: 3,
      delayMs: 1,
      sleep: async () => {},
    });
    expect(stopped).toBe(false);
  });

  it("nao confirma inicio por uma sondagem desconhecida", async () => {
    let calls = 0;
    const running = await waitForProcessRunning(() => {
      calls++;
      return calls === 3 ? "running" : "unknown";
    }, { attempts: 4, delayMs: 1, sleep: async () => {} });
    expect(running).toBe(true);
    expect(calls).toBe(3);
  });

  it("le os nomes de imagem do tasklist em CSV sem casar por substring", () => {
    const csv = [
      '"System Idle Process","0","Services","0","8 K"',
      '"Discord.exe","1824","Console","1","150.000 K"',
      '"DiscordHelper.exe","999","Console","1","1.000 K"',
      "INFO: No tasks are running which match the specified criteria.",
      "",
    ].join("\r\n");
    const names = runningImageNames(csv);
    expect(names.has("discord.exe")).toBe(true);
    expect(names.has("discordhelper.exe")).toBe(true);
    expect(names.has("discordcanary.exe")).toBe(false);
    expect(names.size).toBe(3);
  });

  it("dispara uma vez so quando o processo encerra, ignorando sondas falhas", async () => {
    const states = ["running", "unknown", "running", "stopped", "stopped"] as const;
    let i = 0;
    const ticks: Array<() => Promise<void>> = [];
    let fired = 0;
    const cancel = whenProcessStops(async () => states[i++], () => { fired++; }, {
      schedule: (tick) => { ticks.push(tick); return () => {}; },
    });
    for (let n = 0; n < 3; n++) await ticks[0]();
    expect(fired).toBe(0);
    await ticks[0]();
    expect(fired).toBe(1);
    await ticks[0]();
    expect(fired).toBe(1);
    cancel();
  });

  it("nao dispara depois de cancelado", async () => {
    const ticks: Array<() => Promise<void>> = [];
    let fired = 0;
    const cancel = whenProcessStops(async () => "stopped", () => { fired++; }, {
      schedule: (tick) => { ticks.push(tick); return () => {}; },
    });
    cancel();
    await ticks[0]();
    expect(fired).toBe(0);
  });
});
