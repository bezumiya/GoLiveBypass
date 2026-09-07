import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

export type FailoverHealth = "healthy" | "failed" | "unknown";

export interface FailoverTunnelStats {
  ok: boolean;
  handshakeAgoS: number | null;
  rxBytes: number | null;
  txBytes: number | null;
  error?: string;
}

export interface FailoverWireSockStatus {
  state: "connected" | "connecting" | "disconnected" | "unknown";
  source: "cli" | "service" | "none";
}

export interface FailoverHealthSample {
  discordRunning: boolean;
  tunnelActive: boolean;
  stats?: FailoverTunnelStats | null;
  wireSock?: FailoverWireSockStatus | null;
  trafficIncreasing?: boolean;
  /** A Linux status error naming a missing namespace/interface is evidence of failure. */
  statsFailureEvidence?: boolean;
}

// PersistentKeepalive=10 in profiles generated for the managed Proton path gives us a
// bounded liveness signal without probing HTTP/geo endpoints or touching Discord itself.
export const FAILOVER_STALE_HANDSHAKE_S = 45;
export const FAILOVER_SAMPLE_INTERVAL_MS = 3_000;
export const FAILOVER_FAILURE_THRESHOLD = 4;
export const FAILOVER_INITIAL_GRACE_MS = 5_000;
export const FAILOVER_ROUTE_TIMEOUT_MS = 5_000;

/**
 * Classifies only signals that belong to the active WireGuard path. HTTP, IP and
 * geolocation probes deliberately do not participate in this decision.
 */
export function classifyFailoverHealth(
  sample: FailoverHealthSample,
  staleHandshakeS = FAILOVER_STALE_HANDSHAKE_S,
): FailoverHealth {
  if (!sample.discordRunning) return "unknown";
  if (!sample.tunnelActive) return "failed";

  if (sample.wireSock?.state === "disconnected") return "failed";

  const stats = sample.stats;
  if (stats?.ok) {
    if (stats.handshakeAgoS === null || stats.handshakeAgoS > staleHandshakeS) return "failed";
    return "healthy";
  }

  // A missing wg.exe, or an unprivileged diagnostic read, is not enough evidence
  // to switch a live route. Linux callers can explicitly mark a missing namespace
  // or interface as evidence; Windows falls back to CLI/adapter observations.
  if (sample.statsFailureEvidence) return "failed";
  if (sample.wireSock?.state === "connected") return "healthy";
  if (sample.trafficIncreasing) return "healthy";
  return "unknown";
}

export interface FailoverObservation {
  health: FailoverHealth;
  consecutiveFailures: number;
  trigger: boolean;
  inGracePeriod: boolean;
}

/** Small state machine kept separate from Electron timers so it can be tested deterministically. */
export class FailoverHealthTracker {
  private startedAt: number | null = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly failureThreshold = FAILOVER_FAILURE_THRESHOLD,
    private readonly initialGraceMs = FAILOVER_INITIAL_GRACE_MS,
  ) {}

  reset(now = Date.now()): void {
    this.startedAt = now;
    this.consecutiveFailures = 0;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  observe(health: FailoverHealth, now = Date.now()): FailoverObservation {
    if (this.startedAt === null) this.startedAt = now;
    const inGracePeriod = now - this.startedAt < this.initialGraceMs;
    if (inGracePeriod || health !== "failed") {
      if (health !== "failed") this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
    }
    return {
      health,
      consecutiveFailures: this.consecutiveFailures,
      trigger: !inGracePeriod && this.consecutiveFailures >= this.failureThreshold,
      inGracePeriod,
    };
  }
}

export interface ProtonRouteMetadata {
  success?: boolean;
  server: string;
  country: string;
  city: string;
  tier: string;
  load: number;
  score: number;
  pingMs: number;
  endpoint: string;
  confFile: string;
  expiresAt?: number;
  generatedAt?: string;
}

export interface ProtonRoutePoolManifest {
  version: 1;
  username: string;
  country: string;
  freeOnly: true;
  autoPing: boolean;
  createdAt: string;
  active?: ProtonRouteMetadata;
  reserves: ProtonRouteMetadata[];
  quarantined: string[];
  renewalUsed: boolean;
  disabled?: boolean;
}

