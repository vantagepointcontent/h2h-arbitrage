// Node.js poller (ES module) - polls saved markets with adaptive refresh rates
// Run via: pm2 start scripts/poll.mjs --name h2h-poller

const BASE_URL = process.env.H2H_BASE_URL || 'http://100.86.7.30:3000';
const SCHEDULER_VERSION = 'bug-150-v1';
let POLL_CONCURRENCY;
let FRESHNESS_SLA_MS;
// Base wake-up interval. Poller wakes this often to check which markets are due.
// 60s — gentle, since most markets have 5-30min adaptive intervals.
const POLL_WAKE_MS = Math.max(1_000, Number(process.env.H2H_POLL_WAKE_MS) || 60_000);
let SCAN_TIMEOUT_MS;
const SCAN_LEASE_GRACE_MS = Math.max(100, Number(process.env.H2H_SCAN_LEASE_GRACE_MS) || 5_000);

// ── SETTINGS-001: hot-reload scanner settings from /api/settings ──────────
// DB-backed overrides beat env. Refreshed each wake cycle; failures keep
// current values (env/default) so the poller never stalls on the app.
async function refreshScannerSettings() {
  try {
    const res = await fetch(`${BASE_URL}/api/settings`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const { settings } = await res.json();
    const get = (k) => settings?.find?.((s) => s.key === k)?.value;
    const conc = Number(get('scanner.pollConcurrency'));
    const tmo = Number(get('scanner.scanTimeoutMs'));
    if (Number.isFinite(conc) && conc >= 1 && conc <= 20 && conc !== POLL_CONCURRENCY) {
      console.log(`[settings] pollConcurrency ${POLL_CONCURRENCY} -> ${conc}`);
      POLL_CONCURRENCY = conc;
    }
    if (Number.isFinite(tmo) && tmo >= 5000 && tmo <= 300000 && tmo !== SCAN_TIMEOUT_MS) {
      console.log(`[settings] scanTimeoutMs ${SCAN_TIMEOUT_MS} -> ${tmo}`);
      SCAN_TIMEOUT_MS = tmo;
    }
  } catch { /* app unreachable — keep current values */ }
}
// Path overrides let runtime verification exercise the production poller
// against an isolated state directory without touching deployed data.
const DATA_FILE = process.env.H2H_SAVED_MARKETS_FILE || new URL('../data/saved-markets.json', import.meta.url).pathname;
const HEALTH_FILE = process.env.H2H_POLLER_HEALTH_FILE || new URL('../data/poller-health.json', import.meta.url).pathname;
const BREAKER_FILE = process.env.H2H_POLLER_BREAKER_FILE || new URL('../data/poller-breaker.json', import.meta.url).pathname;
const SCHEDULER_FILE = process.env.H2H_SAVED_MARKET_SCHEDULER_FILE || new URL('../data/saved-market-scheduler.json', import.meta.url).pathname;
const LEASE_DIRECTORY = process.env.H2H_SAVED_MARKET_LEASE_DIRECTORY || new URL('../data/saved-market-leases', import.meta.url).pathname;
const ADAPTIVE_CONFIG_FILE = new URL('../src/data/adaptive-refresh-config.json', import.meta.url).pathname;
const fs = await import('fs');
const {
  buildSchedulerState,
  completeAttempt,
  hasNewerSuccessfulMarketScan,
  isEligibleMarket,
  markAttemptStarted,
  minimumConcurrencyForSla,
  parseBoundedNumber,
  resetBreakerAfterExternalSuccess,
  schedulerLeaseCanStart,
  schedulerLeaseMatches,
  selectDueMarkets,
  schedulerMetrics,
} = await import('./poll-scheduler.mjs');
const { acquireMarketLease, releaseMarketLease } = await import('./poll-lease.mjs');
const { updateSchedulerState } = await import('./poll-state.mjs');
const { readSavedMarketsFailSafe } = await import('./poll-data.mjs');
POLL_CONCURRENCY = parseBoundedNumber(process.env.H2H_POLL_CONCURRENCY, 5, 1, 20, true);
SCAN_TIMEOUT_MS = parseBoundedNumber(process.env.H2H_SCAN_TIMEOUT_MS, 60_000, 5_000, 300_000, true);
FRESHNESS_SLA_MS = parseBoundedNumber(
  process.env.H2H_SAVED_MARKET_FRESHNESS_SLA_MS,
  60 * 60_000,
  5 * 60_000,
  24 * 60 * 60_000,
  true,
);
// FEAT-046: refresh all-platform catalog once daily at 04:00 UTC via PM2 cron.
// The previous 6-hour interval is replaced by a single off-peak daily run so
// the catalog job never interferes with normal user-triggered scans.
const CATALOG_CRON = '0 4 * * *';
let lastCatalogRunAt = 0;
let catalogJobRunning = false;

async function runDailyCatalogRefresh() {
  if (catalogJobRunning) return;
  catalogJobRunning = true;
  try {
    console.log(`[${new Date().toISOString()}] Starting daily catalog refresh`);
    const res = await fetch(`${BASE_URL}/api/catalog/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.H2H_API_TOKEN ? { 'x-h2h-token': process.env.H2H_API_TOKEN } : {}),
      },
      signal: AbortSignal.timeout(3_600_000), // 1 hour max for full refresh
    });
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      console.log(`[${new Date().toISOString()}] Daily catalog refresh OK:`, JSON.stringify(json));
    } else {
      console.warn(`[${new Date().toISOString()}] Daily catalog refresh failed: HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`[${new Date().toISOString()}] Daily catalog refresh error:`, e.message);
  } finally {
    catalogJobRunning = false;
    lastCatalogRunAt = Date.now();
  }
}

// Legacy helper kept for backwards compatibility; now only called manually or by cron.
async function triggerCatalogSync() {
  return runDailyCatalogRefresh();
}


// UI-033: snapshot rate-limiter metrics every ~60s so the dashboard can show
// historical API capacity utilization. We track the last snapshot time
// independently of the main poll cycle so market scans don't starve it.
let lastLimiterSnapshotAt = 0;
const LIMITER_SNAPSHOT_INTERVAL_MS = 60000;

async function snapshotLimiters() {
  try {
    const res = await fetch(`${BASE_URL}/api/snapshot-limiters`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.H2H_API_TOKEN ? { 'x-h2h-token': process.env.H2H_API_TOKEN } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      console.log(`[${new Date().toISOString()}] Limiter snapshot OK: ${json.persisted ?? '?'} limiters`);
    } else {
      console.warn(`[${new Date().toISOString()}] Limiter snapshot failed: HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`[${new Date().toISOString()}] Limiter snapshot error:`, e.message);
  }
}

// ── Adaptive timeout + circuit breaker (per-market scan stats) ────────────
// Problem this solves: a fixed 60s timeout for every market means one bad
// cycle (app restart, upstream outage, chronically slow market) burns
// 60s × N with zero coverage. Instead:
//   • adaptive timeout: EWMA of each market's scan duration → timeout is
//     3× its typical duration (clamped 15s..SCAN_TIMEOUT_MS). Fast markets
//     fail fast; genuinely slow markets keep their headroom.
//   • circuit breaker: 3 consecutive failures → market on cooldown with
//     exponential backoff (5min → 10 → 20 → 40, capped 60min). One probe
//     scan after cooldown (half-open); success resets everything.
// State persists across poller restarts via BREAKER_FILE.
const TIMEOUT_FLOOR_MS = parseBoundedNumber(
  process.env.H2H_SCAN_MIN_TIMEOUT_MS,
  8_000,
  1_000,
  SCAN_TIMEOUT_MS,
  true,
);
const TIMEOUT_MULTIPLIER = 3;
const BREAKER_THRESHOLD = 3;          // consecutive failures to trip
const BREAKER_BASE_COOLDOWN_MS = 5 * 60_000;
const BREAKER_MAX_COOLDOWN_MS = 60 * 60_000;

const scanStats = new Map(); // marketId -> { avgMs, consecFails, trips, cooldownUntil }
const dirtyBreakerIds = new Set();
let schedulerState = {};
let schedulerWriteQueue = Promise.resolve();
const pollerOwnerId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function loadSchedulerState() {
  try {
    schedulerState = JSON.parse(fs.readFileSync(SCHEDULER_FILE, 'utf-8')) || {};
  } catch {
    schedulerState = {};
  }
}

async function saveMarketSchedulerState(marketId, guard = null) {
  const snapshot = JSON.parse(JSON.stringify(schedulerState[marketId]));
  let saved = false;
  schedulerWriteQueue = schedulerWriteQueue
    .catch(() => {})
    .then(() => updateSchedulerState(SCHEDULER_FILE, persisted => {
      if (guard?.phase === 'start' && !schedulerLeaseCanStart(persisted[marketId], guard.lease, Date.now())) return;
      if (guard?.phase === 'terminal' && !schedulerLeaseMatches(persisted[marketId], guard.leaseToken)) return;
      persisted[marketId] = snapshot;
      saved = true;
    }));
  schedulerState = await schedulerWriteQueue;
  return saved;
}

async function reconcileSchedulerState(markets) {
  let manualSuccessIds = new Set();
  schedulerWriteQueue = schedulerWriteQueue
    .catch(() => {})
    .then(() => updateSchedulerState(SCHEDULER_FILE, persisted => {
      manualSuccessIds = new Set(markets
        .filter(market => hasNewerSuccessfulMarketScan(market, persisted[market.id]))
        .map(market => market.id));
      const reconciled = buildSchedulerState(markets, persisted, Date.now(), FRESHNESS_SLA_MS);
      for (const market of markets) persisted[market.id] = reconciled[market.id];
    }));
  schedulerState = await schedulerWriteQueue;
  return manualSuccessIds;
}

function loadBreakerState() {
  try {
    const raw = JSON.parse(fs.readFileSync(BREAKER_FILE, 'utf-8'));
    for (const [id, s] of Object.entries(raw)) scanStats.set(id, s);
    console.log(`[${new Date().toISOString()}] Loaded breaker state for ${scanStats.size} market(s)`);
  } catch { /* first run or corrupt file — start clean */ }
}

async function saveBreakerState() {
  try {
    const updates = new Map([...dirtyBreakerIds].map(id => [id, scanStats.get(id)]));
    if (updates.size === 0) return;
    await updateSchedulerState(BREAKER_FILE, persisted => {
      for (const [id, state] of updates) {
        if (state && (state.avgMs || state.consecFails > 0 || (state.cooldownUntil && state.cooldownUntil > Date.now()))) {
          persisted[id] = JSON.parse(JSON.stringify(state));
        } else {
          delete persisted[id];
        }
      }
    });
    for (const id of updates.keys()) dirtyBreakerIds.delete(id);
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] Failed saving breaker state:`, err.message);
  }
}

function getStats(marketId) {
  let s = scanStats.get(marketId);
  if (!s) { s = { avgMs: 0, consecFails: 0, trips: 0, cooldownUntil: 0 }; scanStats.set(marketId, s); }
  return s;
}

function adaptiveTimeoutMs(marketId) {
  const s = scanStats.get(marketId);
  if (!s || !s.avgMs) return SCAN_TIMEOUT_MS; // no history yet — full headroom
  return Math.min(SCAN_TIMEOUT_MS, Math.max(TIMEOUT_FLOOR_MS, Math.round(s.avgMs * TIMEOUT_MULTIPLIER)));
}

function recordScanOutcome(marketId, ok, durationMs) {
  const s = getStats(marketId);
  dirtyBreakerIds.add(marketId);
  if (ok) {
    // EWMA (α=0.3): adapts to shifts without overreacting to one slow scan
    s.avgMs = s.avgMs ? Math.round(0.7 * s.avgMs + 0.3 * durationMs) : durationMs;
    s.consecFails = 0;
    s.trips = 0;
    s.cooldownUntil = 0;
  } else {
    s.consecFails += 1;
    if (s.consecFails >= BREAKER_THRESHOLD) {
      const cooldown = Math.min(BREAKER_MAX_COOLDOWN_MS, BREAKER_BASE_COOLDOWN_MS * 2 ** s.trips);
      s.cooldownUntil = Date.now() + cooldown;
      s.trips += 1;
      s.consecFails = 0; // half-open: one probe scan allowed after cooldown
      console.log(`[${new Date().toISOString()}] Circuit breaker OPEN for market ${marketId} — cooldown ${formatInterval(cooldown)} (trip #${s.trips})`);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Adaptive refresh helpers ──────────────────────────────────────────────

/**
 * Default tier boundaries (seconds until expiry → interval in seconds).
 * Loaded from config file, with sensible defaults if file is missing.
 */
const DEFAULT_TIERS = [
  { maxSeconds: 3600,      intervalSec: 15 },  // <1h
  { maxSeconds: 21600,     intervalSec: 60 },  // 1-6h
  { maxSeconds: 86400,     intervalSec: 300 }, // 6-24h
  { maxSeconds: Infinity,  intervalSec: 900 },// >24h
];
const FALLBACK_INTERVAL_MS = 300 * 1000; // 5 min for markets without expiry

function loadAdaptiveConfig() {
  try {
    const raw = fs.readFileSync(ADAPTIVE_CONFIG_FILE, 'utf-8');
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg.enabled !== 'boolean') return null;
    return {
      enabled: cfg.enabled,
      tiers: (cfg.tiers || DEFAULT_TIERS).map(t => ({
        ...t,
        maxSeconds: t.maxSeconds === -1 ? Infinity : t.maxSeconds,
        // Accept both intervalSec (DEFAULT_TIERS) and defaultIntervalSec (config file)
        intervalSec: t.intervalSec ?? t.defaultIntervalSec,
      })),
      globalMultiplier: cfg.globalMultiplier ?? 1,
      // DATA-002: category multipliers — low-yield categories poll less often.
      // Based on 7-day lifecycle data: Politics/Sports produce 97% of durable arbs.
      categoryMultipliers: cfg.categoryMultipliers || {},
    };
  } catch {
    return null;
  }
}

/**
 * Compute adaptive refresh interval (ms) for a market.
 * Returns FALLBACK_INTERVAL_MS when expiryDate is absent or malformed.
 */
function getAdaptiveIntervalMs(market, config) {
  if (!config || !config.enabled) {
    return POLL_WAKE_MS * 2; // legacy: roughly 30s
  }
  const expiryStr = market.expiryDate;
  if (!expiryStr) return FALLBACK_INTERVAL_MS * config.globalMultiplier;

  const expiryMs = new Date(expiryStr).getTime();
  if (isNaN(expiryMs)) return FALLBACK_INTERVAL_MS * config.globalMultiplier;

  const secondsToExpiry = Math.round((expiryMs - Date.now()) / 1000);
  if (secondsToExpiry <= 0) return Infinity; // expired — never poll again (BUG-033)
  const mult = config.globalMultiplier;

  // DATA-002: apply category multiplier on top of the global multiplier.
  // Low-yield categories (entertainment, tech, finances, etc.) get slower
  // polling based on 7-day lifecycle data showing they rarely produce arbs.
  const catKey = (market.category || 'uncategorized').toLowerCase();
  const catMult = config.categoryMultipliers?.[catKey] ?? 1;
  const totalMult = mult * catMult;

  for (const tier of config.tiers) {
    if (secondsToExpiry <= tier.maxSeconds) {
      return tier.intervalSec * 1000 * totalMult;
    }
  }
  // Fallback to last tier
  const last = config.tiers[config.tiers.length - 1];
  return last.intervalSec * 1000 * totalMult;
}

// ── File I/O ──────────────────────────────────────────────────────────────

async function loadSavedMarkets() {
  return readSavedMarketsFailSafe(DATA_FILE);
}

async function writeJsonAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));

  let renamed = false;
  let attempts = 0;
  while (!renamed && attempts < 5) {
    try {
      await fs.promises.rename(tmp, path);
      renamed = true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        attempts += 1;
        await sleep(50 + Math.random() * 100);
      } else {
        throw err;
      }
    }
  }

  if (!renamed) {
    await fs.promises.writeFile(path, JSON.stringify(data, null, 2));
  }

  try {
    await fs.promises.copyFile(path, `${path}.bak`);
  } catch {}
}

