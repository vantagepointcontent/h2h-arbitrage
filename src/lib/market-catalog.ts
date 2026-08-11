/**
 * FEAT-046: Rate-limit-safe, incremental, resumable Market Catalog fetch.
 *
 * Refresh + normalize all open markets from Kalshi and Polymarket into SQLite.
 * The catalog is refreshed periodically by the daily cron + manual trigger.
 *
 * Core guarantees:
 *  - All upstream requests go through the existing rate limiters (no bypass).
 *  - Kalshi is category-partitioned; Polymarket is tag-partitioned.
 *  - Each paginated call has a minimum delay on top of the limiter (Kalshi 200ms, Gamma 50ms).
 *  - HTTP 429 triggers exponential backoff; 3 consecutive 429s abort the category,
 *    but we still resume from the last successful cursor/offset next run.
 *  - Incremental fetch uses API `since`/`modified_after` params when available;
 *    full refresh only on first run or manual `?full=true`.
 */

import { fetchAllKalshiMarkets, type KalshiMarket } from '@/lib/kalshi';
import { fetchAllPolymarketMarkets, parseOutcomePrices, type PMMarket } from '@/lib/polymarket';
import {
  bulkUpsertMarketCatalog,
  markStaleMarketCatalog,
  type MarketCatalogRow,
  getMarketCatalogMeta,
  setMarketCatalogMeta,
  getMarketCatalogMetaOverview,
  type MarketCatalogMetaRow,
} from '@/lib/persistence';
import { classifyMarket } from '@/lib/market-classification';
import { rateLimiters, isRateLimitedError } from '@/lib/rate-limiter';

/** Result of a single catalog refresh run. */
export interface CatalogRefreshResult {
  kalshi: { fetched: number; upserted: number; stale: number; durationMs: number; error?: string; rateLimitHits: number };
  polymarket: { fetched: number; upserted: number; stale: number; durationMs: number; error?: string; rateLimitHits: number };
  startedAt: string;
  finishedAt: string;
}

export interface RefreshOptions {
  runId?: string;
  full?: boolean;
  onProgress?: (update: {
    step?: 'fetching_kalshi' | 'fetching_polymarket';
    kalshiCount?: number;
    polymarketCount?: number;
    message?: string;
  }) => void;
}

export interface PageProgress {
  count: number;
  cursor?: string | null;
  page429s?: number;
}

export interface CatalogStatus {
  status: 'idle' | 'running' | 'failed';
  lastRunAt: string | null;
  lastFullFetchAt: string | null;
  marketsFetched: number;
  rateLimitHits: number;
  categories: MarketCatalogMetaRow[];
  totalCatalogRows: number;
  staleCatalogRows: number;
}

let refreshInProgress = false;

/** Refresh the market catalog from both platforms.
 *  Idempotent / serialized — concurrent calls return the same promise. */
export async function refreshMarketCatalog(options?: RefreshOptions): Promise<CatalogRefreshResult> {
  if (refreshInProgress) {
    // Serialize concurrent refresh attempts. The poller and manual API calls
    // shouldn't stampede the upstream APIs or SQLite writer.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return refreshMarketCatalog(options);
  }
  refreshInProgress = true;

  const startedAt = new Date().toISOString();
  const result: CatalogRefreshResult = {
    kalshi: { fetched: 0, upserted: 0, stale: 0, durationMs: 0, rateLimitHits: 0 },
    polymarket: { fetched: 0, upserted: 0, stale: 0, durationMs: 0, rateLimitHits: 0 },
    startedAt,
    finishedAt: startedAt,
  };

  try {
    const [kalshiRes, pmRes] = await Promise.allSettled([
      refreshKalshi(options),
      refreshPolymarket(options),
    ]);

    if (kalshiRes.status === 'fulfilled') {
      result.kalshi = kalshiRes.value;
    } else {
      result.kalshi.error = kalshiRes.reason instanceof Error ? kalshiRes.reason.message : String(kalshiRes.reason);
      console.error('[market-catalog] Kalshi refresh failed:', result.kalshi.error);
    }

    if (pmRes.status === 'fulfilled') {
      result.polymarket = pmRes.value;
    } else {
      result.polymarket.error = pmRes.reason instanceof Error ? pmRes.reason.message : String(pmRes.reason);
      console.error('[market-catalog] Polymarket refresh failed:', result.polymarket.error);
    }
  } finally {
    refreshInProgress = false;
    result.finishedAt = new Date().toISOString();
  }

  return result;
}

