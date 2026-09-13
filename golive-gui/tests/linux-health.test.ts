import { describe, expect, it } from "vitest";
import { classifyLinuxHealth } from "../electron/linux-health";

const base = {
  netns: true,
  discordInNamespace: true,
  wg: { ok: true, handshakeAgoS: 10, rxBytes: 100, txBytes: 200 },
  probeReady: true,
};

describe("saúde do túnel Linux", () => {
  it("classifica saúde para diagnóstico, inclusive telemetria ausente", () => {
    expect(classifyLinuxHealth(base).healthy).toBe(true);
    expect(classifyLinuxHealth({ ...base, discordInNamespace: false }).reason).toMatch(/Discord/);
    expect(classifyLinuxHealth({ ...base, probeReady: false }).reason).toMatch(/gateway/);
    expect(classifyLinuxHealth({ ...base, wg: { ...base.wg, handshakeAgoS: 181 } }).healthy).toBe(false);
  });

  it("sem privilégio para a telemetria, aproveita o probe já coletado", () => {
    const semTelemetria = { ...base, wg: { ...base.wg, ok: false } };
    const comProbe = classifyLinuxHealth({ ...semTelemetria, probeReady: true });
    const semProbe = classifyLinuxHealth({ ...semTelemetria, probeReady: false });
    // O booleano não muda: nos dois casos o watchdog continua só logando.
    expect(comProbe.healthy).toBe(false);
    expect(semProbe.healthy).toBe(false);
    expect(comProbe.reason).toMatch(/telemetria WireGuard indisponível/);
    expect(comProbe.reason).toMatch(/acessível/);
    expect(semProbe.reason).toMatch(/gateway Discord inacessível/);
    expect(semProbe.reason).not.toBe(comProbe.reason);
  });

});
