// Cross-platform market matcher: Kalshi <-> Polymarket.
// Input: market_catalog table. Output: matched_pairs table with confidence + URL verification.
// Victor's requirement: deterministic, verifiable — every stored pair has live URLs.

import { fetchAllPlatformMarkets, PhV2Market } from './predictionhunt';
import {
  fetchKalshiMarket,
  KalshiMarket,
} from './kalshi';
import {
  fetchPolymarketMarketAsEvent,
  PMEvent,
  parseOutcomes,
} from './polymarket';
import { calculateConfidence, ConfidenceBreakdown, normalizeTitle } from './auto-discovery';
import {
  fetchAllKalshiMarkets,
} from './kalshi';
import {
  fetchAllPolymarketMarkets,
  PMMarket,
} from './polymarket';
import { withTimeout as withSharedTimeout } from './scan-shared';
import {
  MarketCatalogRow,
  MatchedPair,
  queryMarketCatalog,
  bulkUpsertMarketCatalog,
  markStaleMarketCatalog,
  upsertMatchedPair,
} from './persistence';

/* ──────────────────────────── Types ──────────────────────────── */

export interface MatcherOptions {
  candidateThreshold?: number;
  maxVerifications?: number;
  maxExpiryDays?: number;
  autoQueueThreshold?: number;
  reviewThreshold?: number;
  maxCatalogRowsPerPlatform?: number;
  maxCandidateComparisons?: number;
  yieldEveryComparisons?: number;
  onProgress?: (update: {
    step?: 'matching' | 'verifying';
    candidates?: number;
    verified?: number;
    verifiedTotal?: number;
    newPairs?: number;
    message?: string;
  }) => void;
}

export interface MatchRunResult {
  kalshiCatalogCount: number;
  polymarketCatalogCount: number;
  kalshiRowsLoaded: number;
  polymarketRowsLoaded: number;
  candidateComparisons: number;
  matchingTruncated: boolean;
  candidatesChecked: number;
  verifiedPairs: number;
  autoQueued: number;
  pendingReview: number;
  errors: string[];
  elapsedMs: number;
}

interface Candidate {
  kalshi: MarketCatalogRow;
  polymarket: MarketCatalogRow;
  confidence: number;
  breakdown: ConfidenceBreakdown;
}

export const DEFAULT_MATCHER_OPTIONS: Required<Omit<MatcherOptions, 'onProgress'>> = {
  candidateThreshold: 50,
  maxVerifications: 500,
  maxExpiryDays: 7,
  autoQueueThreshold: 70,
  reviewThreshold: 50,
  maxCatalogRowsPerPlatform: 10_000,
  maxCandidateComparisons: 100_000,
  yieldEveryComparisons: 250,
};

const CATEGORY_ALIASES: Record<string, string[]> = {
  election: ['elections', 'political'],
  politics: ['political', 'election', 'elections'],
  crypto: ['cryptocurrency'],
  sports: ['sport'],
  economics: ['economy', 'finance', 'finances'],
  technology: ['tech'],
  science: ['sci'],
  entertainment: ['entertainment'],
};

function normalizeCategory(cat: string | null | undefined): string {
  if (!cat) return 'unknown';
  const c = cat.toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if (canonical === c || aliases.includes(c)) return canonical;
  }
  return c;
}

function categoriesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeCategory(a) === normalizeCategory(b);
}

function expiryWithinDays(a: string | null, b: string | null, days: number): boolean {
  if (!a || !b) return true;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (isNaN(ta) || isNaN(tb)) return true;
  const diffDays = Math.abs(ta - tb) / (24 * 60 * 60 * 1000);
  return diffDays <= days;
}

