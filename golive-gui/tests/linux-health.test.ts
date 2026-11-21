import { describe, expect, it } from "vitest";
import { classifyLinuxHealth, criarRegistroDeDiagnostico } from "../electron/linux-health";

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

});

describe("limite do diagnóstico no log", () => {
  it("oscilação falha/sucesso registra um aviso e uma volta ao normal", () => {
    let agora = 0;
    const registro = criarRegistroDeDiagnostico({ intervaloMs: 5 * 60_000, agora: () => agora });
    expect(registro.falhou("sem telemetria")).toEqual({ falhas: 1 });
    agora += 15_000;
    expect(registro.falhou("sem telemetria")).toBeNull();
    agora += 15_000;
    expect(registro.saudavel()).toEqual({ falhasAntes: 2 });
    agora += 15_000;
    expect(registro.falhou("sem telemetria")).toBeNull();
    agora += 15_000;
    expect(registro.saudavel()).toBeNull();
  });

  it("mesmo motivo volta a cada 5 min; motivo novo entra na hora", () => {
    let agora = 0;
    const registro = criarRegistroDeDiagnostico({ intervaloMs: 5 * 60_000, agora: () => agora });
    expect(registro.falhou("A")).toEqual({ falhas: 1 });
    agora += 4 * 60_000;
    expect(registro.falhou("A")).toBeNull();
    agora += 60_000;
    expect(registro.falhou("A")).toEqual({ falhas: 3 });
    agora += 1000;
    expect(registro.falhou("B")).toEqual({ falhas: 4 });
    expect(registro.saudavel()).toEqual({ falhasAntes: 4 });
  });
});