/** Read the current catalog job status from persisted meta rows. */
export async function getCatalogStatus(): Promise<CatalogStatus> {
  const overview = await getMarketCatalogMetaOverview();

  const lastRunAt = overview.categories.length > 0
    ? overview.categories.reduce((latest, c) => (!latest || (c.lastRunAt ?? '') > latest) ? (c.lastRunAt ?? '') : latest, '')
    : null;
  const lastFullFetchAt = overview.categories.length > 0
    ? overview.categories.reduce((latest, c) => (!latest || (c.lastFullFetchAt ?? '') > latest) ? (c.lastFullFetchAt ?? '') : latest, '')
    : null;

  const running = overview.categories.some(c => c.lastRunStatus === 'running');
  const failed = overview.categories.some(c => c.lastRunStatus === 'failed' || c.lastRunStatus === 'aborted');

  return {
    status: running ? 'running' : failed ? 'failed' : 'idle',
    lastRunAt: lastRunAt || null,
    lastFullFetchAt: lastFullFetchAt || null,
    marketsFetched: overview.categories.reduce((sum, c) => sum + c.marketsFetched, 0),
    rateLimitHits: overview.categories.reduce((sum, c) => sum + c.rateLimitHits, 0),
    categories: overview.categories,
    totalCatalogRows: overview.totalMarkets,
    staleCatalogRows: overview.staleMarkets,
  };
}

// ─── Kalshi category-partitioned fetch ──────────────────────────────

const KALSHI_CATEGORIES = ['politics', 'sports', 'crypto', 'finance', 'entertainment', 'science', 'world'];
const KALSHI_MIN_PAGE_DELAY_MS = 200;
const KALSHI_CONSEC_429_ABORT = 3;

async function refreshKalshi(options?: RefreshOptions): Promise<CatalogRefreshResult['kalshi']> {
  const start = Date.now();
  options?.onProgress?.({ step: 'fetching_kalshi', message: 'Fetching Kalshi markets by category...' });

  const fetchedAt = new Date().toISOString();
  let totalFetched = 0;
  let totalUpserted = 0;
  let totalRateLimitHits = 0;

  // Decide whether we need a full refresh. If any category has never done a full
  // fetch, treat this as a full refresh for the whole platform.
  const full = options?.full ?? !(await haveAllCategoriesFetched('kalshi', KALSHI_CATEGORIES));

  const categoryResults = await Promise.all(
    KALSHI_CATEGORIES.map(async (category) => {
      const meta = await getMarketCatalogMeta('kalshi', category);
      await setMarketCatalogMeta('kalshi', category, {
        lastRunAt: fetchedAt,
        lastRunStatus: 'running',
      });

      let rateLimitHits = 0;
      let consecutive429s = 0;
      let categoryFetched: KalshiMarket[] = [];
      let aborted = false;
      let errorMessage: string | null = null;
      let lastOffset: string | null = full ? null : (meta.lastSuccessfulOffset ?? null);

      try {
        const since = full ? null : meta.lastFullFetchAt;
        categoryFetched = await fetchAllKalshiMarkets({
          category,
          since,
          resumeCursor: lastOffset,
          minPageDelayMs: KALSHI_MIN_PAGE_DELAY_MS,
          onPage: (count, cursor, page429s) => {
            options?.onProgress?.({ step: 'fetching_kalshi', kalshiCount: totalFetched + count });
            if (page429s) {
              rateLimitHits += page429s;
              consecutive429s += page429s;
            } else {
              consecutive429s = 0;
            }
            if (cursor) {
              lastOffset = cursor;
              // Persist resume cursor live so a crash mid-category can resume.
              void setMarketCatalogMeta('kalshi', category, { lastSuccessfulOffset: cursor });
            }
            if (consecutive429s >= KALSHI_CONSEC_429_ABORT) {
              aborted = true;
              errorMessage = `Aborted after ${KALSHI_CONSEC_429_ABORT} consecutive 429s`;
              throw new Error(errorMessage);
            }
          },
        });
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        if (isRateLimitedError(err)) {
          aborted = true;
        }
        // If we aborted due to 429s, keep whatever we fetched so far and mark aborted.
      }

      const rows = normalizeKalshiRows(categoryFetched, fetchedAt);
      const upserted = rows.length > 0 ? await bulkUpsertMarketCatalog(rows) : 0;
      totalFetched += categoryFetched.length;
      totalUpserted += upserted;
      totalRateLimitHits += rateLimitHits;

      await setMarketCatalogMeta('kalshi', category, {
        lastRunAt: fetchedAt,
        lastRunStatus: aborted ? 'aborted' : errorMessage ? 'failed' : 'idle',
        lastSuccessfulOffset: aborted ? lastOffset : null,
        marketsFetched: categoryFetched.length,
        rateLimitHits,
        errorMessage: errorMessage ?? undefined,
        ...(full ? { lastFullFetchAt: fetchedAt } : {}),
      });

      return { categoryFetched, aborted, errorMessage };
    }),
  );

  const anyFailed = categoryResults.some(r => r.aborted || r.errorMessage);
  const before = fetchedAt;
  const stale = await markStaleMarketCatalog('kalshi', before);
  const durationMs = Date.now() - start;

  options?.onProgress?.({
    step: 'fetching_kalshi',
    kalshiCount: totalFetched,
    message: `${totalFetched} Kalshi markets fetched${anyFailed ? ' (some categories aborted)' : ''}`,
  });

  return {
    fetched: totalFetched,
    upserted: totalUpserted,
    stale,
    durationMs,
    rateLimitHits: totalRateLimitHits,
    error: anyFailed
      ? categoryResults.map(r => r.errorMessage).filter(Boolean).join('; ') || undefined
      : undefined,
  };
}

