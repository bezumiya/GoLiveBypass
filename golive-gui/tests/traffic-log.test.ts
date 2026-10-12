import { describe, expect, it } from "vitest";
import { parseNetshInterfaceBytes, parsePingMs, trafficSample } from "../electron/wiresock";

const NETSH_PT = `
       MTU  MediaSenseState      Bytes Entrada     Bytes Saída Interface
----------  ---------------  ------------  ------------  -------------
4294967295                1             0          8656  Loopback Pseudo-Interface 1
      1500                1    4908596176     815325313  Ethernet
      1420                1      12500000       2500000  ProTUN
      1500                1             0         42245  Radmin VPN
`;

describe("log de trafego do tunel", () => {
  it("le os contadores do adaptador pelo nome, com cabecalho traduzido", () => {
    expect(parseNetshInterfaceBytes(NETSH_PT, "ProTUN")).toEqual({ adapter: "ProTUN", receivedBytes: 12500000, sentBytes: 2500000 });
    expect(parseNetshInterfaceBytes(NETSH_PT, "Radmin VPN")?.sentBytes).toBe(42245);
  });

  it("devolve null sem o adaptador (tunel desligado)", () => {
    expect(parseNetshInterfaceBytes(NETSH_PT, "WireSock")).toBeNull();
  });

  it("calcula Mbps pelo intervalo e marca queda brusca de upload", () => {
    const a = { adapter: "ProTUN", receivedBytes: 0, sentBytes: 0 };
    const b = { adapter: "ProTUN", receivedBytes: 250_000, sentBytes: 1_500_000 };
    const s1 = trafficSample(a, b, 2000, null);
    expect(s1.downMbps).toBeCloseTo(1, 5);
    expect(s1.upMbps).toBeCloseTo(6, 5);
    expect(s1.queda).toBe(false);

    const c = { adapter: "ProTUN", receivedBytes: 260_000, sentBytes: 1_550_000 };
    const s2 = trafficSample(b, c, 2000, s1.upMbps);
    expect(s2.upMbps).toBeCloseTo(0.2, 5);
    expect(s2.queda).toBe(true);
  });

  it("contador zerado (tunel reiniciado) nao vira taxa negativa", () => {
    const a = { adapter: "ProTUN", receivedBytes: 900, sentBytes: 900 };
    const b = { adapter: "ProTUN", receivedBytes: 100, sentBytes: 100 };
    const s = trafficSample(a, b, 2000, 5);
    expect(s.downMbps).toBe(0);
    expect(s.upMbps).toBe(0);
  });

  it("le o ping em portugues e ingles, e devolve null quando esgota", () => {
    expect(parsePingMs("Resposta de 1.1.1.1: bytes=32 tempo=10ms TTL=57")).toBe(10);
    expect(parsePingMs("Reply from 1.1.1.1: bytes=32 time<1ms TTL=57")).toBe(1);
    expect(parsePingMs("Esgotado o tempo limite do pedido.\n    Pacotes: Enviados = 1, Recebidos = 0, Perdidos = 1 (100% de perda),")).toBeNull();
  });
});