export const ROUTE_POOL_VERSION = 1 as const;
export const ROUTE_POOL_TOTAL = 3;
export const ROUTE_POOL_RESERVE_COUNT = ROUTE_POOL_TOTAL - 1;

export function routePoolDirectory(installDir: string): string {
  return path.join(installDir, "proton-route-pool");
}

export function routePoolManifestPath(installDir: string): string {
  return path.join(routePoolDirectory(installDir), "manifest.json");
}

export function normalizePoolUsername(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase("en-US");
}

export function routePoolMatches(
  manifest: ProtonRoutePoolManifest | null,
  filter: { username: string; country: string; freeOnly: boolean; autoPing: boolean },
): boolean {
  return Boolean(
    manifest &&
    manifest.version === ROUTE_POOL_VERSION &&
    normalizePoolUsername(manifest.username) === normalizePoolUsername(filter.username) &&
    manifest.country === filter.country &&
    manifest.freeOnly === true &&
    filter.freeOnly === true &&
    manifest.autoPing === filter.autoPing &&
    manifest.disabled !== true,
  );
}

export function safeRoutePoolPath(poolDir: string, candidate: string): string | null {
  if (!candidate || /[\r\n\0]/.test(candidate)) return null;
  const base = path.resolve(poolDir);
  const resolved = path.resolve(candidate);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

export function routeCandidateUsable(candidate: ProtonRouteMetadata, now = Date.now()): boolean {
  if (!candidate || typeof candidate.server !== "string" || !candidate.server.trim()) return false;
  if (candidate.success === false) return false;
  const expiryMs = candidate.expiresAt === undefined
    ? undefined
    : (candidate.expiresAt < 1_000_000_000_000 ? candidate.expiresAt * 1000 : candidate.expiresAt);
  if (!candidate.confFile || (expiryMs !== undefined && expiryMs <= now + 120_000)) return false;
  return Number.isFinite(candidate.pingMs) && candidate.pingMs > 0 &&
    typeof candidate.endpoint === "string" && candidate.endpoint.length > 0;
}

function normalizeManifest(value: any): ProtonRoutePoolManifest | null {
  if (!value || typeof value !== "object" || value.version !== ROUTE_POOL_VERSION) return null;
  if (typeof value.username !== "string" || typeof value.country !== "string") return null;
  if (!Array.isArray(value.reserves) || !Array.isArray(value.quarantined)) return null;
  if (value.freeOnly !== true || typeof value.autoPing !== "boolean") return null;
  return {
    version: ROUTE_POOL_VERSION,
    username: value.username,
    country: value.country,
    freeOnly: true,
    autoPing: value.autoPing,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    active: value.active && typeof value.active === "object" ? value.active as ProtonRouteMetadata : undefined,
    reserves: value.reserves.filter((item: any) => item && typeof item === "object") as ProtonRouteMetadata[],
    quarantined: value.quarantined.filter((item: unknown): item is string => typeof item === "string").slice(-32),
    renewalUsed: value.renewalUsed === true,
    disabled: value.disabled === true,
  };
}

export function readRoutePoolManifest(installDir: string): ProtonRoutePoolManifest | null {
  try {
    return normalizeManifest(JSON.parse(fs.readFileSync(routePoolManifestPath(installDir), "utf8")));
  } catch {
    return null;
  }
}

export function writeRoutePoolManifest(installDir: string, manifest: ProtonRoutePoolManifest): void {
  const dir = routePoolDirectory(installDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "manifest.json");
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function makeRoutePoolManifest(
  filter: { username: string; country: string; autoPing: boolean },
  active?: ProtonRouteMetadata,
): ProtonRoutePoolManifest {
  return {
    version: ROUTE_POOL_VERSION,
    username: normalizePoolUsername(filter.username),
    country: filter.country,
    freeOnly: true,
    autoPing: filter.autoPing,
    createdAt: new Date().toISOString(),
    active,
    reserves: [],
    quarantined: [],
    renewalUsed: false,
  };
}
