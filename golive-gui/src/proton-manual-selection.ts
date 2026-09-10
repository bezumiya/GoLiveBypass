export type ManualCandidateStatus =
  | 'not-tested'
  | 'pending'
  | 'success'
  | 'failed';

export type ManualRouteProgressPhase =
  | 'ping'
  | 'preparing'
  | 'testing'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ManualRouteCandidate {
  server: string;
  pingMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
  pingStatus: ManualCandidateStatus;
  preflightStatus: ManualCandidateStatus;
  speedStatus: ManualCandidateStatus;
  failureReason?: string;
}

export interface ManualRouteProgressEvent {
  phase: ManualRouteProgressPhase;
  server?: string;
  pingMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
  status?: 'testing' | 'success' | 'failed';
}

const CANDIDATE_PHASES = new Set<ManualRouteProgressPhase>([
  'ping',
  'preparing',
  'testing',
]);

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidPing(value: number | undefined): value is number {
  return isPositiveFinite(value) && value < 999;
}

function statusForEvent(status: ManualRouteProgressEvent['status']): ManualCandidateStatus {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'failed';
  return 'pending';
}

function emptyCandidate(server: string): ManualRouteCandidate {
  return {
    server,
    pingStatus: 'not-tested',
    preflightStatus: 'not-tested',
    speedStatus: 'not-tested',
  };
}

function normalizedServerName(server: string): string {
  return server.normalize('NFKC').toLocaleLowerCase('en-US');
}

function compareServerNames(left: ManualRouteCandidate, right: ManualRouteCandidate): number {
  const leftNormalized = normalizedServerName(left.server);
  const rightNormalized = normalizedServerName(right.server);
  if (leftNormalized < rightNormalized) return -1;
  if (leftNormalized > rightNormalized) return 1;
  if (left.server < right.server) return -1;
  if (left.server > right.server) return 1;
  return 0;
}

function manualRouteCapacity(candidate: ManualRouteCandidate): number | undefined {
  if (candidate.speedStatus !== 'success' || !isPositiveFinite(candidate.downloadMbps) || !isPositiveFinite(candidate.uploadMbps)) {
    return undefined;
  }
  return (2 * candidate.downloadMbps * candidate.uploadMbps)
    / (candidate.downloadMbps + candidate.uploadMbps);
}

export function reduceManualRouteEvent(
  current: ReadonlyMap<string, ManualRouteCandidate>,
  event: ManualRouteProgressEvent,
): Map<string, ManualRouteCandidate> {
  const next = new Map(current);
  if (
    !event
    || !CANDIDATE_PHASES.has(event.phase)
    || typeof event.server !== 'string'
    || event.server.trim() === ''
  ) {
    return next;
  }

  const server = event.server;
  const candidate = {
    ...(next.get(server) ?? emptyCandidate(server)),
  };
  const status = statusForEvent(event.status);

  if (isValidPing(event.pingMs)) candidate.pingMs = event.pingMs;
  if (isPositiveFinite(event.downloadMbps)) candidate.downloadMbps = event.downloadMbps;
  if (isPositiveFinite(event.uploadMbps)) candidate.uploadMbps = event.uploadMbps;

  if (event.phase === 'ping') {
    candidate.pingStatus = status;
  } else if (event.phase === 'preparing') {
    candidate.preflightStatus = status;
  } else {
    candidate.speedStatus = status;
  }

  next.set(server, candidate);
  return next;
}

export function sortManualRouteCandidates(
  candidates: Iterable<ManualRouteCandidate>,
): ManualRouteCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftPing = isValidPing(left.pingMs) ? left.pingMs : undefined;
    const rightPing = isValidPing(right.pingMs) ? right.pingMs : undefined;
    const leftHasPing = leftPing !== undefined;
    const rightHasPing = rightPing !== undefined;

    if (leftHasPing && !rightHasPing) return -1;
    if (!leftHasPing && rightHasPing) return 1;
    if (leftPing !== undefined && rightPing !== undefined && leftPing !== rightPing) {
      return leftPing - rightPing;
    }
    return compareServerNames(left, right);
  });
}

export function isManualRouteSelectable(
  candidate: ManualRouteCandidate,
): boolean {
  return Boolean(
    candidate
    && candidate.server.trim() !== ''
    && isValidPing(candidate.pingMs)
    && candidate.pingStatus !== 'failed'
    && candidate.preflightStatus !== 'failed',
  );
}

export function recommendManualRoute(
  candidates: Iterable<ManualRouteCandidate>,
): string | undefined {
  const eligible = [...candidates].filter(isManualRouteSelectable);
  if (eligible.length === 0) return undefined;

  const measured = eligible
    .map((candidate) => ({ candidate, capacity: manualRouteCapacity(candidate) }))
    .filter((entry): entry is { candidate: ManualRouteCandidate; capacity: number } =>
      entry.capacity !== undefined && Number.isFinite(entry.capacity));

  if (measured.length > 0) {
    measured.sort((left, right) => {
      if (left.capacity !== right.capacity) return right.capacity - left.capacity;
      if (left.candidate.pingMs !== right.candidate.pingMs) {
        return (left.candidate.pingMs ?? Number.POSITIVE_INFINITY)
          - (right.candidate.pingMs ?? Number.POSITIVE_INFINITY);
      }
      return compareServerNames(left.candidate, right.candidate);
    });
    return measured[0]?.candidate.server;
  }

  return sortManualRouteCandidates(eligible)[0]?.server;
}
