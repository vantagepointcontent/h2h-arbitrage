// Node.js poller (ES module) - polls saved markets with adaptive refresh rates
// Run via: pm2 start scripts/poll.mjs --name h2h-poller

const BASE_URL = process.env.H2H_BASE_URL || 'http://100.86.7.30:3000';
let POLL_CONCURRENCY = Math.max(1, Number(process.env.H2H_POLL_CONCURRENCY || 5));
// Base wake-up interval. Poller wakes this often to check which markets are due.
// 60s — gentle, since most markets have 5-30min adaptive intervals.
const POLL_WAKE_MS = 60000;
let SCAN_TIMEOUT_MS = Math.max(5000, Number(process.env.H2H_SCAN_TIMEOUT_MS || 60000));

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
const DATA_FILE = new URL('../data/saved-markets.json', import.meta.url).pathname;
const HEALTH_FILE = new URL('../data/poller-health.json', import.meta.url).pathname;
const BREAKER_FILE = new URL('../data/poller-breaker.json', import.meta.url).pathname;
const ADAPTIVE_CONFIG_FILE = new URL('../src/data/adaptive-refresh-config.json', import.meta.url).pathname;
const fs = await import('fs');

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
const TIMEOUT_FLOOR_MS = 15_000;
const TIMEOUT_MULTIPLIER = 3;
const BREAKER_THRESHOLD = 3;          // consecutive failures to trip
const BREAKER_BASE_COOLDOWN_MS = 5 * 60_000;
const BREAKER_MAX_COOLDOWN_MS = 60 * 60_000;

const scanStats = new Map(); // marketId -> { avgMs, consecFails, trips, cooldownUntil }

function loadBreakerState() {
  try {
    const raw = JSON.parse(fs.readFileSync(BREAKER_FILE, 'utf-8'));
    for (const [id, s] of Object.entries(raw)) scanStats.set(id, s);
    console.log(`[${new Date().toISOString()}] Loaded breaker state for ${scanStats.size} market(s)`);
  } catch { /* first run or corrupt file — start clean */ }
}

