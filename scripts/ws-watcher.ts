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
import { computeAllLiveArbitrages, LiveMatchedOutcome, LiveArbResult } from '../src/lib/live-arb-engine';
import { applyKalshiWsMessage, applyPmWsUpdates } from '../src/lib/ws-book-apply';
import { seedAllBooks, seedKalshiBook, seedPmBook } from '../src/lib/book-seed';
import { refreshWatchTargets, computeTiers, WatchTarget } from '../src/lib/watch-targets';
import { recordArbObservations } from '../src/lib/arb-lifecycle';
import { getAvgEpisodeLifespanMin } from '../src/lib/arb-lifecycle';
import { attachPersistenceScores } from '../src/lib/persistence-tracker';
import { checkAndSendAlert } from '../src/lib/telegram-alerts';
import { updateSavedMarketLiveResult, clearSavedMarketLiveResult, LastScanResult } from '@/lib/persistence';
import { persistAndConsumeBotScan } from '@/lib/bot-scan-consumer';
import { computePriceResolved } from '@/app/lib/page-shared';
import { SUSPICIOUS_ROI_PCT } from '@/lib/matcher';
import { calculateOutcomeContingentApy } from '@/lib/settlement-apy';
import { calculateScanApy } from '@/lib/scan-apy';
import { reserveWatcherMatchPublication, type WatcherMatchPublication } from '@/lib/watcher-match-publication';

import logger from '@/lib/logger';

// ── Config ──────────────────────────────────────────────────────
const TIER_REFRESH_MS = 60_000;          // re-read tiers (picks up poller promotions fast)
const TARGET_REFRESH_MS = 30 * 60_000;   // re-resolve stale pairs
const PAIR_DEBOUNCE_MS = 150;            // per-pair compute debounce after a delta
const HEALTH_FILE = path.join(process.cwd(), 'data', 'watcher-health.json');
const HEALTH_WRITE_MS = 15_000;
const PM_TOKENS_PER_CONN = 450;          // stay under Polymarket per-connection asset cap
const WATCH_CAPITAL = Number(process.env.H2H_WATCHER_CAPITAL || '1000');
// WS-107: persist liveResult to saved_markets at most this often per pair
const LIVE_WRITE_MIN_MS = Number(process.env.H2H_LIVE_WRITE_MIN_MS || 2_000);

// WS-105: integrity layer config
const RECONCILE_MS = 10 * 60_000;        // periodic REST reconcile per HOT book
const RECONCILE_CHUNK = 10;              // REST calls in flight during reconcile
const RECONCILE_DISAGREE_CENTS = 0.02;   // material best-ask disagreement threshold
const STALE_CHECK_MS = 60_000;           // staleness sweep interval
const STALE_BOOK_MS = 5 * 60_000;        // silent book older than this -> re-seed
const BREAKER_CHECK_MS = 5_000;
const BREAKER_FLAP_WINDOW_MS = 10 * 60_000;
const BREAKER_FLAP_LIMIT = 5;            // >=N disconnects in window -> degraded
const BREAKER_DOWN_MS = 2 * 60_000;      // continuously down this long -> degraded
const BREAKER_RECOVER_MS = 2 * 60_000;   // stable this long -> recover

