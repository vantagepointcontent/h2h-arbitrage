// WS-104: WS Watcher daemon — real-time arb detection for HOT-tier market pairs.
// Standalone PM2 process (h2h-watcher). Subscribes Kalshi + Polymarket websockets
// for the HOT tier from WS-103, maintains local orderbooks, recomputes net arbs
// on every delta (per-pair trailing debounce), records arb episodes with
// second-level precision and routes alerts through the existing pipeline
// (all filters unchanged: net ROI, min profit, min stake, cooldown, persistence).
//
// The REST poller keeps running unchanged — it is the WARM-tier wide net and
// the fallback when this process is down or degraded.

import fs from 'fs';
import path from 'path';
import { kalshiWs, KalshiWsMessage } from '../src/lib/kalshi-ws';
import { ClobWsService, WsPriceUpdate } from '../src/lib/clob-ws';
import { orderbookState } from '../src/lib/orderbook-state';
import { computeAllLiveArbitrages, LiveMatchedOutcome } from '../src/lib/live-arb-engine';
import { applyKalshiWsMessage, applyPmWsUpdates } from '../src/lib/ws-book-apply';
import { seedAllBooks } from '../src/lib/book-seed';
import { refreshWatchTargets, computeTiers, WatchTarget } from '../src/lib/watch-targets';
import { recordArbObservations } from '../src/lib/arb-lifecycle';
import { checkAndSendAlert } from '../src/lib/telegram-alerts';
import logger from '../src/lib/logger';

// ── Config ──────────────────────────────────────────────────────
const TIER_REFRESH_MS = 60_000;          // re-read tiers (picks up poller promotions fast)
const TARGET_REFRESH_MS = 30 * 60_000;   // re-resolve stale pairs
const PAIR_DEBOUNCE_MS = 150;            // per-pair compute debounce after a delta
const HEALTH_FILE = path.join(process.cwd(), 'data', 'watcher-health.json');
const HEALTH_WRITE_MS = 15_000;
const PM_TOKENS_PER_CONN = 450;          // stay under Polymarket per-connection asset cap
const WATCH_CAPITAL = Number(process.env.H2H_WATCHER_CAPITAL || '1000');

// ── State ───────────────────────────────────────────────────────
interface HotPair {
  pairId: string;
  category?: string;
  title: string;
  outcomes: LiveMatchedOutcome[];
  kalshiTickers: Set<string>;
  pmTokens: Set<string>;
}

const hotPairs = new Map<string, HotPair>();           // pairId -> pair
const tickerToPairs = new Map<string, Set<string>>();  // kalshi ticker -> pairIds
const tokenToPairs = new Map<string, Set<string>>();   // pm token -> pairIds
const pmTokenSides = new Map<string, 'yes' | 'no'>();
const pairDebounce = new Map<string, ReturnType<typeof setTimeout>>();
const pmPool: ClobWsService[] = [];
let kalshiSubKeys: string[] = [];
let msgCount = 0;
let lastTickAt = 0;
let tierStats: object = {};

// ── Wiring: targets -> subscriptions ────────────────────────────

function rebuildIndexes(hot: WatchTarget[], titles: Map<string, string>) {
  hotPairs.clear();
  tickerToPairs.clear();
  tokenToPairs.clear();
  pmTokenSides.clear();

  for (const t of hot) {
    let p = hotPairs.get(t.pairId);
    if (!p) {
      p = { pairId: t.pairId, category: t.category, title: titles.get(t.pairId) ?? t.pairId, outcomes: [], kalshiTickers: new Set(), pmTokens: new Set() };
      hotPairs.set(t.pairId, p);
    }
    p.outcomes.push({ artist: t.artist, kalshiTicker: t.kalshiTicker, pmYesTokenId: t.pmYesToken, pmNoTokenId: t.pmNoToken });
    p.kalshiTickers.add(t.kalshiTicker);
    p.pmTokens.add(t.pmYesToken).add(t.pmNoToken);

    for (const [key, map] of [[t.kalshiTicker, tickerToPairs], [t.pmYesToken, tokenToPairs], [t.pmNoToken, tokenToPairs]] as const) {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(t.pairId);
    }
    pmTokenSides.set(t.pmYesToken, 'yes');
    pmTokenSides.set(t.pmNoToken, 'no');
  }
}