function jaccardTokens(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/).filter(Boolean));
  const setB = new Set(b.split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function isBinaryKalshi(market: KalshiMarket | null): boolean {
  if (!market) return false;
  if (market.status !== 'open' && market.status !== 'active') return false;
  if (market.market_type) return market.market_type === 'binary';
  const title = (market.title || market.yes_sub_title || '').toLowerCase();
  const hasYesNo = Boolean(
    (market.yes_sub_title && market.no_sub_title) ||
    title.includes('yes') ||
    title.includes('no'),
  );
  return hasYesNo;
}

function isBinaryPolymarket(event: PMEvent | null, slug: string): boolean {
  if (!event || !event.markets || event.markets.length === 0) return false;
  if (!event.active || event.closed) return false;
  const market = event.markets.find(m => m.slug === slug) || event.markets[0];
  if (!market || !market.active || market.closed) return false;
  const parsed = parseOutcomes(market);
  const outcomes = parsed.outcomes.map(o => o.toLowerCase());
  return outcomes.length === 2 && outcomes.includes('yes') && outcomes.includes('no');
}

function buildKalshiUrl(ticker: string): string {
  return `https://kalshi.com/markets/${ticker.toUpperCase()}`;
}

function buildPolymarketUrl(slug: string): string {
  return `https://polymarket.com/event/${slug}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  try {
    return await withSharedTimeout(promise, ms, 'market verification');
  } catch {
    return null;
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = [];
  const queue = items.map((item, i) => ({ item, i }));
  let index = 0;
  async function worker() {
    while (index < queue.length) {
      const { item, i } = queue[index++];
      results[i] = await fn(item, i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

export async function refreshMarketCatalog(): Promise<{
  kalshi: number;
  polymarket: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const now = new Date().toISOString();
  let kalshiCount = 0;
  let polymarketCount = 0;

  const [kMarkets, pMarkets] = await Promise.all([
    fetchAllKalshiMarkets().catch((e: any) => {
      errors.push(`Kalshi catalog fetch: ${e.message}`);
      return [] as KalshiMarket[];
    }),
    fetchAllPolymarketMarkets().catch((e: any) => {
      errors.push(`Polymarket catalog fetch: ${e.message}`);
      return [] as PMMarket[];
    }),
  ]);

  const normalizeKalshi = (m: KalshiMarket) => {
    const title = m.title || m.yes_sub_title || m.ticker;
    return {
      platform: 'kalshi' as const,
      marketId: String(m.ticker),
      title,
      category: normalizeCategory(m.custom_strike?.category),
      eventId: m.event_ticker ? String(m.event_ticker) : null,
      eventTitle: null,
      expiryDate: m.close_time ? String(m.close_time) : null,
      isBinary: true,
      outcomeCount: 2,
      yesBid: m.yes_bid_dollars != null ? Number(m.yes_bid_dollars) : null,
      yesAsk: m.yes_ask_dollars != null ? Number(m.yes_ask_dollars) : null,
      noBid: m.no_bid_dollars != null ? Number(m.no_bid_dollars) : null,
      noAsk: m.no_ask_dollars != null ? Number(m.no_ask_dollars) : null,
      volume24h: m.volume_24h_fp != null ? Number(m.volume_24h_fp) : null,
      sourceUrl: `https://kalshi.com/markets/${m.ticker}`,
      fetchedAt: now,
    };
  };

  const normalizePM = (m: PMMarket) => {
    const { outcomes, prices } = parseOutcomes(m);
    const isBinary = outcomes.length === 2;
    return {
      platform: 'polymarket' as const,
      marketId: String(m.conditionId || m.id),
      title: m.question || m.slug || m.conditionId,
      category: null,
      eventId: null,
      eventTitle: m.groupItemTitle || null,
      expiryDate: m.endDate ? String(m.endDate) : null,
      isBinary,
      outcomeCount: outcomes.length || 2,
      yesBid: isBinary ? (m.bestBid ?? prices[0] ?? null) : null,
      yesAsk: isBinary ? (m.bestAsk ?? prices[0] ?? null) : null,
      noBid: isBinary ? (m.bestBid != null ? 1 - m.bestBid : prices[1] ?? null) : null,
      noAsk: isBinary ? (m.bestAsk != null ? 1 - m.bestAsk : prices[1] ?? null) : null,
      volume24h: m.volumeNum ?? m.volumeClob ?? (m.volume != null ? Number(m.volume) : null),
      sourceUrl: `https://polymarket.com/market/${m.slug}`,
      fetchedAt: now,
    };
  };

  const kRows = kMarkets.map(normalizeKalshi);
  const pRows = pMarkets.map(normalizePM);

  if (kRows.length > 0) {
    await bulkUpsertMarketCatalog(kRows);
    kalshiCount = kRows.length;
  }
  if (pRows.length > 0) {
    await bulkUpsertMarketCatalog(pRows);
    polymarketCount = pRows.length;
  }

  await Promise.all([
    markStaleMarketCatalog('kalshi', now),
    markStaleMarketCatalog('polymarket', now),
  ]);

  return { kalshi: kalshiCount, polymarket: polymarketCount, errors };
}

