/**
 * Market Catalog (FEAT-101): refresh + normalize all open markets from
 * Kalshi and Polymarket into SQLite. No PredictionHunt dependency.
 *
 * The catalog is refreshed periodically by the poller's scheduler loop and
 * exposed via /api/catalog for the matcher/frontend to query.
 */

import { fetchAllKalshiMarkets, type KalshiMarket } from '@/lib/kalshi';
import { fetchAllPolymarketMarkets, parseOutcomePrices, type PMMarket } from '@/lib/polymarket';
import { bulkUpsertMarketCatalog, markStaleMarketCatalog, type MarketCatalogRow } from '@/lib/persistence';
import { classifyMarket } from '@/lib/market-classification';

/** Result of a single catalog refresh run. */
export interface CatalogRefreshResult {
  kalshi: { fetched: number; upserted: number; stale: number; durationMs: number; error?: string };
  polymarket: { fetched: number; upserted: number; stale: number; durationMs: number; error?: string };
  startedAt: string;
  finishedAt: string;
}

export interface RefreshOptions {
  runId?: string;
  onProgress?: (update: {
    step?: 'fetching_kalshi' | 'fetching_polymarket';
    kalshiCount?: number;
    polymarketCount?: number;
    message?: string;
  }) => void;
}

let refreshInProgress = false;

/** Refresh the entire market catalog from both platforms.
 *  Idempotent / serialized — concurrent calls return the same promise. */
export async function refreshMarketCatalog(options?: RefreshOptions): Promise<CatalogRefreshResult> {
  if (refreshInProgress) {
    // Serialize concurrent refresh attempts. The poller and manual API calls
    // shouldn't stampede the upstream APIs or SQLite writer.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return refreshMarketCatalog();
  }
  refreshInProgress = true;

  const startedAt = new Date().toISOString();
  const result: CatalogRefreshResult = {
    kalshi: { fetched: 0, upserted: 0, stale: 0, durationMs: 0 },
    polymarket: { fetched: 0, upserted: 0, stale: 0, durationMs: 0 },
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

async function refreshKalshi(options?: RefreshOptions): Promise<CatalogRefreshResult['kalshi']> {
  const start = Date.now();
  options?.onProgress?.({ step: 'fetching_kalshi', message: 'Fetching Kalshi markets...' });
  const fetched = await fetchAllKalshiMarkets({
    onPage: (count) => options?.onProgress?.({ step: 'fetching_kalshi', kalshiCount: count }),
  });
  options?.onProgress?.({ step: 'fetching_kalshi', kalshiCount: fetched.length, message: `${fetched.length} Kalshi markets fetched` });
  const fetchedAt = new Date().toISOString();
  const durationMs = Date.now() - start;

  const rows = fetched
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

  const before = fetchedAt;
  const upserted = await bulkUpsertMarketCatalog(rows);
  const stale = await markStaleMarketCatalog('kalshi', before);
  return { fetched: fetched.length, upserted, stale, durationMs };
}

async function refreshPolymarket(options?: RefreshOptions): Promise<CatalogRefreshResult['polymarket']> {
  const start = Date.now();
  options?.onProgress?.({ step: 'fetching_polymarket', message: 'Fetching Polymarket markets...' });
  const fetched = await fetchAllPolymarketMarkets({
    onPage: (count) => options?.onProgress?.({ step: 'fetching_polymarket', polymarketCount: count }),
  });
  options?.onProgress?.({ step: 'fetching_polymarket', polymarketCount: fetched.length, message: `${fetched.length} Polymarket markets fetched` });
  const fetchedAt = new Date().toISOString();
  const durationMs = Date.now() - start;

  const rows = fetched
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

  const before = fetchedAt;
  const upserted = await bulkUpsertMarketCatalog(rows);
  const stale = await markStaleMarketCatalog('polymarket', before);
  return { fetched: fetched.length, upserted, stale, durationMs };
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
