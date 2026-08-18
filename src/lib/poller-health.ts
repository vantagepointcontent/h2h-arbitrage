export const EXPECTED_POLLER_SCHEDULER_VERSION = 'bug-165-v1';
export const POLLER_STALE_AFTER_MS = 3 * 60_000;

export interface PollerHealthSnapshot {
  status?: string;
  schedulerVersion?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  heartbeatAt?: string | null;
  queue?: {
    eligibleCount?: number;
    dueCount?: number;
    overdueCount?: number;
    failedCount?: number;
    inProgressCount?: number;
    oldestSuccessAgeMs?: number;
  };
  [key: string]: unknown;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function classifyPollerHealth(snapshot: PollerHealthSnapshot | null, now = Date.now()) {
  const heartbeatAt = snapshot
    ? Math.max(timestamp(snapshot.startedAt), timestamp(snapshot.finishedAt), timestamp(snapshot.heartbeatAt))
    : 0;
  const staleForMs = heartbeatAt > 0 ? Math.max(0, now - heartbeatAt) : null;
  const mixedVersion = snapshot?.schedulerVersion !== EXPECTED_POLLER_SCHEDULER_VERSION;
  const stale = staleForMs === null || staleForMs > POLLER_STALE_AFTER_MS;

  return {
    available: snapshot !== null,
    mixedVersion,
    stale,
    staleForMs,
    expectedSchedulerVersion: EXPECTED_POLLER_SCHEDULER_VERSION,
    observedSchedulerVersion: snapshot?.schedulerVersion ?? null,
    heartbeatAt: heartbeatAt > 0 ? new Date(heartbeatAt).toISOString() : null,
  };
}
