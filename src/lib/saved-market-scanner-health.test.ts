import { describe, expect, it } from 'vitest';
import { assessSavedMarketScannerHealth, deriveScannerQueue } from './saved-market-scanner-health.mjs';

const now = Date.parse('2026-08-18T15:00:00.000Z');
const healthy = {
  now,
  deployment: { commit: 'abc', buildId: 'build-1' },
  workerBundle: { exists: true, path: '/release/.next/full-scan-worker.cjs' },
  pollerHealth: {
    pollerPid: 42,
    heartbeatAt: '2026-08-18T14:59:50.000Z',
    successCount: 3,
    failureCount: 0,
    queue: { dueCount: 2, overdueCount: 0, oldestSuccessAgeMs: 1_000 },
    errors: [],
  },
  scheduler: {
    readable: true,
    entries: [{
      lastAttemptAt: '2026-08-18T14:59:45.000Z',
      lastSuccessAt: '2026-08-18T14:59:50.000Z',
      inProgress: false,
    }],
  },
  disk: { allowed: true, reason: null },
  sqlite: { exhaustedWrites: 0 },
  telemetry: { error: null, pendingSnapshots: 0 },
};

describe('saved-market scanner lifecycle supervision', () => {
  it('derives queue truth from scheduler state while a new cycle has not published its queue yet', () => {
    expect(deriveScannerQueue([
      { nextDueAt: '2026-08-18T14:00:00.000Z', lastSuccessAt: '2026-08-18T13:00:00.000Z', failureReason: 'HTTP 500', inProgress: false },
      { nextDueAt: '2026-08-18T16:00:00.000Z', lastSuccessAt: '2026-08-18T14:59:30.000Z', failureReason: null, inProgress: false },
      { nextDueAt: '2026-08-18T14:00:00.000Z', lastSuccessAt: null, failureReason: null, inProgress: true },
    ], now, 3_600_000)).toEqual({
      eligibleCount: 3,
      dueCount: 1,
      overdueCount: 2,
      failedCount: 1,
      inProgressCount: 1,
      oldestSuccessAgeMs: 7_200_000,
    });
  });

  it('keeps price-feed connectivity outside full-scan health and reports a healthy progressing scanner', () => {
    expect(assessSavedMarketScannerHealth(healthy)).toMatchObject({ state: 'healthy', degradedReason: null });
  });

  it('keeps a persistent overdue failed subset degraded across otherwise successful cycles', () => {
    const result = assessSavedMarketScannerHealth({
      ...healthy,
      pollerHealth: {
        ...healthy.pollerHealth,
        successCount: 24,
        failureCount: 0,
        openBreakers: 0,
        queue: {
          eligibleCount: 483,
          dueCount: 0,
          overdueCount: 13,
          failedCount: 13,
          oldestSuccessAgeMs: 115_019_708,
        },
      },
      scheduler: {
        readable: true,
        entries: [{
          lastAttemptAt: '2026-08-18T14:59:45.000Z',
          lastSuccessAt: '2026-08-17T07:03:00.292Z',
          failureReason: 'HTTP 500: Scan worker exited before returning a result',
          inProgress: false,
        }],
      },
    });

    expect(result).toMatchObject({
      state: 'degraded',
      degradedReason: 'overdue_failures',
      detail: expect.stringContaining('13 overdue market(s)'),
      queue: { failedCount: 13, oldestSuccessAgeMs: 115_019_708 },
    });
    expect(result.detail).toContain('Scan worker exited before returning a result');
  });

  it('treats missing or malformed telemetry source state as degraded', () => {
    expect(assessSavedMarketScannerHealth({
      ...healthy,
      telemetry: { readable: false, error: 'Unexpected token at byte 4' },
    })).toMatchObject({
      state: 'degraded',
      degradedReason: 'telemetry_source_unusable',
      detail: 'Unexpected token at byte 4',
    });
  });

  it('does not restart a live owner during the terminal-persistence lease grace window', () => {
    expect(assessSavedMarketScannerHealth({
      ...healthy,
      scheduler: {
        readable: true,
        entries: [{
          inProgress: true,
          leaseExpiresAt: '2026-08-18T14:59:50.000Z',
          leaseToken: 'finishing-worker',
        }],
      },
    })).toMatchObject({ state: 'healthy', degradedReason: null, restartRecommended: false });
  });

  it.each([
    ['worker crash or PM2/server restart', { pollerHealth: { ...healthy.pollerHealth, heartbeatAt: '2026-08-18T14:50:00.000Z' } }, 'poller_heartbeat_stale'],
    ['release promotion with an old poller generation', { expectedSchedulerVersion: 'bug-165-v1', pollerHealth: { ...healthy.pollerHealth, schedulerVersion: 'bug-150-v1' } }, 'poller_version_mismatch'],
    ['app-only restart with a missing promoted worker', { workerBundle: { exists: false, path: '/release/.next/full-scan-worker.cjs' } }, 'missing_worker_bundle'],
    ['missing or corrupt scheduler state', { scheduler: { readable: false, entries: [], error: 'invalid JSON' } }, 'scheduler_state_unusable'],
    ['stale lock or lease after owner death', { scheduler: { readable: true, entries: [{ inProgress: true, leaseExpiresAt: '2026-08-18T14:58:00.000Z' }] } }, 'stale_lease'],
    ['SQLite contention exhaustion', { sqlite: { exhaustedWrites: 2 } }, 'sqlite_contention'],
    ['repeated venue timeout, 429, or 5xx', { pollerHealth: { ...healthy.pollerHealth, successCount: 0, failureCount: 8, errors: [{ error: 'HTTP 429' }, { error: 'HTTP 503' }] } }, 'upstream_failures'],
    ['telemetry collector failure', { telemetry: { error: 'SQLITE_BUSY', pendingSnapshots: 4 } }, 'telemetry_degraded'],
    ['cleanup pressure that closes the disk gate', { disk: { allowed: false, reason: 'projected free bytes breach reserve' } }, 'disk_capacity'],
    ['a recovered global failure leaving a breaker backlog', { pollerHealth: { ...healthy.pollerHealth, openBreakers: 461, queue: { dueCount: 0, overdueCount: 461, oldestSuccessAgeMs: 7_200_000 } } }, 'breaker_backlog'],
    ['due or overdue queue with no persisted progress', {
      pollerHealth: { ...healthy.pollerHealth, successCount: 0, failureCount: 0, queue: { dueCount: 20, overdueCount: 20, oldestSuccessAgeMs: 7_200_000 } },
      scheduler: { readable: true, entries: [{ lastAttemptAt: '2026-08-18T14:59:00.000Z', lastSuccessAt: '2026-08-18T13:00:00.000Z', inProgress: false }] },
    }, 'no_scan_progress'],
  ])('detects %s with exact owner/build/queue evidence', (_case, override, reason) => {
    const result = assessSavedMarketScannerHealth({ ...healthy, ...override });
    expect(result).toMatchObject({
      state: 'degraded',
      degradedReason: reason,
      owner: { pollerPid: expect.anything(), commit: 'abc', buildId: 'build-1' },
      queue: expect.any(Object),
      restartRecommended: expect.any(Boolean),
    });
    expect(result).toHaveProperty('lastAttemptAt');
  });
});