const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const DEFAULT_FRESHNESS_SLA_MS = 60 * 60_000;

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

export function isEligibleMarket(market, now = Date.now()) {
  const expiry = timestamp(market.expiryDate, Infinity);
  return expiry > now || market.lastScanResult?.priceResolved === false;
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
    const resultStatus = market.lastScanResult?.matchStatus;
    const marketSuccessAt = resultStatus !== 'unavailable' && resultStatus !== 'refreshing'
      ? market.lastScanResult?.scannedAt || null
      : null;
    const successfulScanAt = timestamp(marketSuccessAt) > timestamp(previous.lastSuccessAt)
      ? marketSuccessAt
      : previous.lastSuccessAt || marketSuccessAt || null;
    const manualSuccessAdvanced = timestamp(marketSuccessAt) > timestamp(previous.lastSuccessAt);
    const recovered = previous.inProgress === true;
    const dueFromSuccess = successfulScanAt ? timestamp(successfulScanAt, now) + freshnessSlaMs : now;
    state[market.id] = {
      lastAttemptAt: previous.lastAttemptAt || null,
      lastSuccessAt: successfulScanAt,
      nextDueAt: recovered
        ? iso(now)
        : manualSuccessAdvanced
          ? iso(Math.max(dueFromSuccess, timestamp(previous.nextDueAt, 0)))
          : previous.nextDueAt || iso(dueFromSuccess),
      inProgress: false,
      failureReason: recovered ? 'Scheduled scan interrupted because the worker restarted; retrying now.' : previous.failureReason || null,
      retryCount: Number.isInteger(previous.retryCount) && previous.retryCount >= 0 ? previous.retryCount : 0,
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

export function markAttemptStarted(item, now = Date.now()) {
  item.lastAttemptAt = iso(now);
  item.inProgress = true;
  item.failureReason = null;
}

export function completeAttempt(item, outcome, now = Date.now(), freshnessSlaMs = 60 * 60_000, requestedIntervalMs = freshnessSlaMs) {
  freshnessSlaMs = positiveFinite(freshnessSlaMs, DEFAULT_FRESHNESS_SLA_MS);
  requestedIntervalMs = positiveFinite(requestedIntervalMs, freshnessSlaMs);
  item.inProgress = false;
  if (outcome.ok) {
    item.lastSuccessAt = iso(now);
    item.failureReason = null;
    item.retryCount = 0;
    const boundedInterval = Math.max(1_000, Math.min(freshnessSlaMs, requestedIntervalMs));
    item.nextDueAt = iso(now + boundedInterval);
    return;
  }

  item.retryCount += 1;
  item.failureReason = outcome.error || 'Scheduled scan failed without an error reason.';
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, item.retryCount - 1));
  item.nextDueAt = iso(Math.max(now + backoff, positiveFinite(outcome.retryAt, 0)));
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