async function saveBreakerState() {
  try {
    // Only persist entries that carry signal (stats or open breakers)
    const obj = {};
    for (const [id, s] of scanStats) {
      if (s.avgMs || s.consecFails > 0 || (s.cooldownUntil && s.cooldownUntil > Date.now())) obj[id] = s;
    }
    await writeJsonAtomic(BREAKER_FILE, obj);
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

function isBreakerOpen(marketId) {
  const s = scanStats.get(marketId);
  return !!s && s.cooldownUntil > Date.now();
}

function recordScanOutcome(marketId, ok, durationMs) {
  const s = getStats(marketId);
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

  const secondsToExpiry = Math.max(0, Math.round((expiryMs - Date.now()) / 1000));
  const mult = config.globalMultiplier;

  for (const tier of config.tiers) {
    if (secondsToExpiry <= tier.maxSeconds) {
      return tier.intervalSec * 1000 * mult;
    }
  }
  // Fallback to last tier
  const last = config.tiers[config.tiers.length - 1];
  return last.intervalSec * 1000 * mult;
}

/**
 * Is this market due for refresh based on adaptive interval?
 */
function isDueForRefresh(market, config) {
  const lastScan = market.lastScanResult?.scannedAt;
  if (!lastScan) return true; // never scanned

  const intervalMs = getAdaptiveIntervalMs(market, config);
  const elapsed = Date.now() - new Date(lastScan).getTime();
  return elapsed >= intervalMs;
}

// ── File I/O ──────────────────────────────────────────────────────────────

async function loadSavedMarkets() {
  try {
    const data = JSON.parse(await fs.promises.readFile(DATA_FILE, 'utf-8'));
    return data || [];
  } catch {
    return [];
  }
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
        ...(process.env.H2H_API_TOKEN ? { 'x-h2h-token': process.env.H2H_API_TOKEN } : {}),
      },
      body: JSON.stringify({ kalshiUrl: market.kalshiUrl, polymarketUrl: market.polymarketUrl }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const durationMs = Date.now() - started;
    if (!res.ok) {
      return { ok: false, durationMs, error: `HTTP ${res.status}` };
    }
    return { ok: true, durationMs, result: await res.json() };
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === 'AbortError' ? `timeout after ${timeoutMs}ms (adaptive)` : (e.message || String(e));
    return { ok: false, durationMs: timeoutMs, error: msg };
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

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function runWorker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
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
  const cycleStart = Date.now();

  // Reload adaptive config each cycle (hot-reload friendly)
  const adaptiveConfig = loadAdaptiveConfig();
  const adaptiveEnabled = adaptiveConfig?.enabled ?? false;

  const markets = await loadSavedMarkets();
  const health = {
    status: 'running',
    baseUrl: BASE_URL,
    concurrency: POLL_CONCURRENCY,
    intervalMs: adaptiveEnabled ? 'adaptive' : POLL_WAKE_MS * 2,
    adaptiveEnabled,
    marketCount: markets.length,
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
  await writeHealth(health);

  if (markets.length === 0) {
    console.log(`[${new Date().toISOString()}] No saved markets. Sleeping ${Math.round(POLL_WAKE_MS / 1000)}s...`);
    health.status = 'idle';
    health.finishedAt = new Date().toISOString();
    health.durationMs = Date.now() - cycleStart;
    await writeHealth(health);
    return health;
  }

  // Filter to markets due for refresh (adaptive), minus open circuit breakers
  const dueByInterval = adaptiveEnabled
    ? markets.filter(m => isDueForRefresh(m, adaptiveConfig))
    : markets; // legacy: refresh all
  const dueMarkets = dueByInterval.filter(m => !isBreakerOpen(m.id));
  const breakerSkipped = dueByInterval.length - dueMarkets.length;

  health.skippedCount = markets.length - dueByInterval.length;
  health.breakerSkipped = breakerSkipped;
  if (breakerSkipped > 0) {
    console.log(`[${new Date().toISOString()}] ${breakerSkipped} market(s) skipped — circuit breaker cooling down`);
  }

  if (dueMarkets.length === 0) {
    console.log(`[${new Date().toISOString()}] No markets due for refresh (${markets.length} total, all within interval). Sleeping ${Math.round(POLL_WAKE_MS / 1000)}s...`);
    health.status = 'idle';
    health.finishedAt = new Date().toISOString();
    health.durationMs = Date.now() - cycleStart;
    await writeHealth(health);
    return health;
  }

  const scanDurations = [];
  // Global bail-out: if everything is failing, the APP is down (not the
  // markets) — abort the cycle instead of tripping breakers on all markets
  // and burning timeout-minutes with zero coverage.
  let consecGlobalFails = 0;
  const GLOBAL_FAIL_ABORT = Math.max(10, POLL_CONCURRENCY * 3);
  let aborted = false;

  await mapWithConcurrency(dueMarkets, POLL_CONCURRENCY, async (market) => {
    if (aborted) return;
    const scan = await scanMarket(market);
    scanDurations.push(scan.durationMs || 0);

    if (!scan.ok || !scan.result) {
      health.failureCount += 1;
      consecGlobalFails += 1;
      recordScanOutcome(market.id, false, scan.durationMs);
      const err = { market: market.eventTitle, error: scan.error || 'Unknown scan error', durationMs: scan.durationMs };
      health.errors.push(err);
      console.log(`[${new Date().toISOString()}] Scan failed for ${market.eventTitle}: ${err.error}`);
      if (consecGlobalFails >= GLOBAL_FAIL_ABORT && !aborted) {
        aborted = true;
        console.error(`[${new Date().toISOString()}] ABORTING CYCLE: ${consecGlobalFails} consecutive failures — app/upstream likely down, not the markets. Remaining scans deferred to next cycle.`);
      }
      return;
    }

    health.successCount += 1;
    consecGlobalFails = 0;
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
          ...(process.env.H2H_API_TOKEN ? { 'x-api-token': process.env.H2H_API_TOKEN } : {}),
        },
        body: JSON.stringify({ action: 'promote', pairId: market.id }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    } else {
      console.log(`[${new Date().toISOString()}] ${market.eventTitle} → No positive arb (${scan.durationMs}ms, interval: ${interval})`);
    }
  });

  // OPS-009: no JSON write-back. The app persists each scan result itself
  // (via /api/scan → SQLite, mirrored to saved-markets.json). The poller's
  // old read-merge-write of saved-markets.json was the main write race.

  health.status = aborted ? 'aborted' : (health.failureCount > 0 ? 'degraded' : 'ok');
  health.finishedAt = new Date().toISOString();
  health.durationMs = Date.now() - cycleStart;
  health.avgScanMs = scanDurations.length ? Math.round(scanDurations.reduce((s, n) => s + n, 0) / scanDurations.length) : 0;
  health.maxScanMs = scanDurations.length ? Math.max(...scanDurations) : 0;
  health.openBreakers = [...scanStats.values()].filter(s => s.cooldownUntil > Date.now()).length;
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
