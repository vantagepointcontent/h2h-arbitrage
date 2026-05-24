// Node.js poller (ES module) - polls saved markets every ~30s
// Run via: pm2 start scripts/poll.mjs --name h2h-poller

const BASE_URL = process.env.H2H_BASE_URL || 'http://100.86.7.30:3000';
const DATA_FILE = new URL('../data/saved-markets.json', import.meta.url).pathname;
const fs = await import('fs');

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

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

async function saveMarkets(markets) {
  await fs.promises.writeFile(DATA_FILE, JSON.stringify(markets, null, 2));
}

async function scanMarket(market) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${BASE_URL}/api/scan?skipManual=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kalshiUrl: market.kalshiUrl, polymarketUrl: market.polymarketUrl }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      console.log(`[${new Date().toISOString()}] SCAN TIMEOUT for ${market.eventTitle}`);
    }
    return null;
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

async function pollOnce() {
  const markets = await loadSavedMarkets();
  if (markets.length === 0) {
    console.log(`[${new Date().toISOString()}] No saved markets. Sleeping 30s...`);
    return;
  }

  for (const market of markets) {
    try {
      const result = await scanMarket(market);
      if (!result) {
        console.log(`[${new Date().toISOString()}] Scan failed for ${market.eventTitle}`);
        continue;
      }

      // Only keep matched outcomes for storage (poller optimization)
      const matchedOutcomes = (result.outcomes || []).filter(o => o.kalshi && o.polymarket);
      const matchedCount = matchedOutcomes.length;

      const { best, all } = extractAllArbitrages(result);
      if (best) {
        market.lastScanResult = {
          bestRoiPct: best.roiPct,
          bestProfit: best.profit,
          strategy: best.strategy,
          outcomeCount: matchedCount,  // store matched count only
          matchedCount,
          kalshiCount: result.kalshiCount,
          pmCount: result.pmCount,
          scannedAt: new Date().toISOString(),
          allArbs: all,
        };
        if (result.expiryDate && !market.expiryDate) {
          market.expiryDate = result.expiryDate;
        }
        const profitSum = all.reduce((s, a) => s + a.expectedProfit, 0);
        console.log(`[${new Date().toISOString()}] ${market.eventTitle} → Best: ${best.outcome} ${formatRoi(best.roiPct)} | ${all.length} profitable arb(s), total +$${profitSum.toFixed(2)}`);
      } else {
        market.lastScanResult = {
          bestRoiPct: best ? best.roiPct : 0,
          bestProfit: best ? best.profit : 0,
          strategy: '',
          outcomeCount: matchedCount,
          matchedCount,
          kalshiCount: result.kalshiCount,
          pmCount: result.pmCount,
          scannedAt: new Date().toISOString(),
          allArbs: [],
        };
        console.log(`[${new Date().toISOString()}] ${market.eventTitle} → No positive arb`);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error scanning ${market.eventTitle}:`, err.message);
    }
    // Small delay between each market to avoid slamming APIs
    await sleep(1500);
  }

  await saveMarkets(markets);
}

async function run() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pollOnce();
    await sleep(30000);
  }
}

run();