// OPS-009: saveMarkets removed — poller is now READ-ONLY on saved-markets.json.

async function writeHealth(health) {
  try {
    await writeJsonAtomic(HEALTH_FILE, health);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed writing poller health:`, err.message);
  }
}

// ── Scan logic ────────────────────────────────────────────────────────────

async function scanMarket(market) {
  const timeoutMs = adaptiveTimeoutMs(market.id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const started = Date.now();
    const res = await fetch(`${BASE_URL}/api/scan?skipManual=1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-h2h-scan-source': 'saved-market-poller',
        ...(process.env.H2H_API_TOKEN ? { 'x-h2h-token': process.env.H2H_API_TOKEN } : {}),
      },
      body: JSON.stringify({ kalshiUrl: market.kalshiUrl, polymarketUrl: market.polymarketUrl }),
      signal: controller.signal,
    });
    const durationMs = Date.now() - started;
    if (!res.ok) {
      clearTimeout(timer);
      return { ok: false, durationMs, error: `HTTP ${res.status}` };
    }
    const result = await res.json();
    clearTimeout(timer);
    if (result?.fullScanPersisted !== true) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: 'Scan API returned without a persisted full-scan result',
      };
    }
    return { ok: true, durationMs: Date.now() - started, result };
  } catch (e) {
    clearTimeout(timer);
    const timedOut = e.name === 'AbortError';
    const msg = timedOut ? `timeout after ${timeoutMs}ms (adaptive)` : (e.message || String(e));
    return { ok: false, durationMs: timeoutMs, error: msg, timedOut };
  }
}

