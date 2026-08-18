const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const DEFAULT_FRESHNESS_SLA_MS = 60 * 60_000;
const SLA_CAPACITY_UTILIZATION = 1;

function iso(ms) {
  return new Date(ms).toISOString();
}

function timestamp(value, fallback = 0) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveFinite(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseBoundedNumber(value, fallback, minimum, maximum, integer = false) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  const bounded = Math.min(maximum, parsed);
  return integer ? Math.floor(bounded) : bounded;
}

export function classifyScanHttpFailure(status, body = {}, retryAfter = null, now = Date.now()) {
  const text = typeof body?.error === 'string' ? body.error : '';
  const errorCode = body?.code === 'DISK_CAPACITY'
    ? 'DISK_CAPACITY'
    : status === 503 && /scanner is at capacity/i.test(text)
      ? 'SCAN_CAPACITY'
      : null;
  const retrySeconds = Number(retryAfter);
  return {
    error: `HTTP ${status}${errorCode ? ` (${errorCode})` : ''}`,
    errorCode,
    countsTowardBreaker: errorCode === null,
    retryAt: Number.isFinite(retrySeconds) && retrySeconds >= 0 ? now + retrySeconds * 1_000 : null,
  };
}

export function minimumConcurrencyForSla(eligibleCount, timeoutMs, freshnessSlaMs) {
  if (!Number.isFinite(eligibleCount) || eligibleCount <= 0) return 1;
  const timeout = positiveFinite(timeoutMs, 60_000);
  const sla = positiveFinite(freshnessSlaMs, DEFAULT_FRESHNESS_SLA_MS);
  return Math.max(1, Math.ceil((eligibleCount * timeout) / (sla * SLA_CAPACITY_UTILIZATION)));
}

function successfulPublication(result) {
  return result?.matchStatus === 'matched' || result?.matchStatus === 'confirmed_zero';
}

export function isEligibleMarket(market, now = Date.now()) {
  const expiry = timestamp(market.expiryDate, Infinity);
  return expiry > now || market.lastScanResult?.priceResolved === false;
}

export function hasNewerSuccessfulMarketScan(market, previous = {}) {
  if (!successfulPublication(market.lastScanResult)) return false;
  return timestamp(market.lastScanResult?.scannedAt) > timestamp(previous.lastSuccessAt);
}

export function resetBreakerAfterExternalSuccess(stats) {
  if (!stats) return false;
  stats.consecFails = 0;
  stats.trips = 0;
  stats.cooldownUntil = 0;
  return true;
}

export function buildSchedulerState(markets, persisted = {}, now = Date.now(), freshnessSlaMs = 60 * 60_000) {
  freshnessSlaMs = positiveFinite(freshnessSlaMs, DEFAULT_FRESHNESS_SLA_MS);
  const state = {};
  for (const market of markets) {
    const previous = persisted[market.id] || {};
    // A successful manual scan may be newer than scheduler state and counts as
    // a full-scan success without changing queue order. Failed /api/scan
    // diagnostics explicitly publish unavailable/refreshing and must not
    // advance freshness.
    const marketSuccessAt = successfulPublication(market.lastScanResult)
      ? market.lastScanResult?.scannedAt || null
      : null;
    const successfulScanAt = timestamp(marketSuccessAt) > timestamp(previous.lastSuccessAt)
      ? marketSuccessAt
      : previous.lastSuccessAt || marketSuccessAt || null;
    const manualSuccessAdvanced = hasNewerSuccessfulMarketScan(market, previous);
    const leaseExpiresAt = timestamp(previous.leaseExpiresAt);
    const leaseActive = previous.inProgress === true && leaseExpiresAt > now;
    const recovered = previous.inProgress === true && !leaseActive;
    const dueFromSuccess = successfulScanAt ? timestamp(successfulScanAt, now) + freshnessSlaMs : now;
    state[market.id] = {
      lastAttemptAt: previous.lastAttemptAt || null,
      lastSuccessAt: successfulScanAt,
      nextDueAt: recovered
        ? iso(now)
        : manualSuccessAdvanced
          ? iso(dueFromSuccess)
          : previous.nextDueAt || iso(dueFromSuccess),
      inProgress: leaseActive,
      leaseOwnerId: leaseActive ? previous.leaseOwnerId || null : null,
      leaseToken: leaseActive ? previous.leaseToken || null : null,
      leaseExpiresAt: leaseActive ? previous.leaseExpiresAt : null,
      failureReason: recovered
        ? 'Scheduled scan interrupted because the worker restarted; retrying now.'
        : manualSuccessAdvanced ? null : previous.failureReason || null,
      retryCount: manualSuccessAdvanced
        ? 0
        : Number.isInteger(previous.retryCount) && previous.retryCount >= 0 ? previous.retryCount : 0,
      freshnessSlaMs,
    };
  }
  return state;
}

