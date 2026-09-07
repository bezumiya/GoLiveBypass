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
  });
});