export async function matchCrossPlatformMarkets(opts?: MatcherOptions): Promise<MatchRunResult> {
  const options = { ...DEFAULT_MATCHER_OPTIONS, ...opts };
  const start = Date.now();
  const errors: string[] = [];

  const loadCatalog = async (platform: 'kalshi' | 'polymarket'): Promise<{ rows: MarketCatalogRow[]; total: number }> => {
    const rows: MarketCatalogRow[] = [];
    let total = 0;
    let cursor: number | null = 0;
    do {
      const remaining = options.maxCatalogRowsPerPlatform - rows.length;
      const page = await queryMarketCatalog({
        platform,
        includeStale: false,
        limit: Math.min(10_000, remaining),
        cursor,
      });
      total = page.total;
      rows.push(...page.rows.slice(0, remaining));
      cursor = rows.length >= options.maxCatalogRowsPerPlatform ? null : page.nextCursor;
    } while (cursor !== null);
    return { rows, total };
  };
  const [kalshiCatalog, pmCatalog] = await Promise.all([
    loadCatalog('kalshi'),
    loadCatalog('polymarket'),
  ]);
  const kalshiMarkets = kalshiCatalog.rows;
  const pmMarkets = pmCatalog.rows;

  opts?.onProgress?.({ step: 'matching', message: 'Matching cross-platform pairs...' });

  // Build inverted index by normalized category to avoid full O(N*M) loop.
  const pmByCategory = new Map<string, MarketCatalogRow[]>();
  for (const p of pmMarkets) {
    const cat = normalizeCategory(p.category);
    const list = pmByCategory.get(cat) || [];
    list.push(p);
    pmByCategory.set(cat, list);
  }

  const candidates: Candidate[] = [];
  let candidateComparisons = 0;
  let matchingTruncated =
    kalshiCatalog.total > kalshiMarkets.length ||
    pmCatalog.total > pmMarkets.length;
  matchingLoop:
  for (const k of kalshiMarkets) {
    const cat = normalizeCategory(k.category);
    const pmList = pmByCategory.get(cat);
    if (!pmList || pmList.length === 0) continue;
    for (const p of pmList) {
      if (candidateComparisons >= options.maxCandidateComparisons) {
        matchingTruncated = true;
        break matchingLoop;
      }
      candidateComparisons++;
      if (candidateComparisons % options.yieldEveryComparisons === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (!expiryWithinDays(k.expiryDate, p.expiryDate, options.maxExpiryDays)) continue;
      const { confidence, breakdown } = calculateConfidence(
        k.title,
        p.title,
        k.category || '',
        p.category || '',
        k.expiryDate,
        p.expiryDate,
      );
      if (confidence < options.candidateThreshold) continue;
      candidates.push({ kalshi: k, polymarket: p, confidence, breakdown });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const toVerify = candidates.slice(0, options.maxVerifications);

  opts?.onProgress?.({
    step: 'verifying',
    candidates: candidates.length,
    verifiedTotal: toVerify.length,
    message: `Verifying ${toVerify.length} matched pairs...`,
  });

  let verifiedPairs = 0;
  let autoQueued = 0;
  let pendingReview = 0;

  await runWithConcurrency(toVerify, async (candidate) => {
    const kTicker = candidate.kalshi.marketId;
    const pSlug = candidate.polymarket.eventId || candidate.polymarket.marketId;

    const [kMarket, pEvent] = await Promise.all([
      withTimeout(fetchKalshiMarket(kTicker), 8000),
      withTimeout(fetchPolymarketMarketAsEvent(pSlug || ''), 8000),
    ]);

    if (!kMarket) {
      errors.push(`Kalshi verify failed: ${kTicker}`);
      return;
    }
    if (!pEvent) {
      errors.push(`Polymarket verify failed: ${pSlug}`);
      return;
    }
    if (!isBinaryKalshi(kMarket)) {
      errors.push(`Kalshi market not binary/open: ${kTicker}`);
      return;
    }
    if (!isBinaryPolymarket(pEvent, pSlug || '')) {
      errors.push(`Polymarket event not binary/open: ${pSlug}`);
      return;
    }

    const status: MatchedPair['status'] =
      candidate.confidence >= options.autoQueueThreshold
        ? 'auto_queued'
        : 'pending_review';

    try {
      await upsertMatchedPair({
        kalshiMarketId: kTicker,
        polymarketMarketId: pSlug || '',
        kalshiTitle: candidate.kalshi.title,
        polymarketTitle: candidate.polymarket.title,
        kalshiUrl: candidate.kalshi.sourceUrl,
        polymarketUrl: candidate.polymarket.sourceUrl,
        confidence: candidate.confidence,
        confidenceBreakdown: candidate.breakdown,
        status,
        matchedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
      });
      verifiedPairs++;
      if (status === 'auto_queued') autoQueued++;
      else pendingReview++;
      opts?.onProgress?.({
        step: 'verifying',
        verified: verifiedPairs,
        verifiedTotal: toVerify.length,
        newPairs: autoQueued + pendingReview,
        message: `Verified ${verifiedPairs}/${toVerify.length} pairs`,
      });
    } catch (e: any) {
      errors.push(`DB upsert ${kTicker}/${pSlug}: ${e.message}`);
    }
  }, 5);

  return {
    kalshiCatalogCount: kalshiCatalog.total,
    polymarketCatalogCount: pmCatalog.total,
    kalshiRowsLoaded: kalshiMarkets.length,
    polymarketRowsLoaded: pmMarkets.length,
    candidateComparisons,
    matchingTruncated,
    candidatesChecked: candidates.length,
    verifiedPairs,
    autoQueued,
    pendingReview,
    errors,
    elapsedMs: Date.now() - start,
  };
}

export type { ConfidenceBreakdown };
export { normalizeTitle, calculateConfidence };

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function startCrossPlatformMatcherScheduler(): void {
  if (schedulerRunning) return;
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return;
  schedulerRunning = true;

  schedulerTimer = setInterval(() => {
    void matchCrossPlatformMarkets().catch((e: any) =>
      console.error('[cross-platform-matcher] scheduled run failed:', e?.message),
    );
  }, SIX_HOURS_MS);

  if (typeof (schedulerTimer as any).unref === 'function') {
    (schedulerTimer as any).unref();
  }
}

export function stopCrossPlatformMatcherScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerRunning = false;
}

startCrossPlatformMatcherScheduler();
