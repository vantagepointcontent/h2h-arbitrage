// Node.js poller (ES module) - polls saved markets every ~30s
// Run via: pm2 start scripts/poll.mjs --name h2h-poller

const BASE_URL = process.env.H2H_BASE_URL || 'http://100.86.7.30:3010';
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
  const res = await fetch(`${BASE_URL}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kalshiUrl: market.kalshiUrl, polymarketUrl: market.polymarketUrl }),
  });
  if (!res.ok) return null;
  return res.json();
}

function extractBestArbitrage(result) {
  const outcomes = result.outcomes || [];
  let best = null;
  for (const o of outcomes) {
    const arb = o.arbitrage || {};
    if (arb.roiPct > 0 && (!best || arb.roiPct > best.roiPct)) {
      best = {
        roiPct: arb.roiPct,
        profit: arb.expectedProfit,
        strategy: arb.strategy,
        outcome: o.artist,
        kalshiCount: result.kalshiCount,
        pmCount: result.pmCount,
        matchedCount: result.matchedCount,
      };
    }
  }
  if (best) return best;

  // No positive arb: return highest (least negative) roi
  let bestNeg = null;
  for (const o of outcomes) {
    const arb = o.arbitrage || {};
    if (!bestNeg || arb.roiPct > bestNeg.roiPct) {
      bestNeg = {
        roiPct: Math.max(0, arb.roiPct),
        profit: Math.max(0, arb.expectedProfit),
        strategy: arb.strategy,
        outcome: o.artist,
        kalshiCount: result.kalshiCount,
        pmCount: result.pmCount,
        matchedCount: result.matchedCount,
      };
    }
  }
  return bestNeg;
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
      const best = extractBestArbitrage(result);
      if (best) {
        market.lastScanResult = {
          bestRoiPct: best.roiPct,
          bestProfit: best.profit,
          strategy: best.strategy,
          outcomeCount: result.outcomes.length,
          matchedCount: best.matchedCount,
          kalshiCount: best.kalshiCount,
          pmCount: best.pmCount,
          scannedAt: new Date().toISOString(),
        };
        console.log(`[${new Date().toISOString()}] ${market.eventTitle} → Best: ${best.outcome} ${formatRoi(best.roiPct)}`);
      } else {
        console.log(`[${new Date().toISOString()}] ${market.eventTitle} → No outcomes`);
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