function extractAllArbitrages(result) {
  const outcomes = result.outcomes || [];
  const positive = [];
  let best = null;

  for (const o of outcomes) {
    const arb = o.arbitrage || {};
    if (arb.roiPct > 0) {
      positive.push({
        artist: o.artist,
        roiPct: arb.roiPct,
        expectedProfit: arb.expectedProfit,
        strategy: arb.strategy,
        kalshiStake: arb.kalshiStake || 0,
        pmStake: arb.pmStake || 0,
        totalStake: (arb.kalshiStake || 0) + (arb.pmStake || 0),
      });
      if (!best || arb.roiPct > best.roiPct) {
        best = {
          roiPct: arb.roiPct,
          profit: arb.expectedProfit,
          strategy: arb.strategy,
          outcome: o.artist,
          kalshiStake: arb.kalshiStake || 0,
          pmStake: arb.pmStake || 0,
          totalStake: (arb.kalshiStake || 0) + (arb.pmStake || 0),
        };
      }
    }
  }

  if (!best) {
    for (const o of outcomes) {
      const arb = o.arbitrage || {};
      if (!best || arb.roiPct > best.roiPct) {
        best = {
          roiPct: Math.max(0, arb.roiPct),
          profit: Math.max(0, arb.expectedProfit),
          strategy: arb.strategy,
          outcome: o.artist,
          kalshiStake: arb.kalshiStake || 0,
          pmStake: arb.pmStake || 0,
          totalStake: (arb.kalshiStake || 0) + (arb.pmStake || 0),
        };
      }
    }
  }

  return { best, all: positive };
}

