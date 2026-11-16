import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  classifyFailoverHealth,
  FailoverHealthTracker,
  FAILOVER_INITIAL_GRACE_MS,
  FAILOVER_FAILURE_THRESHOLD,
  makeRoutePoolManifest,
  routeCandidateUsable,
  routePoolDirectory,
  routePoolMatches,
  safeRoutePoolPath,
  readRoutePoolManifest,
  writeRoutePoolManifest,
} from "../electron/route-failover";

describe("failover Proton", () => {
  it("só classifica falha com Discord ativo e túnel ausente/handshake velho", () => {
    expect(classifyFailoverHealth({ discordRunning: false, tunnelActive: false })).toBe("unknown");
    expect(classifyFailoverHealth({ discordRunning: true, tunnelActive: false })).toBe("failed");
    expect(classifyFailoverHealth({
      discordRunning: true,
      tunnelActive: true,
      stats: { ok: true, handshakeAgoS: 12, rxBytes: 10, txBytes: 10 },
    })).toBe("healthy");
    expect(classifyFailoverHealth({
      discordRunning: true,
      tunnelActive: true,
      stats: { ok: true, handshakeAgoS: 46, rxBytes: 10, txBytes: 10 },
    })).toBe("failed");
    expect(classifyFailoverHealth({
      discordRunning: true,
      tunnelActive: true,
      stats: { ok: false, handshakeAgoS: null, rxBytes: null, txBytes: null, error: "wg.exe indisponível" },
      wireSock: { state: "unknown", source: "service" },
    })).toBe("unknown");
  });

  it("no Windows, handshakes sem resposta no log do WireSock são falha mesmo com CLI ou tráfego dizendo o contrário (#411)", () => {
    const semWg = {
      discordRunning: true,
      tunnelActive: true,
      stats: { ok: false, handshakeAgoS: null, rxBytes: null, txBytes: null, error: "wg.exe indisponível" },
    };
    const servico = { state: "unknown" as const, source: "service" as const };
    expect(classifyFailoverHealth({ ...semWg, wireSock: servico, wireSockHandshakeUnanswered: true })).toBe("failed");
    expect(classifyFailoverHealth({ ...semWg, wireSock: { state: "connected", source: "cli" }, wireSockHandshakeUnanswered: true })).toBe("failed");
    expect(classifyFailoverHealth({ ...semWg, wireSock: servico, trafficIncreasing: true, wireSockHandshakeUnanswered: true })).toBe("failed");
    // Sem a evidência nova, nada muda.
    expect(classifyFailoverHealth({ ...semWg, wireSock: servico, wireSockHandshakeUnanswered: false })).toBe("unknown");
    expect(classifyFailoverHealth({ ...semWg, wireSock: { state: "connected", source: "cli" } })).toBe("healthy");
    // Discord fechado continua sem decisão, e o wg.exe com handshake recente continua mandando.
    expect(classifyFailoverHealth({ ...semWg, discordRunning: false, wireSockHandshakeUnanswered: true })).toBe("unknown");
    expect(classifyFailoverHealth({
      ...semWg,
      stats: { ok: true, handshakeAgoS: 10, rxBytes: 1, txBytes: 1 },
      wireSockHandshakeUnanswered: true,
    })).toBe("healthy");

    const tracker = new FailoverHealthTracker(FAILOVER_FAILURE_THRESHOLD, FAILOVER_INITIAL_GRACE_MS);
    tracker.reset(0);
    const saude = classifyFailoverHealth({ ...semWg, wireSock: servico, wireSockHandshakeUnanswered: true });
    const disparos = [6_000, 9_000, 12_000, 15_000].map((t) => tracker.observe(saude, t).trigger);
    expect(disparos).toEqual([false, false, false, true]);
  });

  it("a amostra do Windows e a prontidão usam o log do WireSock", () => {
    const main = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(main).toContain("wireSockHandshakeUnanswered: logWireSock ? servidorSemResposta(logWireSock) : false");
    expect(main).toMatch(/respostaNaSessaoAtual\(lerResumoLogWireSock\(caminhoLog\)\)\)\s*\{\s*return finish\(\{ verified: true, state: "connected", source: "log"/);
  });

  it("depois da troca automática, a tela recarrega o cartão da rota", () => {
    const main = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const preload = fs.readFileSync(path.resolve(process.cwd(), "electron/preload.ts"), "utf8");
    const renderer = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    const sucesso = main.slice(main.indexOf("async function attemptProtonFailover"), main.indexOf("failedNames.add(candidate.server)"));
    expect(sucesso).toMatch(/protonLastServer:[\s\S]*notifyProtonRouteChanged\(\);[\s\S]*return;/);
    expect(main).toContain('mainWindow.webContents.send("proton-route-changed")');
    expect(preload).toContain("ipcRenderer.on('proton-route-changed'");
    expect(renderer).toMatch(/onProtonRouteChanged\?\.\(\(\) => \{\s*setProtonFeedback\(''\);\s*void refreshProtonState\(\);/);
  });

  it("exige falha sustentada fora da janela inicial", () => {
    const tracker = new FailoverHealthTracker(FAILOVER_FAILURE_THRESHOLD, FAILOVER_INITIAL_GRACE_MS);
    tracker.reset(0);
    expect(tracker.observe("failed", 0).trigger).toBe(false);
    expect(tracker.observe("failed", 4_999).trigger).toBe(false);
    expect(tracker.observe("failed", 5_000).consecutiveFailures).toBe(1);
    expect(tracker.observe("failed", 8_000).consecutiveFailures).toBe(2);
    expect(tracker.observe("healthy", 9_000).consecutiveFailures).toBe(0);
    expect(tracker.observe("failed", 12_000).trigger).toBe(false);
    expect(tracker.observe("failed", 15_000).trigger).toBe(false);
    expect(tracker.observe("failed", 18_000).trigger).toBe(false);
    expect(tracker.observe("failed", 21_000).trigger).toBe(true);
  });

  it("persiste o pool atomically e rejeita caminhos fora da pasta", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-route-pool-"));
    try {
      const manifest = makeRoutePoolManifest({ username: "User", country: "", autoPing: true });
      const pool = routePoolDirectory(root);
      const route = path.join(pool, "route-a.conf");
      fs.mkdirSync(pool, { recursive: true });
      fs.writeFileSync(route, "[Interface]\n");
      manifest.reserves = [{
        server: "US#1", country: "US", city: "New York", tier: "Free", load: 10,
        score: 1, pingMs: 80, endpoint: "192.0.2.1:51820", confFile: route,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }];
      writeRoutePoolManifest(root, manifest);
      expect(readRoutePoolManifest(root)?.reserves).toHaveLength(1);
      expect(routePoolMatches(readRoutePoolManifest(root), { username: "user", country: "", freeOnly: true, autoPing: true })).toBe(true);
      expect(routeCandidateUsable(manifest.reserves[0])).toBe(true);
      expect(safeRoutePoolPath(pool, route)).toBe(path.resolve(route));
      expect(safeRoutePoolPath(pool, path.join(root, "wireguard.conf"))).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("troca o transporte sem chamar o ciclo de encerramento do Discord", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const start = source.indexOf("async function applyProtonFailoverCandidate");
    const end = source.indexOf("async function attemptProtonFailover", start);
    const apply = source.slice(start, end);
    expect(apply).toContain("switchWireSockService");
    expect(apply).toContain("--refresh-route-from");
    expect(apply).toContain("--non-interactive");
    expect(apply).not.toContain("killDiscord()");
    expect(apply).toContain("waitForWindowsWgReady(FAILOVER_ROUTE_TIMEOUT_MS)");
  });

  it("reaplica os endereços da reserva Linux junto com o peer", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const start = source.indexOf("refresh_wireguard_route() {");
    const end = source.indexOf("# Um namespace/interface existente", start);
    const refresh = source.slice(start, end);
    expect(refresh).toContain("addr flush dev");
    expect(refresh).toContain("addr add");
    expect(refresh).toContain("O perfil de troca nao informa nenhum endereco WireGuard");
    // Sem IPv6 no kernel o endereço IPv6 da reserva derrubava a troca (#404): só o IPv4 entra.
    expect(refresh).toContain("/proc/net/if_inet6");
    expect(refresh.indexOf("/proc/net/if_inet6")).toBeLessThan(refresh.indexOf("addr flush dev"));
  });
});
