const DEFAULT_HEARTBEAT_STALE_MS = 180_000;
const DEFAULT_PROGRESS_STALE_MS = 60 * 60_000;
const DEFAULT_STALE_LEASE_GRACE_MS = 30_000;
const DEFAULT_SQLITE_CONTENTION_WINDOW_MS = 15 * 60_000;

function latest(entries, key) {
  return entries
    .map((entry) => entry?.[key])
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1) ?? null;
}

function failureSummary(entries) {
  const counts = new Map();
  for (const entry of entries) {
    if (typeof entry?.failureReason !== 'string' || entry.failureReason.length === 0) continue;
    counts.set(entry.failureReason, (counts.get(entry.failureReason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([reason, count]) => `${count}× ${reason}`)
    .join('; ');
}

export function deriveScannerQueue(entries, now = Date.now(), freshnessSlaMs = 60 * 60_000) {
  let dueCount = 0;
  let overdueCount = 0;
  let failedCount = 0;
  let inProgressCount = 0;
  let oldestSuccessAgeMs = 0;
  for (const entry of entries) {
    const inProgress = entry?.inProgress === true;
    if (inProgress) inProgressCount += 1;
    else if (Date.parse(entry?.nextDueAt ?? '') <= now) dueCount += 1;
    if (entry?.failureReason) failedCount += 1;
    const successAt = Date.parse(entry?.lastSuccessAt ?? '');
    const age = Number.isFinite(successAt) ? Math.max(0, now - successAt) : freshnessSlaMs + 1;
    if (age > freshnessSlaMs) overdueCount += 1;
    oldestSuccessAgeMs = Math.max(oldestSuccessAgeMs, age);
  }
  return {
    eligibleCount: entries.length,
    dueCount,
    overdueCount,
    failedCount,
    inProgressCount,
    oldestSuccessAgeMs,
  };
}

export function assessSavedMarketScannerHealth(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const poller = input.pollerHealth ?? null;
  const entries = input.scheduler?.entries ?? [];
  const queue = poller?.queue ?? { dueCount: 0, overdueCount: 0, oldestSuccessAgeMs: null };
  const lastAttemptAt = latest(entries, 'lastAttemptAt');
  const lastCompletionAt = latest(entries, 'lastSuccessAt');
  const owner = {
    pollerPid: poller?.pollerPid ?? null,
    commit: input.deployment?.commit ?? null,
    buildId: input.deployment?.buildId ?? null,
    workerPath: input.workerBundle?.path ?? null,
  };
  const base = {
    checkedAt: new Date(now).toISOString(),
    state: 'healthy',
    degradedReason: null,
    detail: null,
    owner,
    queue,
    lastAttemptAt,
    lastCompletionAt,
    oldestSuccessAgeMs: queue.oldestSuccessAgeMs ?? null,
    restartRecommended: false,
  };
  const degraded = (degradedReason, detail, restartRecommended = false) => ({
    ...base,
    state: 'degraded',
    degradedReason,
    detail,
    restartRecommended,
  });

  if (!input.workerBundle?.exists) {
    return degraded('missing_worker_bundle', `Promoted release is missing ${owner.workerPath ?? 'full-scan-worker.cjs'}`);
  }
  if (!input.scheduler?.readable) {
    return degraded('scheduler_state_unusable', input.scheduler?.error ?? 'Saved-market scheduler state is missing or corrupt', true);
  }
  if (input.expectedSchedulerVersion
    && poller?.schedulerVersion !== input.expectedSchedulerVersion) {
    return degraded(
      'poller_version_mismatch',
      `Poller scheduler ${poller?.schedulerVersion ?? 'missing'} does not match ${input.expectedSchedulerVersion}`,
      true,
    );
  }
  const staleLease = entries.find((entry) => entry?.inProgress
    && Number.isFinite(Date.parse(entry.leaseExpiresAt))
    && Date.parse(entry.leaseExpiresAt) + (input.staleLeaseGraceMs ?? DEFAULT_STALE_LEASE_GRACE_MS) <= now);
  if (staleLease) return degraded('stale_lease', `Expired scanner lease ${staleLease.leaseToken ?? 'unknown'} remains in progress`, true);

  const heartbeatAt = Date.parse(poller?.heartbeatAt ?? '');
  if (!poller || !Number.isFinite(heartbeatAt) || now - heartbeatAt > (input.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS)) {
    return degraded('poller_heartbeat_stale', 'Recurring scanner owner has no current scheduler heartbeat', true);
  }
  if (input.disk?.allowed === false) {
    return degraded('disk_capacity', input.disk.reason ?? 'Disk capacity gate is closed');
  }
  if (input.sqlite?.readable === false) {
    return degraded('sqlite_source_unusable', input.sqlite.error ?? 'SQLite contention metrics are unavailable');
  }
  const lastSqliteExhaustionMs = Date.parse(input.sqlite?.lastExhaustedAt ?? '');
  const sqliteContentionRecent = !Number.isFinite(lastSqliteExhaustionMs)
    || now - lastSqliteExhaustionMs <= (input.sqliteContentionWindowMs ?? DEFAULT_SQLITE_CONTENTION_WINDOW_MS);
  if ((input.sqlite?.exhaustedWrites ?? 0) > 0 && sqliteContentionRecent) {
    return degraded('sqlite_contention', `${input.sqlite.exhaustedWrites} SQLite scanner write(s) exhausted retry budget`);
  }
  if (input.telemetry?.readable === false) {
    return degraded('telemetry_source_unusable', input.telemetry.error ?? 'Worker telemetry health is missing or malformed');
  }
  if ((poller.openBreakers ?? 0) > 0 && (queue.overdueCount ?? 0) > 0) {
    return degraded('breaker_backlog', `${poller.openBreakers} open breaker(s) are holding ${queue.overdueCount} overdue market(s)`);
  }

  const lastCompletionMs = Date.parse(lastCompletionAt ?? '');
  if ((queue.overdueCount ?? 0) > 0
    && (poller.successCount ?? 0) === 0
    && (!Number.isFinite(lastCompletionMs) || now - lastCompletionMs > (input.progressStaleMs ?? DEFAULT_PROGRESS_STALE_MS))) {
    return degraded('no_scan_progress', `Overdue queue has ${queue.overdueCount} market(s) with no persisted full-scan progress`, true);
  }
  if ((poller.failureCount ?? 0) >= 3) {
    const reasons = [...new Set((poller.errors ?? []).map((error) => error.error).filter(Boolean))];
    return degraded('upstream_failures', `Recurring scans are repeatedly failing: ${reasons.join(', ') || 'unknown failure'}`);
  }
  if ((queue.overdueCount ?? 0) > 0) {
    const reasons = failureSummary(entries);
    return degraded(
      'overdue_failures',
      `${queue.overdueCount} overdue market(s) remain outside the freshness SLA${reasons ? `: ${reasons}` : ''}`,
    );
  }
  if (input.telemetry?.error || (input.telemetry?.pendingSnapshots ?? 0) > 0) {
    return degraded('telemetry_degraded', input.telemetry?.error ?? `${input.telemetry.pendingSnapshots} telemetry snapshot(s) pending`);
  }
  return base;
}