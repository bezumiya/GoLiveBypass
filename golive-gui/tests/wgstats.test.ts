import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import * as logger from "../electron/logger";
import { registrarLogWireSock } from "../electron/wiresock-log";
import { classifyWgReadiness, iniciarWgStatsWatchdog, parseWgDump, pararWgStatsWatchdog, WG_STATS_INTERVAL_MS } from "../electron/wgstats";

// `wg show <iface> dump` real (campos tab-separated, ver electron/wgstats.ts).
const linhaInterface = "PRIVKEYBASE64\tPUBKEYBASE64\t51820\t0";
function linhaPeer(handshake: string, rx: string, tx: string, endpoint = "146.70.230.146:51820") {
  return `PEERPUBKEY\t(none)\t${endpoint}\t0.0.0.0/0,::/0\t${handshake}\t${rx}\t${tx}\t25`;
}

describe("parseWgDump", () => {
  it("calcula a idade do handshake a partir do epoch", () => {
    const agora = 2_000_000_000;
    const dump = [linhaInterface, linhaPeer(String(agora - 42), "1000", "2000")].join("\n");
    const s = parseWgDump(dump, agora);
    expect(s.ok).toBe(true);
    expect(s.handshakeAgoS).toBe(42);
    expect(s.rxBytes).toBe(1000);
    expect(s.txBytes).toBe(2000);
    expect(s.endpoint).toBe("146.70.230.146:51820");
  });

  it("handshake 0 (nunca aconteceu) vira null, nao idade gigante", () => {
    const dump = [linhaInterface, linhaPeer("0", "0", "0")].join("\n");
    const s = parseWgDump(dump, 2_000_000_000);
    expect(s.ok).toBe(true);
    expect(s.handshakeAgoS).toBeNull();
  });

  it("endpoint (none) vira null", () => {
    const dump = [linhaInterface, linhaPeer("0", "0", "0", "(none)")].join("\n");
    const s = parseWgDump(dump, 2_000_000_000);
    expect(s.endpoint).toBeNull();
  });

  it("sem peer no dump (so a linha da interface) reporta erro, nao lanca", () => {
    const s = parseWgDump(linhaInterface, 2_000_000_000);
    expect(s.ok).toBe(false);
    expect(s.error).toBeTruthy();
  });

  it("dump vazio reporta erro, nao lanca", () => {
    const s = parseWgDump("", 2_000_000_000);
    expect(s.ok).toBe(false);
  });

  it("linha de peer com poucos campos reporta erro, nao lanca", () => {
    const dump = [linhaInterface, "PEERPUBKEY\t(none)\t146.70.230.146:51820"].join("\n");
    const s = parseWgDump(dump, 2_000_000_000);
    expect(s.ok).toBe(false);
    expect(s.error).toBeTruthy();
  });
});

describe("classifyWgReadiness", () => {
  const base = (handshakeAgoS: number | null) => ({
    ok: true,
    handshakeAgoS,
    rxBytes: 10,
    txBytes: 10,
    endpoint: "146.70.230.146:51820",
  });

  it("nao confunde interface ativa sem handshake com rota pronta", () => {
    expect(classifyWgReadiness(base(null), true).state).toBe("handshake_missing");
  });

  it("separa handshake funcional de gateway inacessivel", () => {
    expect(classifyWgReadiness(base(4), false).state).toBe("gateway_unreachable");
  });

  it("aceita somente handshake recente e gateway confirmado", () => {
    expect(classifyWgReadiness(base(4), true)).toEqual({ ready: true, state: "ready" });
  });

  it("nao libera o Discord sem bytes WireGuard nos dois sentidos", () => {
    expect(classifyWgReadiness({ ...base(4), rxBytes: 0 }, true).state).toBe("traffic_missing");
    expect(classifyWgReadiness({ ...base(4), txBytes: 0 }, true).state).toBe("traffic_missing");
  });

  it("marca handshake velho como degradado", () => {
    expect(classifyWgReadiness(base(181), true).state).toBe("degraded");
  });
});