export function selectDueMarkets(markets, state, now = Date.now(), limit = markets.length) {
  return markets
    .filter(market => {
      const item = state[market.id];
      return item && !item.inProgress && timestamp(item.nextDueAt, 0) <= now;
    })
    .sort((a, b) => {
      const left = state[a.id];
      const right = state[b.id];
      const dueDelta = timestamp(left.nextDueAt, 0) - timestamp(right.nextDueAt, 0);
      if (dueDelta !== 0) return dueDelta;
      const attemptDelta = timestamp(left.lastAttemptAt, 0) - timestamp(right.lastAttemptAt, 0);
      return attemptDelta !== 0 ? attemptDelta : a.id.localeCompare(b.id);
    })
    .slice(0, Math.max(0, limit));
}

export function markAttemptStarted(item, now = Date.now(), lease = null) {
  item.lastAttemptAt = iso(now);
  item.inProgress = true;
  item.leaseOwnerId = lease?.ownerId || null;
  item.leaseToken = lease?.token || null;
  item.leaseExpiresAt = lease?.expiresAt || null;
  item.failureReason = null;
}

export function completeAttempt(item, outcome, now = Date.now(), freshnessSlaMs = 60 * 60_000, requestedIntervalMs = freshnessSlaMs) {
  freshnessSlaMs = positiveFinite(freshnessSlaMs, DEFAULT_FRESHNESS_SLA_MS);
  requestedIntervalMs = positiveFinite(requestedIntervalMs, freshnessSlaMs);
  item.inProgress = false;
  item.leaseOwnerId = null;
  item.leaseToken = null;
  item.leaseExpiresAt = null;
  if (outcome.ok) {
    item.lastSuccessAt = iso(now);
    item.failureReason = null;
    item.retryCount = 0;
    const boundedInterval = Math.max(1_000, Math.min(freshnessSlaMs, requestedIntervalMs));
    item.nextDueAt = iso(now + boundedInterval);
    return;
  }

  if (outcome.retryWithoutPenalty) {
    item.failureReason = outcome.error || 'Scheduled scan paused by a global scanner dependency.';
    item.nextDueAt = iso(Math.max(now + 1_000, positiveFinite(outcome.retryAt, now + RETRY_BASE_MS)));
    return;
  }
  item.retryCount += 1;
  item.failureReason = outcome.error || 'Scheduled scan failed without an error reason.';
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, item.retryCount - 1));
  item.nextDueAt = iso(Math.max(now + backoff, positiveFinite(outcome.retryAt, 0)));
}

export function schedulerLeaseCanStart(item, lease, now = Date.now()) {
  if (typeof lease?.token !== 'string' || lease.token.length === 0) return false;
  if (timestamp(lease.expiresAt) <= now) return false;
  if (!item?.inProgress) return true;
  if (item.leaseToken && item.leaseToken === lease?.token) return true;
  return timestamp(item.leaseExpiresAt) <= now;
}

export function schedulerLeaseMatches(item, leaseToken, now = Date.now()) {
  return item?.inProgress === true
    && typeof leaseToken === 'string'
    && leaseToken.length > 0
    && item.leaseToken === leaseToken
    && timestamp(item.leaseExpiresAt) > now;
}

export function schedulerMetrics(markets, state, now = Date.now(), freshnessSlaMs = 60 * 60_000) {
  freshnessSlaMs = positiveFinite(freshnessSlaMs, DEFAULT_FRESHNESS_SLA_MS);
  let dueCount = 0;
  let overdueCount = 0;
  let failedCount = 0;
  let inProgressCount = 0;
  let oldestSuccessAgeMs = 0;
  for (const market of markets) {
    const item = state[market.id];
    if (!item) continue;
    if (item.inProgress) inProgressCount += 1;
    else if (timestamp(item.nextDueAt, 0) <= now) dueCount += 1;
    if (item.failureReason) failedCount += 1;
    const successAt = timestamp(item.lastSuccessAt, timestamp(market.createdAt, now));
    const age = Math.max(0, now - successAt);
    oldestSuccessAgeMs = Math.max(oldestSuccessAgeMs, age);
    if (age > freshnessSlaMs) overdueCount += 1;
  }
  return {
    eligibleCount: markets.length,
    dueCount,
    overdueCount,
    failedCount,
    inProgressCount,
    oldestSuccessAgeMs,
  };
}
