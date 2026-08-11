import { fetchKalshiMarket } from './kalshi';
import { fetchClobMarket, getClobPrices } from './polymarket-clob';
import type { QuoteOutcome, QuotePlatform } from './log-price-comparison';

export type CurrentQuoteStatus = 'available' | 'unavailable' | 'closed' | 'resolved' | 'error';

export interface CurrentQuoteRequest {
  platform: QuotePlatform;
  marketId: string;
  outcome: QuoteOutcome;
}

export interface CurrentLegQuote extends CurrentQuoteRequest {
  status: CurrentQuoteStatus;
  priceNow: number | null;
  source: 'Executable best ask';
  quotedAt: string;
  stale: boolean;
}

const FRESH_TTL_MS = 20_000;
const STALE_FALLBACK_MS = 120_000;
const MAX_CACHE_ENTRIES = 256;

interface CacheEntry {
  quote: CurrentLegQuote;
  fetchedAt: number;
  availableAt: number | null;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CurrentLegQuote>>();
const pairInFlight = new Map<string, Promise<CurrentLegQuote[]>>();

function keyOf(leg: CurrentQuoteRequest): string {
  return JSON.stringify([leg.platform, leg.marketId, leg.outcome]);
}

function pairKeyOf(legs: CurrentQuoteRequest[]): string {
  return JSON.stringify(legs.map((leg) => [leg.platform, leg.marketId, leg.outcome]));
}

function pruneExpired(now: number): void {
  for (const [key, entry] of cache) {
    const retentionAge = entry.availableAt == null
      ? now - entry.fetchedAt
      : now - entry.availableAt;
    const retentionMs = entry.availableAt == null ? FRESH_TTL_MS : STALE_FALLBACK_MS;
    if (retentionAge > retentionMs) cache.delete(key);
  }
}

function touch(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
}

function store(key: string, entry: CacheEntry): void {
  touch(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function executableDecimal(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : null;
}

function quote(leg: CurrentQuoteRequest, status: CurrentQuoteStatus, priceNow: number | null): CurrentLegQuote {
  return {
    ...leg,
    status,
    priceNow,
    source: 'Executable best ask',
    quotedAt: new Date().toISOString(),
    stale: false,
  };
}

async function fetchUncached(leg: CurrentQuoteRequest): Promise<CurrentLegQuote> {
  try {
    if (leg.platform === 'kalshi') {
      const market = await fetchKalshiMarket(leg.marketId);
      if (!market) return quote(leg, 'unavailable', null);
      const status = String(market.status ?? '').toLowerCase();
      if (status === 'settled' || status === 'resolved' || status === 'finalized') return quote(leg, 'resolved', null);
      if (status === 'closed' || status === 'inactive') return quote(leg, 'closed', null);
      const priceNow = executableDecimal(leg.outcome === 'yes' ? market.yes_ask_dollars : market.no_ask_dollars);
      return quote(leg, priceNow == null ? 'unavailable' : 'available', priceNow);
    }

    const market = await fetchClobMarket(leg.marketId);
    if (!market) return quote(leg, 'unavailable', null);
    if (market.closed === true || market.active === false) {
      const winner = market.tokens?.find((token) => token.winner === true)?.outcome?.toLowerCase();
      return quote(leg, winner ? 'resolved' : 'closed', null);
    }
    const prices = await getClobPrices(market);
    if (!prices) return quote(leg, 'unavailable', null);
    const priceNow = leg.outcome === 'yes' ? prices.yesPrice : prices.noPrice;
    const validPrice = typeof priceNow === 'number' && Number.isFinite(priceNow) && priceNow > 0 && priceNow <= 1
      ? priceNow
      : null;
    return quote(leg, validPrice == null ? 'unavailable' : 'available', validPrice);
  } catch {
    return quote(leg, 'error', null);
  }
}

async function fetchOne(leg: CurrentQuoteRequest): Promise<CurrentLegQuote> {
  const key = keyOf(leg);
  const now = Date.now();
  pruneExpired(now);
  const cached = cache.get(key);
  const staleStillUsable = cached?.availableAt != null && now - cached.availableAt <= STALE_FALLBACK_MS;
  if (cached && now - cached.fetchedAt <= FRESH_TTL_MS && (!cached.quote.stale || staleStillUsable)) {
    touch(key, cached);
    return cached.quote;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = fetchUncached(leg).then((fresh) => {
    const completedAt = Date.now();
    const old = cache.get(key) ?? cached;
    if (fresh.status !== 'available'
      && old?.quote.status === 'available'
      && old.availableAt != null
      && completedAt - old.availableAt <= STALE_FALLBACK_MS) {
      const stale = { ...old.quote, stale: true };
      store(key, { quote: stale, fetchedAt: completedAt, availableAt: old.availableAt });
      return stale;
    }
    store(key, {
      quote: fresh,
      fetchedAt: completedAt,
      availableAt: fresh.status === 'available' ? completedAt : null,
    });
    return fresh;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/** Fetch only the exact platform market/outcome identities supplied by a historical scan. */
export async function fetchCurrentLegQuotes(legs: CurrentQuoteRequest[]): Promise<CurrentLegQuote[]> {
  const pairKey = pairKeyOf(legs);
  const pending = pairInFlight.get(pairKey);
  if (pending) return pending;

  const request = Promise.all(legs.map(fetchOne)).finally(() => pairInFlight.delete(pairKey));
  pairInFlight.set(pairKey, request);
  return request;
}

export function resetCurrentQuoteStateForTests(): void {
  cache.clear();
  inFlight.clear();
  pairInFlight.clear();
}

export function getCurrentQuoteCacheSizeForTests(): number {
  return cache.size;
}