async function loadPairTitles(): Promise<Map<string, string>> {
  const { createClient } = await import('@libsql/client');
  const c = createClient({ url: `file:${path.join(process.cwd(), 'data', 'edgefinder.db')}` });
  const rs = await c.execute(`SELECT id, event_title FROM saved_markets`);
  const m = new Map<string, string>();
  for (const r of rs.rows) m.set(String(r.id), String(r.event_title || r.id));
  c.close();
  return m;
}

function handleKalshiMsg(msg: KalshiWsMessage): void {
  msgCount++;
  lastTickAt = Date.now();
  if (!applyKalshiWsMessage(msg)) return;
  const pairs = tickerToPairs.get(msg.marketTicker);
  if (pairs) for (const pid of pairs) schedulePairCompute(pid);
}

function handlePmUpdates(updates: WsPriceUpdate[]): void {
  msgCount += updates.length;
  lastTickAt = Date.now();
  if (!applyPmWsUpdates(updates, pmTokenSides)) return;
  for (const u of updates) {
    const pairs = tokenToPairs.get(u.tokenId);
    if (pairs) for (const pid of pairs) schedulePairCompute(pid);
  }
}

async function syncSubscriptions(): Promise<void> {
  const tiers = await computeTiers();
  tierStats = tiers.stats;
  const titles = await loadPairTitles();

  // Diff old vs new pair sets for logging
  const newPairIds = new Set(tiers.hotPairIds);
  const added = tiers.hotPairIds.filter((p) => !hotPairs.has(p));
  const removed = [...hotPairs.keys()].filter((p) => !newPairIds.has(p));

  // Books for removed pairs are cleaned up
  for (const pid of removed) {
    const p = hotPairs.get(pid);
    if (!p) continue;
    for (const t of p.kalshiTickers) if (!tiers.hot.some((h) => h.kalshiTicker === t)) orderbookState.removeBook(t);
    for (const t of p.pmTokens) orderbookState.removeBook(t);
  }

  rebuildIndexes(tiers.hot, titles);

  // ── Kalshi: resubscribe (batch) ──
  for (const key of kalshiSubKeys) kalshiWs.unsubscribe(key);
  kalshiSubKeys = [];
  kalshiWs.connect();
  const allTickers = [...tickerToPairs.keys()];
  for (const t of allTickers) {
    const key = `watcher-${t}`;
    kalshiSubKeys.push(key);
    kalshiWs.subscribe(t, handleKalshiMsg, key);
  }

  // ── Polymarket: shard tokens across pooled connections ──
  const allTokens = [...tokenToPairs.keys()];
  const shards: string[][] = [];
  for (let i = 0; i < allTokens.length; i += PM_TOKENS_PER_CONN) {
    shards.push(allTokens.slice(i, i + PM_TOKENS_PER_CONN));
  }
  // Grow pool as needed; resubscribe each shard
  while (pmPool.length < shards.length) pmPool.push(new ClobWsService());
  for (let i = 0; i < pmPool.length; i++) {
    pmPool[i].unsubscribe(`watcher-shard-${i}`);
    if (i < shards.length) {
      pmPool[i].connect();
      pmPool[i].subscribe(shards[i], handlePmUpdates, `watcher-shard-${i}`);
    }
  }

  // Seed books for newly added pairs only (REST)
  if (added.length > 0) {
    const seedTickers = new Set<string>();
    const seedTokens = new Set<string>();
    for (const pid of added) {
      const p = hotPairs.get(pid);
      if (!p) continue;
      for (const t of p.kalshiTickers) seedTickers.add(t);
      for (const t of p.pmTokens) seedTokens.add(t);
    }
    await seedAllBooks([...seedTickers], [...seedTokens], pmTokenSides).catch(() => {});
  }

  logger.info('[watcher] subscriptions synced', {
    pairs: hotPairs.size, kalshiTickers: allTickers.length, pmTokens: allTokens.length,
    pmShards: shards.length, added: added.length, removed: removed.length,
  });
}