describe("watchdog WireGuard", () => {
  it("não sobrepõe amostras lentas e invalida a geração parada", async () => {
    vi.useFakeTimers();
    let chamadas = 0;
    let liberarPrimeira: (() => void) | undefined;
    const provider = vi.fn(() => {
      chamadas++;
      if (chamadas === 1) {
        return new Promise((resolve) => {
          liberarPrimeira = () => resolve({ ok: true, handshakeAgoS: 1, rxBytes: 10, txBytes: 10, endpoint: "peer" });
        });
      }
      return Promise.resolve({ ok: true, handshakeAgoS: 1, rxBytes: 20, txBytes: 20, endpoint: "peer" });
    });

    try {
      iniciarWgStatsWatchdog(provider);
      await vi.advanceTimersByTimeAsync(WG_STATS_INTERVAL_MS);
      expect(chamadas).toBe(1);
      await vi.advanceTimersByTimeAsync(WG_STATS_INTERVAL_MS);
      expect(chamadas).toBe(1);

      pararWgStatsWatchdog();
      liberarPrimeira?.();
      await Promise.resolve();
      iniciarWgStatsWatchdog(provider);
      await vi.advanceTimersByTimeAsync(WG_STATS_INTERVAL_MS);
      expect(chamadas).toBe(2);
    } finally {
      pararWgStatsWatchdog();
      vi.useRealTimers();
    }
  });

  it("absorve rejeição do provider e tenta a próxima amostra", async () => {
    vi.useFakeTimers();
    let chamadas = 0;
    const provider = vi.fn(() => {
      chamadas++;
      if (chamadas === 1) return Promise.reject(new Error("setns temporariamente indisponível"));
      return Promise.resolve({ ok: true, handshakeAgoS: 1, rxBytes: 10, txBytes: 10, endpoint: "peer" });
    });
    try {
      iniciarWgStatsWatchdog(provider);
      await vi.advanceTimersByTimeAsync(WG_STATS_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(WG_STATS_INTERVAL_MS);
      expect(chamadas).toBe(2);
    } finally {
      pararWgStatsWatchdog();
      vi.useRealTimers();
    }
  });

  // 1 KiB/s = 8 kbps. Os contadores sobem nesse ritmo; a taxa registrada tem de ser 8
  // mesmo quando uma leitura no meio falha e o delta cobre dois intervalos.
  it("taxa usa o tempo real entre as amostras, nao o intervalo fixo", async () => {
    vi.useFakeTimers();
    logger._resetForTests();
    const inicio = Date.now();
    let chamadas = 0;
    const provider = vi.fn(() => {
      chamadas++;
      if (chamadas === 2) return Promise.resolve({ ok: false, handshakeAgoS: null, rxBytes: null, txBytes: null, endpoint: null, error: "leitura falhou" });
      const bytes = Math.round((Date.now() - inicio) / 1000) * 1024;
      return Promise.resolve({ ok: true, handshakeAgoS: 1, rxBytes: bytes, txBytes: bytes, endpoint: "peer" });
    });
    try {
      iniciarWgStatsWatchdog(provider);
      await vi.advanceTimersByTimeAsync(WG_STATS_INTERVAL_MS * 3);
      expect(chamadas).toBe(3);
      const recent = logger.getRecent();
      expect(recent).toContain("rx_taxa_kbps=8 tx_taxa_kbps=8");
      expect(recent).not.toContain("rx_taxa_kbps=16");
    } finally {
      pararWgStatsWatchdog();
      vi.useRealTimers();
    }
  });

  it("contador que zerou (tunel reiniciado) nao vira taxa negativa", async () => {
    vi.useFakeTimers();
    logger._resetForTests();
    const amostras = [500_000, 1_000];
    const provider = vi.fn(() => {
      const bytes = amostras.shift() ?? 1_000;
      return Promise.resolve({ ok: true, handshakeAgoS: 1, rxBytes: bytes, txBytes: bytes, endpoint: "peer" });
    });
    try {
      iniciarWgStatsWatchdog(provider);
      await vi.advanceTimersByTimeAsync(WG_STATS_INTERVAL_MS * 2);
      const recent = logger.getRecent();
      expect(recent).toContain("rx_total_kb=1 ");
      expect(recent).not.toMatch(/taxa_kbps=-/);
    } finally {
      pararWgStatsWatchdog();
      vi.useRealTimers();
    }
  });
});

describe("watchdog sem wg.exe: saude lida do log do WireSock", () => {
  const AGORA = new Date(2026, 9, 19, 20, 0, 0).getTime();
  const KEEPALIVE = "[TUN]: keep_alive_thread: Sending Keepalive packet to WireGuard Server success";
  const ENVIO = "[TUN]: keep_alive_thread: Handshake initiation sent to WireGuard server";
  const RESPOSTA = "[TUN]: Handshake response received from 84.20.27.49 : 51820";
  const semWg = () => Promise.resolve({ ok: false, handshakeAgoS: null, rxBytes: null, txBytes: null, endpoint: null, error: "wg.exe indisponivel ou sem interface: spawn wg ENOENT" });
  let dir: string;
  let arquivo: string;

  const dois = (n: number) => String(n).padStart(2, "0");
  const linha = (msAtras: number, mensagem: string) => {
    const d = new Date(AGORA - msAtras);
    const quando = `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())} ${dois(d.getHours())}:${dois(d.getMinutes())}:${dois(d.getSeconds())}`;
    return `${quando} ${JSON.stringify({ log_level: "info", message: mensagem })}`;
  };
  // O watchdog le o arquivo um intervalo depois de AGORA (relogio falso): as linhas sao
  // relativas ao instante da leitura, nao ao de criacao.
  const escreverLog = (idadeUltimaLinhaS: number) => {
    const base = idadeUltimaLinhaS * 1000;
    const linhas: string[] = [];
    for (let s = 300; s >= 0; s -= 10) linhas.push(linha(base + s * 1000 - WG_STATS_INTERVAL_MS, KEEPALIVE));
    linhas.push(linha(base + 120_000 - WG_STATS_INTERVAL_MS, ENVIO), linha(base + 119_000 - WG_STATS_INTERVAL_MS, RESPOSTA));
    fs.writeFileSync(arquivo, linhas.join("\n") + "\n");
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-wgstats-"));
    arquivo = path.join(dir, "direct-result.txt.stdout");
    logger._resetForTests();
    vi.useFakeTimers();
    vi.setSystemTime(AGORA);
    registrarLogWireSock(null);
  });
  afterEach(() => {
    pararWgStatsWatchdog();
    registrarLogWireSock(null);
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("tunel saudavel registra tunel.saude em vez de stats.indisponivel", async () => {
    escreverLog(5);
    registrarLogWireSock(arquivo);
    iniciarWgStatsWatchdog(semWg);
    await vi.advanceTimersByTimeAsync(WG_STATS_INTERVAL_MS);

    const recent = logger.getRecent();
    expect(recent).toContain("tunel.saude");
    expect(recent).not.toContain("stats.indisponivel");
    expect(recent).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("saude saudavel e registrada no maximo a cada 5 minutos", async () => {
    escreverLog(5);
    registrarLogWireSock(arquivo);
    iniciarWgStatsWatchdog(semWg);
    await vi.advanceTimersByTimeAsync(WG_STATS_INTERVAL_MS * 4);

    expect(logger.getRecent().split("tunel.saude").length - 1).toBe(1);
  });

  it("log parado vira aviso a cada leitura", async () => {
    escreverLog(200);
    registrarLogWireSock(arquivo);
    iniciarWgStatsWatchdog(semWg);
    await vi.advanceTimersByTimeAsync(WG_STATS_INTERVAL_MS * 2);

    const recent = logger.getRecent();
    expect(recent).toContain("[warn][wg] wiresock.log_parado");
    expect(recent).not.toContain("tunel.saude");
  });

  it("sem log registrado, stats.indisponivel aparece uma vez em vez de a cada leitura", async () => {
    iniciarWgStatsWatchdog(semWg);
    await vi.advanceTimersByTimeAsync(WG_STATS_INTERVAL_MS * 5);

    expect(logger.getRecent().split("stats.indisponivel").length - 1).toBe(1);
  });

  it("log registrado mas ilegivel cai de volta em stats.indisponivel", async () => {
    registrarLogWireSock(path.join(dir, "nao-existe.stdout"));
    iniciarWgStatsWatchdog(semWg);
    await vi.advanceTimersByTimeAsync(WG_STATS_INTERVAL_MS);

    expect(logger.getRecent()).toContain("stats.indisponivel");
  });
});
