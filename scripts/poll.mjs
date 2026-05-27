// Node.js poller (ES module) - polls saved markets with bounded concurrency
// Run via: pm2 start scripts/poll.mjs --name h2h-poller

const BASE_URL = process.env.H2H_BASE_URL || 'http://100.86.7.30:3000';
const POLL_CONCURRENCY = Math.max(1, Number(process.env.H2H_POLL_CONCURRENCY || 3));
const POLL_INTERVAL_MS = Math.max(5000, Number(process.env.H2H_POLL_INTERVAL_MS || 30000));
const SCAN_TIMEOUT_MS = Math.max(5000, Number(process.env.H2H_SCAN_TIMEOUT_MS || 15000));
const DATA_FILE = new URL('../data/saved-markets.json', import.meta.url).pathname;
const HEALTH_FILE = new URL('../data/poller-health.json', import.meta.url).pathname;
const fs = await import('fs');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

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
  await fs.promises.rename(tmp, path);
}

async function saveMarkets(markets) {
  await writeJsonAtomic(DATA_FILE, markets);
}

async function writeHealth(health) {
  try {
    await writeJsonAtomic(HEALTH_FILE, health);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed writing poller health:`, err.message);
  }
}

async function scanMarket(market) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  try {
    const started = Date.now();
    const res = await fetch(`${BASE_URL}/api/scan?skipManual=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const msg = e.name === 'AbortError' ? `timeout after ${SCAN_TIMEOUT_MS}ms` : (e.message || String(e));
    return { ok: false, durationMs: SCAN_TIMEOUT_MS, error: msg };
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
    // No positive arb: return least-negative as fallback for backward compat
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

async function pollOnce() {
  const startedAt = new Date();
  const cycleStart = Date.now();
  const markets = await loadSavedMarkets();
  const health = {
    status: 'running',
    baseUrl: BASE_URL,
    concurrency: POLL_CONCURRENCY,
    intervalMs: POLL_INTERVAL_MS,
    marketCount: markets.length,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    successCount: 0,
    failureCount: 0,
    avgScanMs: 0,
    maxScanMs: 0,
    errors: [],
  };
  await writeHealth(health);

  if (markets.length === 0) {
    console.log(`[${new Date().toISOString()}] No saved markets. Sleeping ${Math.round(POLL_INTERVAL_MS / 1000)}s...`);
    health.status = 'idle';
    health.finishedAt = new Date().toISOString();
    health.durationMs = Date.now() - cycleStart;
    await writeHealth(health);
    return health;
  }

  const scanDurations = [];

  await mapWithConcurrency(markets, POLL_CONCURRENCY, async (market) => {
    const scan = await scanMarket(market);
    scanDurations.push(scan.durationMs || 0);

    if (!scan.ok || !scan.result) {
      health.failureCount += 1;
      const err = { market: market.eventTitle, error: scan.error || 'Unknown scan error', durationMs: scan.durationMs };
      health.errors.push(err);
      console.log(`[${new Date().toISOString()}] Scan failed for ${market.eventTitle}: ${err.error}`);
      return;
    }

    health.successCount += 1;
    const { best, all } = applyScanResultToMarket(market, scan.result);
    const profitSum = all.reduce((s, a) => s + a.expectedProfit, 0);
    if (best && best.roiPct > 0) {
      console.log(`[${new Date().toISOString()}] ${market.eventTitle} → Best: ${best.outcome} ${formatRoi(best.roiPct)} | ${all.length} profitable arb(s), total +$${profitSum.toFixed(2)} (${scan.durationMs}ms)`);
    } else {
      console.log(`[${new Date().toISOString()}] ${market.eventTitle} → No positive arb (${scan.durationMs}ms)`);
    }
  });

  await saveMarkets(markets);

  health.status = health.failureCount > 0 ? 'degraded' : 'ok';
  health.finishedAt = new Date().toISOString();
  health.durationMs = Date.now() - cycleStart;
  health.avgScanMs = scanDurations.length ? Math.round(scanDurations.reduce((s, n) => s + n, 0) / scanDurations.length) : 0;
  health.maxScanMs = scanDurations.length ? Math.max(...scanDurations) : 0;
  await writeHealth(health);

  console.log(`[${new Date().toISOString()}] Poll cycle complete: ${health.successCount}/${markets.length} ok, ${health.failureCount} failed, ${health.durationMs}ms total`);
  return health;
}

async function run() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const health = await pollOnce();
    const elapsed = health.durationMs || 0;
    const sleepMs = Math.max(1000, POLL_INTERVAL_MS - elapsed);
    await sleep(sleepMs);
  }
}

run();
