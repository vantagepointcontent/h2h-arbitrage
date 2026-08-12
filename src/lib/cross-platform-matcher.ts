// Cross-platform market matcher: Kalshi <-> Polymarket.
// Input: market_catalog table. Output: matched_pairs table with confidence + URL verification.
// Victor's requirement: deterministic, verifiable — every stored pair has live URLs.

import {
  fetchAllKalshiMarkets,
  fetchKalshiMarket,
  KalshiMarket,
} from './kalshi';
import {
  fetchAllPolymarketMarkets,
  fetchPolymarketMarketAsEvent,
  PMEvent,
  PMMarket,
  parseOutcomes,
} from './polymarket';
import { calculateConfidence, ConfidenceBreakdown, normalizeTitle } from './auto-discovery';
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

const DEFAULT_OPTS: Required<Omit<MatcherOptions, 'onProgress'>> = {
  candidateThreshold: 50,
  maxVerifications: 500,
  maxExpiryDays: 7,
  autoQueueThreshold: 70,
  reviewThreshold: 50,
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


function expiryWithinDays(a: string | null, b: string | null, days: number): boolean {
  // Fail closed: without two valid expiries, proximity is not verifiable.
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
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

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = a[i - 1] === b[j - 1]
        ? diagonal
        : 1 + Math.min(diagonal, previous[j - 1], above);
      diagonal = above;
    }
  }
  return previous[b.length];
}