// ── Compute + alert path ─────────────────────────────────────────

function schedulePairCompute(pairId: string): void {
  if (pairDebounce.has(pairId)) return; // trailing debounce already scheduled
  pairDebounce.set(pairId, setTimeout(() => {
    pairDebounce.delete(pairId);
    computePair(pairId).catch((err) => logger.warn('[watcher] compute failed', { pairId, err }));
  }, PAIR_DEBOUNCE_MS));
}

async function computePair(pairId: string): Promise<void> {
  const pair = hotPairs.get(pairId);
  if (!pair) return;

  const results = computeAllLiveArbitrages(pair.outcomes, WATCH_CAPITAL, pair.category);
  const positive = results.filter((r) => !r.stale && r.expectedProfit > 0 && r.fees != null);

  // Episode lifecycle — second-precision first-seen/closed timestamps.
  // recordArbObservations opens/extends/closes based on the full observation set.
  await recordArbObservations(
    pairId,
    pair.title,
    pair.category,
    positive.map((r) => ({
      outcome: r.artist,
      strategy: r.strategy,
      roiPct: r.roiPct,
      expectedProfit: r.expectedProfit,
      totalStake: r.kalshiStake + r.pmStake,
    })),
  );

  // Alerts — existing pipeline, ALL filters unchanged.
  for (const r of positive) {
    await checkAndSendAlert({
      marketTitle: pair.title,
      marketId: pairId,
      roiPct: r.roiPct,
      expectedProfit: r.expectedProfit,
      strategy: r.strategy,
      totalStake: r.kalshiStake + r.pmStake,
      outcome: r.artist,
      fees: r.fees ?? undefined,
      kalshiYesPrice: r.kalshiYesAsk ?? undefined,
      kalshiNoPrice: r.kalshiNoAsk ?? undefined,
      pmYesPrice: r.pmYesAsk ?? undefined,
      pmNoPrice: r.pmNoAsk ?? undefined,
    });
  }
}

// ── Health ──────────────────────────────────────────────────────

function writeHealth(): void {
  const pmConnected = pmPool.filter((c) => c.isConnected()).length;
  const health = {
    status: 'ok',
    ts: new Date().toISOString(),
    kalshiConnected: kalshiWs.isConnected(),
    pmConnections: `${pmConnected}/${pmPool.length}`,
    hotPairs: hotPairs.size,
    kalshiTickers: tickerToPairs.size,
    pmTokens: tokenToPairs.size,
    msgCount,
    lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
    tierStats,
  };
  try {
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2));
  } catch { /* best effort */ }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('[watcher] starting', { capital: WATCH_CAPITAL });

  // Initial target refresh is incremental (warm restarts are seconds).
  await refreshWatchTargets().catch((err) => logger.warn('[watcher] initial target refresh failed', { err }));
  await syncSubscriptions();

  setInterval(() => { syncSubscriptions().catch((err) => logger.warn('[watcher] tier sync failed', { err })); }, TIER_REFRESH_MS);
  setInterval(() => { refreshWatchTargets().catch((err) => logger.warn('[watcher] target refresh failed', { err })); }, TARGET_REFRESH_MS);
  setInterval(writeHealth, HEALTH_WRITE_MS);
  writeHealth();

  const shutdown = () => {
    logger.info('[watcher] shutting down');
    kalshiWs.disconnect();
    for (const c of pmPool) c.disconnect();
    writeHealth();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('[watcher] fatal', { err });
  process.exit(1);
});