function formatRoi(roi) {
  return roi > 0 ? `+${roi.toFixed(2)}%` : `${roi.toFixed(2)}%`;
}

function applyScanResultToMarket(market, result) {
  const matchedOutcomes = (result.outcomes || []).filter(o => o.kalshi && o.polymarket);
  const matchedCount = matchedOutcomes.length;
  const { best, all } = extractAllArbitrages(result);

  if (best) {
    market.lastScanResult = {
      bestRoiPct: best.roiPct,
      bestProfit: best.profit,
      strategy: best.strategy,
      outcomeCount: matchedCount,
      matchedCount,
      kalshiCount: result.kalshiCount,
      pmCount: result.pmCount,
      scannedAt: new Date().toISOString(),
      allArbs: all,
    };
    if (result.expiryDate && !market.expiryDate) {
      market.expiryDate = result.expiryDate;
    }
    return { best, all, matchedCount };
  }

  market.lastScanResult = {
    bestRoiPct: 0,
    bestProfit: 0,
    strategy: '',
    outcomeCount: matchedCount,
    matchedCount,
    kalshiCount: result.kalshiCount,
    pmCount: result.pmCount,
    scannedAt: new Date().toISOString(),
    allArbs: [],
  };
  return { best: null, all: [], matchedCount };
}