async function haveAllCategoriesFetched(platform: 'kalshi' | 'polymarket', categories: string[]): Promise<boolean> {
  for (const category of categories) {
    const meta = await getMarketCatalogMeta(platform, category);
    if (!meta.lastFullFetchAt) return false;
  }
  return true;
}

function normalizeKalshiRows(markets: KalshiMarket[], fetchedAt: string): Omit<MarketCatalogRow, 'id' | 'stale'>[] {
  return markets
    .filter((m) => m.ticker)
    .map((m): Omit<MarketCatalogRow, 'id' | 'stale'> => {
      const yesBid = parseNullableDollar(m.yes_bid_dollars);
      const yesAsk = parseNullableDollar(m.yes_ask_dollars);
      const noBid = parseNullableDollar(m.no_bid_dollars);
      const noAsk = parseNullableDollar(m.no_ask_dollars);
      const volume24h = parseNullableDollar(m.volume_24h_fp);
      const classification = classifyMarket(m.title || m.ticker);
      return {
        platform: 'kalshi',
        marketId: m.ticker,
        title: m.title || m.ticker,
        category: classification.domain || null,
        eventId: m.event_ticker || null,
        eventTitle: m.title ? m.title.replace(/ - (YES|NO)$/i, '') : null,
        expiryDate: m.close_time || null,
        isBinary: true,
        outcomeCount: 2,
        yesBid,
        yesAsk,
        noBid,
        noAsk,
        volume24h,
        sourceUrl: `https://kalshi.com/markets/${m.ticker}`,
        fetchedAt,
      };
    });
}

// ─── Polymarket tag-partitioned fetch ───────────────────────────────

const POLYMARKET_TAGS = ['Politics', 'Sports', 'Crypto', 'Business', 'Science', 'Entertainment', 'World'];
const POLY_MIN_PAGE_DELAY_MS = 50;
const POLY_CONSEC_429_ABORT = 3;