function namedEntities(title: string): string[] {
  const excluded = new Set([
    'a', 'an', 'are', 'can', 'could', 'did', 'do', 'does', 'how', 'is', 'may',
    'shall', 'should', 'the', 'was', 'were', 'what', 'when', 'where', 'which',
    'who', 'why', 'will', 'would', 'yes', 'no',
    'january', 'february', 'march', 'april', 'june', 'july', 'august',
    'september', 'october', 'november', 'december',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  ]);
  return [...new Set(
    (title.match(/\p{Lu}[\p{L}\p{M}'’-]*/gu) ?? [])
      .map((token) => token.toLowerCase())
      .filter((token) => !excluded.has(token)),
  )].sort();
}

function propositionDirection(title: string): { negated: boolean; comparator: 'up' | 'down' | null } {
  const normalized = normalizeTitle(title);
  const tokens = new Set(normalized.split(/\s+/));
  const negated = ['not', 'never', 'no', 'without'].some((token) => tokens.has(token));
  const up = ['above', 'over', 'exceed', 'exceeds', 'exceeding', 'greater', 'higher', 'more', 'increase', 'rise', 'win', 'wins'].some((token) => tokens.has(token));
  const down = ['below', 'under', 'less', 'lower', 'decrease', 'fall', 'lose', 'loses'].some((token) => tokens.has(token));
  return { negated, comparator: up === down ? null : (up ? 'up' : 'down') };
}

/** Deterministic title gate applied before the legacy confidence scorer. */
function titlesHaveVerifiableOverlap(titleA: string, titleB: string): boolean {
  const a = normalizeTitle(titleA);
  const b = normalizeTitle(titleB);
  if (!a || !b) return false;

  const entitiesA = namedEntities(titleA);
  const entitiesB = namedEntities(titleB);
  if ((entitiesA.length > 0 || entitiesB.length > 0) && entitiesA.join('|') !== entitiesB.join('|')) {
    return false;
  }

  const directionA = propositionDirection(titleA);
  const directionB = propositionDirection(titleB);
  if (directionA.negated !== directionB.negated) return false;
  if (directionA.comparator && directionB.comparator && directionA.comparator !== directionB.comparator) {
    return false;
  }

  const numbersA = [...new Set(a.match(/\b\d+(?:\.\d+)?\b/g) ?? [])].sort();
  const numbersB = [...new Set(b.match(/\b\d+(?:\.\d+)?\b/g) ?? [])].sort();
  // A date, threshold, score, or count is event-defining. Any mismatch rejects.
  if ((numbersA.length > 0 || numbersB.length > 0) && numbersA.join('|') !== numbersB.join('|')) {
    return false;
  }

  const maxLength = Math.max(a.length, b.length, 1);
  const editRatio = levenshteinDistance(a, b) / maxLength;
  const tokenOverlap = jaccardTokens(a, b);
  return editRatio <= 0.30 || tokenOverlap >= 0.35;
}

function isBinaryKalshi(market: KalshiMarket | null): boolean {
  if (!market) return false;
  if (market.status !== 'open') return false;
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
  // Never accept a sibling or fallback market: the exact verified slug must exist.
  const market = event.markets.find(m => m.slug === slug);
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
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), ms),
      ),
    ]);
  } catch {
    return null;
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = [];
  const queue = items.map((item, i) => ({ item, i }));
  let index = 0;
  async function worker() {
    while (index < queue.length) {
      const { item, i } = queue[index++];
      results[i] = await fn(item);
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
      eventId: m.slug || null,
      eventTitle: m.groupItemTitle || null,
      expiryDate: m.endDate ? String(m.endDate) : null,
      isBinary,
      outcomeCount: outcomes.length || 2,
      yesBid: isBinary ? (m.bestBid ?? prices[0] ?? null) : null,
      yesAsk: isBinary ? (m.bestAsk ?? prices[0] ?? null) : null,
      noBid: isBinary ? (m.bestBid != null ? 1 - m.bestBid : prices[1] ?? null) : null,
      noAsk: isBinary ? (m.bestAsk != null ? 1 - m.bestAsk : prices[1] ?? null) : null,
      volume24h: m.volumeNum ?? m.volumeClob ?? (m.volume != null ? Number(m.volume) : null),
      sourceUrl: `https://polymarket.com/event/${m.slug}`,
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

async function loadAllCatalogRows(platform: 'kalshi' | 'polymarket'): Promise<MarketCatalogRow[]> {
  const rows: MarketCatalogRow[] = [];
  let cursor: number | null = 0;
  do {
    const page = await queryMarketCatalog({
      platform,
      includeStale: false,
      limit: 1000,
      cursor,
    });
    rows.push(...page.rows);
    if (page.nextCursor != null && page.nextCursor <= cursor) {
      throw new Error(`Catalog pagination did not advance for ${platform}`);
    }
    cursor = page.nextCursor;
  } while (cursor != null);
  return rows;
}

export async function matchCrossPlatformMarkets(opts?: MatcherOptions): Promise<MatchRunResult> {
  const options: Required<Omit<MatcherOptions, 'onProgress'>> = {
    candidateThreshold: opts?.candidateThreshold ?? DEFAULT_OPTS.candidateThreshold,
    maxVerifications: opts?.maxVerifications ?? DEFAULT_OPTS.maxVerifications,
    maxExpiryDays: opts?.maxExpiryDays ?? DEFAULT_OPTS.maxExpiryDays,
    autoQueueThreshold: opts?.autoQueueThreshold ?? DEFAULT_OPTS.autoQueueThreshold,
    reviewThreshold: opts?.reviewThreshold ?? DEFAULT_OPTS.reviewThreshold,
  };
  const start = Date.now();
  const errors: string[] = [];

  const [kalshiMarkets, pmMarkets] = await Promise.all([
    loadAllCatalogRows('kalshi'),
    loadAllCatalogRows('polymarket'),
  ]);

  opts?.onProgress?.({ step: 'matching', message: 'Matching cross-platform pairs...' });

  // Build inverted index by normalized category to avoid full O(N*M) loop.
  const pmByCategory = new Map<string, MarketCatalogRow[]>();
  for (const p of pmMarkets) {
    if (!p.isBinary || p.outcomeCount !== 2) continue;
    const cat = normalizeCategory(p.category);
    const list = pmByCategory.get(cat) || [];
    list.push(p);
    pmByCategory.set(cat, list);
  }

  const candidates: Candidate[] = [];
  for (const k of kalshiMarkets) {
    if (!k.isBinary || k.outcomeCount !== 2) continue;
    const cat = normalizeCategory(k.category);
    const pmList = pmByCategory.get(cat);
    if (!pmList || pmList.length === 0) continue;
    for (const p of pmList) {
      if (!expiryWithinDays(k.expiryDate, p.expiryDate, options.maxExpiryDays)) continue;
      if (!titlesHaveVerifiableOverlap(k.title, p.title)) continue;
      const { confidence, breakdown } = calculateConfidence(
        k.title,
        p.title,
        k.category || '',
        p.category || '',
        k.expiryDate,
        p.expiryDate,
      );
      if (confidence < Math.max(options.candidateThreshold, options.reviewThreshold)) continue;
      candidates.push({ kalshi: k, polymarket: p, confidence, breakdown });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const toVerify = candidates.slice(0, options.maxVerifications);
  const kalshiCandidateCounts = new Map<string, number>();
  const polymarketCandidateCounts = new Map<string, number>();
  for (const candidate of candidates) {
    kalshiCandidateCounts.set(candidate.kalshi.marketId, (kalshiCandidateCounts.get(candidate.kalshi.marketId) ?? 0) + 1);
    polymarketCandidateCounts.set(candidate.polymarket.marketId, (polymarketCandidateCounts.get(candidate.polymarket.marketId) ?? 0) + 1);
  }

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
    if (kMarket.ticker.toLowerCase() !== kTicker.toLowerCase()) {
      errors.push(`Kalshi verify returned wrong ticker: ${kTicker}`);
      return;
    }
    const liveKalshiTitle = kMarket.title || kMarket.yes_sub_title || '';
    if (!titlesHaveVerifiableOverlap(candidate.kalshi.title, liveKalshiTitle)) {
      errors.push(`Kalshi live semantics changed: ${kTicker}`);
      return;
    }
    if (!isBinaryPolymarket(pEvent, pSlug || '')) {
      errors.push(`Polymarket event not binary/open: ${pSlug}`);
      return;
    }
    const livePolymarketMarket = pEvent.markets.find((market) => market.slug === pSlug);
    if (!livePolymarketMarket || !titlesHaveVerifiableOverlap(candidate.polymarket.title, livePolymarketMarket.question || '')) {
      errors.push(`Polymarket live semantics changed: ${pSlug}`);
      return;
    }
    if (!titlesHaveVerifiableOverlap(liveKalshiTitle, livePolymarketMarket.question || '')) {
      errors.push(`Live propositions disagree: ${kTicker}/${pSlug}`);
      return;
    }

    const isUnambiguous =
      kalshiCandidateCounts.get(candidate.kalshi.marketId) === 1 &&
      polymarketCandidateCounts.get(candidate.polymarket.marketId) === 1;
    const status: MatchedPair['status'] =
      candidate.confidence >= options.autoQueueThreshold && isUnambiguous
        ? 'auto_queued'
        : 'pending_review';

    try {
      await upsertMatchedPair({
        kalshiMarketId: kTicker,
        polymarketMarketId: candidate.polymarket.marketId,
        kalshiTitle: candidate.kalshi.title,
        polymarketTitle: candidate.polymarket.title,
        kalshiUrl: buildKalshiUrl(kTicker),
        polymarketUrl: buildPolymarketUrl(pSlug || ''),
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
    kalshiCatalogCount: kalshiMarkets.length,
    polymarketCatalogCount: pmMarkets.length,
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