async function mapWithConcurrency(items, limit, worker, onProgress = null) {
  const results = new Array(items.length);
  let next = 0;

  async function runWorker() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index], index);
      } finally {
        await onProgress?.(index);
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, runWorker);
  await Promise.all(workers);
  return results;
}

// ── Format adaptive interval for logging ──────────────────────────────────

function formatInterval(ms) {
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${Math.round(min)}m`;
  return `${Math.round(min / 60)}h ${Math.round(min % 60)}m`;
}

// ── Poll cycle ────────────────────────────────────────────────────────────

async function pollOnce() {
  const startedAt = new Date();

  // FEAT-046: trigger the daily catalog refresh at 04:00 UTC. We keep a local
  // guard so we don't re-run if the process restarts later the same day.
  const nowUtc = new Date();
  const currentDay = nowUtc.toISOString().slice(0, 10);
  const currentHourMinute = `${String(nowUtc.getUTCHours()).padStart(2, '0')}:${String(nowUtc.getUTCMinutes()).padStart(2, '0')}`;
  if (currentHourMinute >= '04:00' && lastCatalogRunAt < new Date(`${currentDay}T04:00:00Z`).getTime()) {
    await runDailyCatalogRefresh();
  }

  const cycleStart = Date.now();

  // UI-033: snapshot rate-limiter metrics every ~60s. This is independent of
  // how many markets are due and runs at the start of each poll cycle.
  if (Date.now() - lastLimiterSnapshotAt >= LIMITER_SNAPSHOT_INTERVAL_MS) {
    lastLimiterSnapshotAt = Date.now();
    await snapshotLimiters();
  }

  // Reload adaptive config each cycle (hot-reload friendly)
  const adaptiveConfig = loadAdaptiveConfig();
  const adaptiveEnabled = adaptiveConfig?.enabled ?? false;

  const savedMarkets = await loadSavedMarkets();
  const markets = savedMarkets.filter(market => isEligibleMarket(market));
  const health = {
    status: 'running',
    schedulerVersion: SCHEDULER_VERSION,
    pollerPid: process.pid,
    heartbeatAt: startedAt.toISOString(),
    baseUrl: BASE_URL,
    concurrency: POLL_CONCURRENCY,
    intervalMs: adaptiveEnabled ? 'adaptive' : POLL_WAKE_MS * 2,
    adaptiveEnabled,
    marketCount: savedMarkets.length,
    eligibleMarketCount: markets.length,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    successCount: 0,
    failureCount: 0,
    skippedCount: 0,
    avgScanMs: 0,
    maxScanMs: 0,
    errors: [],
  };
  const requiredConcurrency = minimumConcurrencyForSla(markets.length, SCAN_TIMEOUT_MS, FRESHNESS_SLA_MS);
  health.capacity = {
    configuredConcurrency: POLL_CONCURRENCY,
    requiredConcurrency,
    sufficientForFreshnessSla: POLL_CONCURRENCY >= requiredConcurrency,
  };
  if (!health.capacity.sufficientForFreshnessSla) {
    console.error(`[${new Date().toISOString()}] Poller capacity below freshness SLA: configured=${POLL_CONCURRENCY}, required=${requiredConcurrency}, eligible=${markets.length}`);
  }
  await writeHealth(health);

  if (markets.length === 0) {
    console.log(`[${new Date().toISOString()}] No saved markets. Sleeping ${Math.round(POLL_WAKE_MS / 1000)}s...`);
    health.status = 'idle';
    health.finishedAt = new Date().toISOString();
    health.durationMs = Date.now() - cycleStart;
    await writeHealth(health);
    return health;
  }

  // Persisted oldest-due-first scheduling replaces array-order scans. A
  // restart recovers interrupted entries as due, and failures back off without
  // letting the same prefix monopolize every cycle.
  const manualSuccessIds = await reconcileSchedulerState(markets);
  const cooldownAdjustedIds = [];
  for (const market of markets) {
    if (manualSuccessIds.has(market.id)) {
      resetBreakerAfterExternalSuccess(scanStats.get(market.id));
      dirtyBreakerIds.add(market.id);
    }
    const cooldownUntil = scanStats.get(market.id)?.cooldownUntil;
    if (cooldownUntil > Date.now() && cooldownUntil > Date.parse(schedulerState[market.id].nextDueAt)) {
      schedulerState[market.id].nextDueAt = new Date(cooldownUntil).toISOString();
      cooldownAdjustedIds.push(market.id);
    }
  }
  for (const marketId of cooldownAdjustedIds) await saveMarketSchedulerState(marketId);
  const dueMarkets = selectDueMarkets(markets, schedulerState, Date.now(), markets.length);
  health.skippedCount = markets.length - dueMarkets.length;
  health.freshnessSlaMs = FRESHNESS_SLA_MS;
  health.queue = schedulerMetrics(markets, schedulerState, Date.now(), FRESHNESS_SLA_MS);
  if (dueMarkets.length === 0) {
    console.log(`[${new Date().toISOString()}] No markets due for refresh (${markets.length} total, all within interval). Sleeping ${Math.round(POLL_WAKE_MS / 1000)}s...`);
    health.status = 'idle';
    health.finishedAt = new Date().toISOString();
    health.durationMs = Date.now() - cycleStart;
    await writeHealth(health);
    // A newer durable manual scan resets any persisted breaker. Save that
    // reconciliation before returning so an immediate restart cannot restore
    // the stale cooldown and push nextDueAt beyond the freshness SLA.
    await saveBreakerState();
    return health;
  }

  const scanDurations = [];
  let completedDueCount = 0;
  let heartbeatWrite = Promise.resolve();
  const heartbeatTimer = setInterval(() => {
    health.heartbeatAt = new Date().toISOString();
    health.progress = { completedDueCount, dueCount: dueMarkets.length };
    const snapshot = { ...health, progress: { ...health.progress } };
    heartbeatWrite = heartbeatWrite.then(() => writeHealth(snapshot));
  }, 30_000);
  heartbeatTimer.unref?.();
  try {
    await mapWithConcurrency(dueMarkets, POLL_CONCURRENCY, async (market) => {
    // The scheduler JSON is diagnostic state, not a mutual-exclusion primitive.
    // An atomic per-market filesystem lease fences overlapping PM2 instances;
    // expiry bounds recovery when an owner dies without running finally.
    const leaseTtlMs = Math.max(adaptiveTimeoutMs(market.id), SCAN_TIMEOUT_MS) + SCAN_LEASE_GRACE_MS;
    const lease = await acquireMarketLease(LEASE_DIRECTORY, market.id, pollerOwnerId, leaseTtlMs);
    if (!lease) {
      health.skippedCount += 1;
      return;
    }

    let scan = null;
    try {
      markAttemptStarted(schedulerState[market.id], Date.now(), lease);
      const claimed = await saveMarketSchedulerState(market.id, { phase: 'start', lease });
      if (!claimed) {
        health.skippedCount += 1;
        console.warn(`[${new Date().toISOString()}] Scheduler generation changed before scan start for ${market.eventTitle}; skipping stale lease`);
        return;
      }
      scan = await scanMarket(market);
      scanDurations.push(scan.durationMs || 0);

      if (!scan.ok || !scan.result || scan.result.fullScanPersisted !== true) {
        const breakerRetryAt = scanStats.get(market.id)?.cooldownUntil;
        completeAttempt(schedulerState[market.id], {
          ok: false,
          error: scan.error || 'Scan completed but durable saved-market publication failed',
          retryAt: breakerRetryAt,
        }, Date.now(), FRESHNESS_SLA_MS);
        const saved = await saveMarketSchedulerState(market.id, { phase: 'terminal', leaseToken: lease.token });
        if (!saved) {
          health.skippedCount += 1;
          console.warn(`[${new Date().toISOString()}] Ignored stale failure completion for ${market.eventTitle}; scheduler lease generation advanced`);
          return;
        }
        health.failureCount += 1;
        recordScanOutcome(market.id, false, scan.durationMs);
        const err = { market: market.eventTitle, error: scan.error || 'Unknown scan error', durationMs: scan.durationMs };
        health.errors.push(err);
        console.log(`[${new Date().toISOString()}] Scan failed for ${market.eventTitle}: ${err.error}`);
        return;
      }

      const requestedInterval = adaptiveEnabled ? getAdaptiveIntervalMs(market, adaptiveConfig) : FRESHNESS_SLA_MS;
      completeAttempt(schedulerState[market.id], { ok: true }, Date.now(), FRESHNESS_SLA_MS, requestedInterval);
      const saved = await saveMarketSchedulerState(market.id, { phase: 'terminal', leaseToken: lease.token });
      if (!saved) {
        health.skippedCount += 1;
        console.warn(`[${new Date().toISOString()}] Ignored stale success completion for ${market.eventTitle}; scheduler lease generation advanced`);
        return;
      }
      health.successCount += 1;
      recordScanOutcome(market.id, true, scan.durationMs);
      const { best, all } = applyScanResultToMarket(market, scan.result);
      const profitSum = all.reduce((s, a) => s + a.expectedProfit, 0);
      const interval = adaptiveEnabled ? formatInterval(getAdaptiveIntervalMs(market, adaptiveConfig)) : '?';
      if (best && best.roiPct > 0) {
        console.log(`[${new Date().toISOString()}] ${market.eventTitle} → Best: ${best.outcome} ${formatRoi(best.roiPct)} | ${all.length} profitable arb(s), +$${profitSum.toFixed(2)} (${scan.durationMs}ms, interval: ${interval})`);
        // WS-103: flag this pair for HOT-tier promotion in the WS watcher.
        // Fire-and-forget — promotion is an optimization, never block the scan loop.
        fetch(`${BASE_URL}/api/watcher/targets`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.H2H_API_TOKEN ? { 'x-h2h-token': process.env.H2H_API_TOKEN } : {}),
          },
          body: JSON.stringify({ action: 'promote', pairId: market.id }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      } else {
        console.log(`[${new Date().toISOString()}] ${market.eventTitle} → No positive arb (${scan.durationMs}ms, interval: ${interval})`);
      }
    } finally {
      // Closing this exact owner's kernel-lock handle cannot remove or release
      // a successor generation, unlike deleting/renaming a lock pathname.
      await releaseMarketLease(lease);
    }
    }, () => {
      completedDueCount += 1;
      health.heartbeatAt = new Date().toISOString();
      health.progress = { completedDueCount, dueCount: dueMarkets.length };
    });
  } finally {
    clearInterval(heartbeatTimer);
    health.heartbeatAt = new Date().toISOString();
    await heartbeatWrite;
  }

  // OPS-009: no JSON write-back. The app persists each scan result itself
  // (via /api/scan → SQLite, mirrored to saved-markets.json). The poller's
  // old read-merge-write of saved-markets.json was the main write race.

  health.status = health.failureCount > 0 ? 'degraded' : 'ok';
  health.finishedAt = new Date().toISOString();
  health.durationMs = Date.now() - cycleStart;
  health.avgScanMs = scanDurations.length ? Math.round(scanDurations.reduce((s, n) => s + n, 0) / scanDurations.length) : 0;
  health.maxScanMs = scanDurations.length ? Math.max(...scanDurations) : 0;
  health.openBreakers = [...scanStats.values()].filter(s => s.cooldownUntil > Date.now()).length;
  health.queue = schedulerMetrics(markets, schedulerState, Date.now(), FRESHNESS_SLA_MS);
  health.heartbeatAt = new Date().toISOString();
  await writeHealth(health);
  await saveBreakerState();

  const skipped = health.skippedCount;
  const due = dueMarkets.length;
  console.log(`[${new Date().toISOString()}] Poll cycle complete: ${health.successCount}/${due} scanned, ${health.failureCount} failed, ${skipped} skipped (within interval), ${health.durationMs}ms total`);
  return health;
}

// ── Main loop ─────────────────────────────────────────────────────────────

async function run() {
  console.log(`[${new Date().toISOString()}] Poller started — wake interval: ${formatInterval(POLL_WAKE_MS)}, adaptive refresh: enabled, adaptive timeouts + circuit breaker: enabled`);
  loadBreakerState();
  loadSchedulerState();
  // Track last prune date — run once daily
  let lastPruneDate = '';
  // HOOKUP-01/06: ensure the in-app scheduler (auto-discovery scans + hourly
  // lifecycle sweep) is running. Idempotent; re-warmed hourly so it survives
  // pm2 restarts of the Next.js process. Gated in-app by discovery.paused /
  // lifecycle.enabled settings.
  let lastWarmupAt = 0;
  while (true) {
    let health = null;
    try {
      await refreshScannerSettings(); // SETTINGS-001: hot-reload concurrency/timeout each cycle
      if (Date.now() - lastWarmupAt > 60 * 60 * 1000) {
        try {
          const res = await fetch(`${BASE_URL}/api/auto-discovery/warmup`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            lastWarmupAt = Date.now();
            console.log(`[${new Date().toISOString()}] Scheduler warmup OK (auto-discovery + lifecycle sweep active)`);
          }
        } catch (e) {
          console.warn(`[${new Date().toISOString()}] Scheduler warmup failed:`, e.message);
        }
      }
      health = await pollOnce();
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Poll cycle failed (poller continues):`, e && e.stack ? e.stack : e);
    }
    if (process.env.H2H_POLLER_RUN_ONCE === '1') return health;
    // Daily DB pruning at midnight
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastPruneDate) {
      lastPruneDate = today;
      try {
        const res = await fetch(`${BASE_URL}/api/prune-scans?days=30`, {
          method: 'POST',
          headers: process.env.H2H_API_TOKEN ? { 'x-h2h-token': process.env.H2H_API_TOKEN } : {},
        });
        if (res.ok) {
          const result = await res.json();
          console.log(`[${new Date().toISOString()}] DB pruning: ${result.deleted} rows deleted (retention: 30d)`);
        }
      } catch (e) {
        console.warn(`[${new Date().toISOString()}] DB pruning failed:`, e.message);
      }
    }
    // Sleep for the base wake interval (smallest tier).
    // Markets are individually gated by their adaptive interval.
    const sleepMs = Math.max(1000, POLL_WAKE_MS);
    await sleep(sleepMs);
  }
}

run();