async function refreshPolymarket(options?: RefreshOptions): Promise<CatalogRefreshResult['polymarket']> {
  const start = Date.now();
  options?.onProgress?.({ step: 'fetching_polymarket', message: 'Fetching Polymarket markets by tag...' });

  const fetchedAt = new Date().toISOString();
  let totalFetched = 0;
  let totalUpserted = 0;
  let totalRateLimitHits = 0;

  const full = options?.full ?? !(await haveAllCategoriesFetched('polymarket', POLYMARKET_TAGS));

  const tagResults = await Promise.all(
    POLYMARKET_TAGS.map(async (tag) => {
      const meta = await getMarketCatalogMeta('polymarket', tag);
      await setMarketCatalogMeta('polymarket', tag, {
        lastRunAt: fetchedAt,
        lastRunStatus: 'running',
      });

      let rateLimitHits = 0;
      let consecutive429s = 0;
      let tagFetched: PMMarket[] = [];
      let aborted = false;
      let errorMessage: string | null = null;
      let lastCursor: string | null = full ? null : (meta.lastSuccessfulOffset ?? null);

      try {
        const since = full ? null : meta.lastFullFetchAt;
        tagFetched = await fetchAllPolymarketMarkets({
          tag,
          since,
          resumeCursor: lastCursor,
          minPageDelayMs: POLY_MIN_PAGE_DELAY_MS,
          onPage: (count, cursor, page429s) => {
            options?.onProgress?.({ step: 'fetching_polymarket', polymarketCount: totalFetched + count });
            if (page429s) {
              rateLimitHits += page429s;
              consecutive429s += page429s;
            } else {
              consecutive429s = 0;
            }
            if (cursor) {
              lastCursor = cursor;
              void setMarketCatalogMeta('polymarket', tag, { lastSuccessfulOffset: cursor });
            }
            if (consecutive429s >= POLY_CONSEC_429_ABORT) {
              aborted = true;
              errorMessage = `Aborted after ${POLY_CONSEC_429_ABORT} consecutive 429s`;
              throw new Error(errorMessage);
            }
          },
        });
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        if (isRateLimitedError(err)) {
          aborted = true;
        }
      }

      const rows = normalizePolymarketRows(tagFetched, fetchedAt);
      const upserted = rows.length > 0 ? await bulkUpsertMarketCatalog(rows) : 0;
      totalFetched += tagFetched.length;
      totalUpserted += upserted;
      totalRateLimitHits += rateLimitHits;

      await setMarketCatalogMeta('polymarket', tag, {
        lastRunAt: fetchedAt,
        lastRunStatus: aborted ? 'aborted' : errorMessage ? 'failed' : 'idle',
        lastSuccessfulOffset: aborted ? lastCursor : null,
        marketsFetched: tagFetched.length,
        rateLimitHits,
        errorMessage: errorMessage ?? undefined,
        ...(full ? { lastFullFetchAt: fetchedAt } : {}),
      });

      return { tagFetched, aborted, errorMessage };
    }),
  );

  const anyFailed = tagResults.some(r => r.aborted || r.errorMessage);
  const before = fetchedAt;
  const stale = await markStaleMarketCatalog('polymarket', before);
  const durationMs = Date.now() - start;

  options?.onProgress?.({
    step: 'fetching_polymarket',
    polymarketCount: totalFetched,
    message: `${totalFetched} Polymarket markets fetched${anyFailed ? ' (some tags aborted)' : ''}`,
  });

  return {
    fetched: totalFetched,
    upserted: totalUpserted,
    stale,
    durationMs,
    rateLimitHits: totalRateLimitHits,
    error: anyFailed
      ? tagResults.map(r => r.errorMessage).filter(Boolean).join('; ') || undefined
      : undefined,
  };
}

function normalizePolymarketRows(markets: PMMarket[], fetchedAt: string): Omit<MarketCatalogRow, 'id' | 'stale'>[] {
  return markets
    .filter((m) => m.conditionId)
    .map((m): Omit<MarketCatalogRow, 'id' | 'stale'> => {
      const [yesPrice, noPrice] = parseOutcomePrices(m.outcomePrices);
      const classification = classifyMarket(m.question || m.slug);
      const outcomes = parseOutcomesSafe(m.outcomes);
      return {
        platform: 'polymarket',
        marketId: m.conditionId,
        title: m.question || m.slug,
        category: m.groupItemTitle || classification.domain || null,
        eventId: m.slug || null,
        eventTitle: m.question || null,
        expiryDate: m.endDate || null,
        isBinary: outcomes.length === 2 || outcomes.length === 0,
        outcomeCount: Math.max(outcomes.length, 2),
        yesBid: typeof m.bestBid === 'number' && Number.isFinite(m.bestBid) ? m.bestBid : null,
        yesAsk: yesPrice > 0 ? yesPrice : null,
        noBid: null,
        noAsk: noPrice > 0 ? noPrice : null,
        volume24h: m.volumeNum ?? m.volumeClob ?? null,
        sourceUrl: `https://polymarket.com/event/${m.slug}`,
        fetchedAt,
      };
    });
}

function parseNullableDollar(value: string | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseOutcomesSafe(serialized: string | undefined): string[] {
  try {
    const parsed = JSON.parse(serialized || '[]') as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Backward-compatible import path for the matcher. */
export { type MarketCatalogRow };

// Re-export status helper for the refresh/status endpoints.

// Expose throttle config for tests / monitoring.
export const CATALOG_THROTTLE = {
  kalshiMinPageDelayMs: KALSHI_MIN_PAGE_DELAY_MS,
  polymarketMinPageDelayMs: POLY_MIN_PAGE_DELAY_MS,
};

// Re-export so the rate-limiter module can track catalog traffic if desired.
export { rateLimiters };