// ── State ───────────────────────────────────────────────────────
interface HotPair {
  pairId: string;
  category?: string;
  title: string;
  expiryDate?: string | null;
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

// WS-105 state
// Kalshi seq is per-SUBSCRIPTION (sid), shared across all tickers in the batch
// subscribe — NOT per ticker. A gap in the sid's seq means we missed message(s)
// for an UNKNOWN ticker, so we can't surgically re-seed one book; instead we
// trigger a debounced full reconcile pass (REST is truth).
const kalshiSeqBySid = new Map<number, number>();     // sid -> last seen seq
let seqGapCount = 0;
let gapReconcileTimer: ReturnType<typeof setTimeout> | null = null;
const GAP_RECONCILE_DEBOUNCE_MS = 60_000;
const GAP_RECONCILE_MIN_INTERVAL_MS = 5 * 60_000; // gaps are common (seq counts filtered msgs); don't hammer REST
const GAP_LOG_INTERVAL_MS = 60_000;
let lastGapLogAt = 0;
let gapsSinceLog = 0;
let reconcileCount = 0;
let reconcileDisagreements = 0;
let lastReconcileAt = 0;
let staleReseedCount = 0;
let degraded = false;
let degradedSince = 0;
const flapEvents: number[] = [];                      // disconnect timestamps
let kalshiWasConnected = false;
let kalshiDownSince = 0;

// ── Wiring: targets -> subscriptions ────────────────────────────

function rebuildIndexes(hot: WatchTarget[], metadata: Map<string, { title: string; expiryDate: string | null }>) {
  hotPairs.clear();
  tickerToPairs.clear();
  tokenToPairs.clear();
  pmTokenSides.clear();

  for (const t of hot) {
    let p = hotPairs.get(t.pairId);
    if (!p) {
      const pairMetadata = metadata.get(t.pairId);
      p = { pairId: t.pairId, category: t.category, title: pairMetadata?.title ?? t.pairId, expiryDate: pairMetadata?.expiryDate ?? null, outcomes: [], kalshiTickers: new Set(), pmTokens: new Set() };
      hotPairs.set(t.pairId, p);
    }
    p.outcomes.push({ artist: t.artist, kalshiTicker: t.kalshiTicker, pmYesTokenId: t.pmYesToken, pmNoTokenId: t.pmNoToken, pmConditionId: t.pmConditionId });
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

async function loadPairMetadata(): Promise<Map<string, { title: string; expiryDate: string | null }>> {
  const { createClient } = await import('@libsql/client');
  const c = createClient({ url: `file:${path.join(process.cwd(), 'data', 'edgefinder.db')}` });
  const rs = await c.execute(`SELECT id, event_title, expiry_date FROM saved_markets`);
  const m = new Map<string, { title: string; expiryDate: string | null }>();
  for (const r of rs.rows) m.set(String(r.id), {
    title: String(r.event_title || r.id),
    expiryDate: r.expiry_date == null ? null : String(r.expiry_date),
  });
  c.close();
  return m;
}

function handleKalshiMsg(msg: KalshiWsMessage): void {
  msgCount++;
  lastTickAt = Date.now();

  // WS-105 (1): seq-gap detection, per sid (subscription-wide seq).
  // We still APPLY this message — its book is consistent; the missed messages
  // belong to unknown tickers, handled by the debounced reconcile.
  if (msg.sid != null && msg.seq != null) {
    const last = kalshiSeqBySid.get(msg.sid);
    if (last != null && msg.seq > last + 1) {
      seqGapCount++;
      gapsSinceLog += msg.seq - last - 1;
      const now = Date.now();
      if (now - lastGapLogAt >= GAP_LOG_INTERVAL_MS) {
        logger.warn('[watcher] kalshi seq gaps on sid — reconcile scheduled', { sid: msg.sid, missedSinceLastLog: gapsSinceLog, totalGapEvents: seqGapCount });
        lastGapLogAt = now;
        gapsSinceLog = 0;
      }
      scheduleGapReconcile();
    }
    kalshiSeqBySid.set(msg.sid, msg.seq);
    if (kalshiSeqBySid.size > 50) {
      // resubscribes create new sids; drop all but the current one occasionally
      for (const sid of kalshiSeqBySid.keys()) if (sid !== msg.sid) kalshiSeqBySid.delete(sid);
    }
  }

  if (!applyKalshiWsMessage(msg)) return;
  const pairs = tickerToPairs.get(msg.marketTicker);
  if (pairs) for (const pid of pairs) schedulePairCompute(pid);
}

function scheduleGapReconcile(): void {
  if (gapReconcileTimer) return; // one pending pass covers all gaps in the window
  const wait = Math.max(GAP_RECONCILE_DEBOUNCE_MS, lastReconcileAt + GAP_RECONCILE_MIN_INTERVAL_MS - Date.now());
  gapReconcileTimer = setTimeout(() => {
    gapReconcileTimer = null;
    reconcileBooks().catch((err) => logger.warn('[watcher] gap reconcile failed', { err }));
  }, wait);
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
  const metadata = await loadPairMetadata();

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
    // WS-107: demoted pairs fall back to poller data immediately
    lastLiveWriteAt.delete(pid);
    clearSavedMarketLiveResult(pid).catch(() => {});
  }

  rebuildIndexes(tiers.hot, metadata);

  // WS-105: clear dead-book suppression for ids no longer tracked
  for (const id of [...deadBooks.keys()]) if (!tickerToPairs.has(id) && !tokenToPairs.has(id)) deadBooks.delete(id);

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
  const observedAt = new Date().toISOString();

  // Capture the generation and exact canonical revision before computation.
  // A manual mutation during computation then fences this stale result.
  const shouldWriteLive = Date.now() - (lastLiveWriteAt.get(pairId) ?? 0) >= LIVE_WRITE_MIN_MS;
  let canonical: WatcherMatchPublication | null = null;
  if (shouldWriteLive) {
    lastLiveWriteAt.set(pairId, Date.now());
    const matchedPairs = pair.outcomes.flatMap((outcome) => outcome.pmConditionId ? [{
      artist: outcome.artist,
      kalshiTicker: outcome.kalshiTicker,
      pmConditionId: outcome.pmConditionId,
    }] : []);
    canonical = await reserveWatcherMatchPublication(pairId, matchedPairs);
  }

  const results = computeAllLiveArbitrages(pair.outcomes, WATCH_CAPITAL, pair.category);

  // HOOKUP-02 (FEAT-004): attach persistence scores (velocity/depth/history).
  const avgLifespanMin = await getAvgEpisodeLifespanMin(pairId).catch(() => undefined);
  attachPersistenceScores(results, { marketKey: pairId, avgLifespanMin });

  const positive = results.filter((r) => !r.stale && r.expectedProfit > 0 && r.fees != null);

  // WS-107: persist the live view so ALL UI surfaces (sidebar, Overview,
  // Dashboard) show real-time ROI for HOT markets, not the 5-min poller lag.
  if (canonical) {
    await writeLiveResult(pairId, results, positive, canonical, observedAt).catch((err) =>
      logger.warn('[watcher] liveResult write failed', { pairId, err }));
  }

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
    const canonicalApy = calculateScanApy(r.roiPct, observedAt, pair.expiryDate);
    await checkAndSendAlert({
      marketTitle: pair.title,
      marketId: pairId,
      roiPct: r.roiPct,
      apyPct: canonicalApy.apyPct,
      daysToExpiry: canonicalApy.daysToExpiry,
      apyUnavailableReason: canonicalApy.unavailableReason,
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

// ── WS-107: liveResult persistence ───────────────────────────────

const lastLiveWriteAt = new Map<string, number>();  // pairId -> ts of last DB write
let liveWriteCount = 0;
let liveWriteErrors = 0;

/** Mirror of markSuspiciousArb for the live path: huge ROI with no visible
 *  ask depth on any leg is a one-tick phantom quote, not a fillable arb. */
function isSuspiciousLive(r: LiveArbResult): boolean {
  if (r.roiPct <= SUSPICIOUS_ROI_PCT) return false;
  const depthUnknown =
    (r.kalshiYesDepth <= 0 && r.kalshiNoDepth <= 0) ||
    (r.pmYesDepth <= 0 && r.pmNoDepth <= 0);
  return depthUnknown;
}

async function writeLiveResult(
  pairId: string,
  results: LiveArbResult[],
  positive: LiveArbResult[],
  canonical: WatcherMatchPublication,
  observedAt: string,
): Promise<void> {
  const clean = positive.filter((r) => !isSuspiciousLive(r));
  const best = clean.length > 0
    ? clean.reduce((b, r) => (r.roiPct > b.roiPct ? r : b))
    : null;

  const matchedCount = canonical.matchedPairs.length;
  const outcomeApyFor = (result: LiveArbResult) => calculateOutcomeContingentApy({
    roiPct: result.roiPct,
    observedAt,
    arbType: result.arbType,
    strategy: result.strategy,
    kalshi: null,
    polymarket: null,
  });
  const bestOutcomeApy = best ? outcomeApyFor(best) : undefined;
  const pair = hotPairs.get(pairId);
  const canonicalApyFor = (result: LiveArbResult) => calculateScanApy(result.roiPct, observedAt, pair?.expiryDate);

  const liveResult: LastScanResult = {
    bestRoiPct: best ? best.roiPct : 0,
    bestProfit: best ? best.expectedProfit : 0,      // net of fees (live-arb-engine)
    strategy: best ? best.strategy : 'No arb',
    outcomeCount: results.length,
    matchedCount,
    matchStatus: matchedCount > 0 ? 'matched' : 'confirmed_zero',
    matchedPairs: canonical.matchedPairs,
    matchDependencies: canonical.matchDependencies,
    kalshiCount: results.filter((r) => r.kalshiYesAsk != null).length,
    pmCount: results.filter((r) => r.pmYesAsk != null).length,
    scannedAt: observedAt,
    publicationGeneration: canonical.publicationGeneration,
    priceResolved: computePriceResolved(results.map((r) => ({
      kalshi: r.kalshiYesAsk != null && r.kalshiNoAsk != null
        ? { yesAsk: r.kalshiYesAsk, noAsk: r.kalshiNoAsk }
        : null,
      polymarket: r.pmYesAsk != null && r.pmNoAsk != null
        ? { yesPrice: r.pmYesAsk, noPrice: r.pmNoAsk }
        : null,
    }))),
    allArbs: clean.map((r) => ({
      artist: r.artist,
      roiPct: r.roiPct,
      expectedProfit: r.expectedProfit,
      strategy: r.strategy,
      apyPct: canonicalApyFor(r).apyPct,
      daysToExpiry: canonicalApyFor(r).daysToExpiry,
      expiryAt: pair?.expiryDate ?? null,
      apyUnavailableReason: canonicalApyFor(r).unavailableReason,
      outcomeApy: outcomeApyFor(r),
      fees: r.fees ? {
        kalshiFee: r.fees.kalshiFee,
        pmFee: r.fees.pmFee,
        kalshiFeeDetails: '',
        pmFeeDetails: '',
        netProfitIfKalshiWins: r.fees.worstCaseNetProfit,
        netProfitIfPmWins: r.fees.worstCaseNetProfit,
        worstCaseNetProfit: r.fees.worstCaseNetProfit,
      } : undefined,
    })),
  };

  try {
    await updateSavedMarketLiveResult(pairId, liveResult);
    if (clean.length > 0) {
      const persisted = await persistAndConsumeBotScan(pairId, {
        bestRoiPct: best?.roiPct ?? 0,
        bestProfit: best?.expectedProfit ?? 0,
        strategy: best?.strategy ?? 'No arb',
        outcomeCount: results.length,
        matchedCount,
        kalshiCount: results.filter((r) => r.kalshiYesAsk != null).length,
        pmCount: results.filter((r) => r.pmYesAsk != null).length,
        positiveArbCount: clean.length,
        totalStake: clean.reduce((sum, r) => sum + r.kalshiStake + r.pmStake, 0),
        scannedAt: liveResult.scannedAt!,
        expiryAt: pair?.expiryDate ?? null,
        outcomeApy: bestOutcomeApy,
        marketTitle: pair?.title ?? pairId,
        arbType: best?.arbType ?? undefined,
        raw: {
          category: pair?.category,
          allArbs: clean.map((r) => ({
            artist: r.artist,
            strategy: r.strategy,
            roiPct: r.roiPct,
            expectedProfit: r.expectedProfit,
            apyPct: canonicalApyFor(r).apyPct,
            daysToExpiry: canonicalApyFor(r).daysToExpiry,
            expiryAt: pair?.expiryDate ?? null,
            apyUnavailableReason: canonicalApyFor(r).unavailableReason,
            outcomeApy: outcomeApyFor(r),
            kalshiStake: r.kalshiStake,
            pmStake: r.pmStake,
            kalshiTicker: r.kalshiTicker,
            pmConditionId: r.pmConditionId,
            kalshiYesAsk: r.kalshiYesAsk,
            kalshiNoAsk: r.kalshiNoAsk,
            pmBestAsk: r.pmYesAsk,
            pmNoPrice: r.pmNoAsk,
            kalshiYesDepth: r.kalshiYesDepth,
            kalshiNoDepth: r.kalshiNoDepth,
            pmYesDepth: r.pmYesDepth,
            pmNoDepth: r.pmNoDepth,
            fees: r.fees,
            stale: r.stale,
          })),
        },
      }, 'watcher');
      logger.debug('[watcher] persisted BotTrader scan decision', { pairId, scanId: persisted.id, state: persisted.decision?.state });
    }
    liveWriteCount++;
  } catch (err) {
    liveWriteErrors++;
    throw err;
  }
}

// ── WS-105: integrity layer ─────────────────────────────────────

function bestAsks(id: string): { yes: number | null; no: number | null } {
  const b = orderbookState.getBook(id);
  return {
    yes: b?.yes.asks[0]?.price ?? null,
    no: b?.no.asks[0]?.price ?? null,
  };
}

// (2) Periodic REST reconcile: REST is truth. For every HOT book, snapshot the
// current WS-maintained best asks, replace the book from REST, and log when the
// WS view disagreed materially (stale-ask phantom-arb protection).
async function reconcileBooks(): Promise<void> {
  const tickers = [...tickerToPairs.keys()];
  const tokens = [...tokenToPairs.keys()];
  let disagreements = 0;

  const reconcileOne = async (id: string, isKalshi: boolean): Promise<void> => {
    const before = bestAsks(id);
    if (isKalshi) await seedKalshiBook(id);
    else await seedPmBook(id, pmTokenSides.get(id) ?? 'yes');
    const after = bestAsks(id);
    for (const side of ['yes', 'no'] as const) {
      const b = before[side];
      const a = after[side];
      if (b != null && a != null && Math.abs(b - a) >= RECONCILE_DISAGREE_CENTS) {
        disagreements++;
        logger.warn('[watcher] reconcile disagreement — REST wins', {
          id, side, wsAsk: b, restAsk: a, source: isKalshi ? 'kalshi' : 'pm',
        });
        const pairs = (isKalshi ? tickerToPairs : tokenToPairs).get(id);
        if (pairs) for (const pid of pairs) schedulePairCompute(pid);
      }
    }
  };

  const jobs: { id: string; isKalshi: boolean }[] = [
    ...tickers.map((id) => ({ id, isKalshi: true })),
    ...tokens.map((id) => ({ id, isKalshi: false })),
  ];
  for (let i = 0; i < jobs.length; i += RECONCILE_CHUNK) {
    await Promise.all(jobs.slice(i, i + RECONCILE_CHUNK).map((j) => reconcileOne(j.id, j.isKalshi).catch(() => {})));
  }

  reconcileCount++;
  reconcileDisagreements += disagreements;
  lastReconcileAt = Date.now();
  logger.info('[watcher] reconcile pass done', { books: jobs.length, disagreements });
}

// (3) Staleness guard: a HOT book silent longer than STALE_BOOK_MS gets re-seeded.
// Books that repeatedly fail to seed (expired/dead markets) are suppressed so we
// don't hammer REST every sweep; suppression clears when tiers change the target set.
const deadBooks = new Map<string, number>(); // id -> consecutive failed re-seeds
const DEAD_BOOK_STRIKES = 3;

async function staleSweep(): Promise<void> {
  const isDead = (t: string) => (deadBooks.get(t) ?? 0) >= DEAD_BOOK_STRIKES;
  const staleTickers = [...tickerToPairs.keys()].filter((t) => !isDead(t) && orderbookState.isStale(t, STALE_BOOK_MS));
  const staleTokens = [...tokenToPairs.keys()].filter((t) => !isDead(t) && orderbookState.isStale(t, STALE_BOOK_MS));
  if (staleTickers.length === 0 && staleTokens.length === 0) return;
  staleReseedCount += staleTickers.length + staleTokens.length;
  logger.warn('[watcher] stale books — re-seeding', { kalshi: staleTickers.length, pm: staleTokens.length });
  await seedAllBooks(staleTickers, staleTokens, pmTokenSides).catch(() => {});
  const affected = new Set<string>();
  for (const t of [...staleTickers, ...staleTokens]) {
    if (orderbookState.hasBook(t) && !orderbookState.isStale(t, STALE_BOOK_MS)) {
      deadBooks.delete(t);
      for (const pid of (tickerToPairs.get(t) ?? tokenToPairs.get(t)) ?? []) affected.add(pid);
    } else {
      const strikes = (deadBooks.get(t) ?? 0) + 1;
      deadBooks.set(t, strikes);
      if (strikes === DEAD_BOOK_STRIKES) logger.warn('[watcher] book unseedable — suppressing (dead market?)', { id: t });
    }
  }
  for (const pid of affected) schedulePairCompute(pid);
}

// (4) Degraded-mode breaker: repeated WS flaps or sustained disconnect ->
// declare degraded in the health file. The REST poller never stopped, so
// coverage is intact — this is a signal, not a failover. Auto-recovers after
// a stable window.
function breakerCheck(): void {
  const now = Date.now();
  const kalshiUp = kalshiWs.isConnected();
  const pmUp = pmPool.length === 0 || pmPool.some((c) => c.isConnected());

  // Edge-detect Kalshi disconnects as flap events
  if (kalshiWasConnected && !kalshiUp) flapEvents.push(now);
  kalshiWasConnected = kalshiUp;
  if (!kalshiUp && kalshiDownSince === 0) kalshiDownSince = now;
  if (kalshiUp) kalshiDownSince = 0;

  // Prune flap window
  while (flapEvents.length && flapEvents[0] < now - BREAKER_FLAP_WINDOW_MS) flapEvents.shift();

  const flapping = flapEvents.length >= BREAKER_FLAP_LIMIT;
  const sustainedDown = (kalshiDownSince !== 0 && now - kalshiDownSince >= BREAKER_DOWN_MS) || !pmUp;

  if (!degraded && (flapping || sustainedDown)) {
    degraded = true;
    degradedSince = now;
    logger.error('[watcher] DEGRADED — WS unreliable, REST poller remains full coverage', {
      flaps: flapEvents.length, kalshiUp, pmUp,
      kalshiDownForMs: kalshiDownSince ? now - kalshiDownSince : 0,
    });
    writeHealth();
  } else if (degraded && kalshiUp && pmUp && !flapping) {
    // Require a stable window since the last flap before recovering
    const lastFlap = flapEvents[flapEvents.length - 1] ?? 0;
    if (now - Math.max(lastFlap, degradedSince) >= BREAKER_RECOVER_MS) {
      degraded = false;
      degradedSince = 0;
      logger.info('[watcher] recovered from degraded mode');
      writeHealth();
    }
  }
}

// ── Health ──────────────────────────────────────────────────────

function writeHealth(): void {
  const pmConnected = pmPool.filter((c) => c.isConnected()).length;
  const health = {
    status: degraded ? 'degraded' : 'ok',
    ts: new Date().toISOString(),
    kalshiConnected: kalshiWs.isConnected(),
    pmConnections: `${pmConnected}/${pmPool.length}`,
    hotPairs: hotPairs.size,
    kalshiTickers: tickerToPairs.size,
    pmTokens: tokenToPairs.size,
    msgCount,
    lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
    liveWrites: { count: liveWriteCount, errors: liveWriteErrors },  // WS-107
    tierStats,
    integrity: {
      degraded,
      degradedSince: degradedSince ? new Date(degradedSince).toISOString() : null,
      flapsInWindow: flapEvents.length,
      seqGaps: seqGapCount,
      staleReseeds: staleReseedCount,
      reconcilePasses: reconcileCount,
      reconcileDisagreements,
      lastReconcileAt: lastReconcileAt ? new Date(lastReconcileAt).toISOString() : null,
    },
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
  // WS-105 integrity loops
  setInterval(() => { reconcileBooks().catch((err) => logger.warn('[watcher] reconcile failed', { err })); }, RECONCILE_MS);
  setInterval(() => { staleSweep().catch((err) => logger.warn('[watcher] stale sweep failed', { err })); }, STALE_CHECK_MS);
  setInterval(breakerCheck, BREAKER_CHECK_MS);
  kalshiWasConnected = kalshiWs.isConnected();
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
