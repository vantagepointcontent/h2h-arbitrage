// Polymarket API Client — no auth needed for market data
// Base URL: https://gamma-api.polymarket.com

export interface PMMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  outcomes: string; // JSON string: ["Yes","No"]
  outcomePrices: string; // JSON string: ["0.58","0.42"]
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  groupItemTitle?: string;
  volume?: string;
  liquidity?: string;
  liquidityNum?: number;
  volumeNum?: number;
  volumeClob?: number;
  active: boolean;
  closed: boolean;
  endDate?: string; // ISO 8601, market close date
  neg_risk?: boolean; // true = independent binary outcomes (YES/NO don't sum to 1)
  negRisk?: boolean; // Gamma API field name
  clobTokenIds?: string; // Gamma JSON string, ordered like `outcomes`
  /** CLOB was reached but had no executable asks. Gamma values must not be used. */
  clobEmpty?: boolean;
  /** Dollar quantity at the live CLOB YES/NO best ask; zero means unknown or unavailable. */
  askDepth?: number;
  noAskDepth?: number;
  /** Exact token-book sell bids and share depth at those bids. */
  yesBid?: number;
  noBid?: number;
  yesBidDepth?: number;
  noBidDepth?: number;
  quoteObservedAt?: string;
  yesMinOrderSize?: number | null;
  noMinOrderSize?: number | null;
  yesTickSize?: number | null;
  noTickSize?: number | null;
  feesEnabled?: boolean;
  feeSchedule?: {
    rate: number;
    exponent: number;
    takerOnly: boolean;
    rebateRate: number;
  } | null;
}

export interface PMEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  active: boolean;
  closed: boolean;
  markets: PMMarket[];
  endDate?: string; // ISO 8601, event close date
}

export function extractPolymarketSlug(url: string): string | null {
  // Accept /event/{slug}, /sports/{category}/{slug}, and /market/{slug}
  const match = url.match(/polymarket\.com\/(?:event|(?:sports(?:\/[^/]+)+)|market)\/([^\/\s\?\#]+)/);
  return match ? match[1] : null;
}

export function isPolymarketMarketUrl(url: string): boolean {
  return /polymarket\.com\/market\//.test(url);
}

/** Extract a usable parent-event slug from Gamma's untyped expanded market payload. */
export function extractParentEventSlug(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length === 0) return undefined;
  const slug = events[0] && typeof events[0] === 'object'
    ? (events[0] as { slug?: unknown }).slug
    : undefined;
  return typeof slug === 'string' && slug.trim() !== '' ? slug : undefined;
}

import { finiteDecimal } from '@/lib/market-price';
import { rateLimiters } from '@/lib/rate-limiter';
import { createTtlMemo } from '@/lib/ttl-cache';

const gammaEventMemo = createTtlMemo<PMEvent | null>(10_000);

const DEBUG_H2H = process.env.DEBUG_H2H === '1' || process.env.DEBUG_H2H === 'true';

function debugLog(...args: unknown[]) {
  if (DEBUG_H2H) console.log(...args);
}

export async function fetchPolymarketEvent(slug: string): Promise<PMEvent | null> {
  return gammaEventMemo(`event:${slug}`, async () => {
  const res = await rateLimiters.gamma.execute(() =>
    fetch(
      `https://gamma-api.polymarket.com/events/slug/${slug}?_t=${Date.now()}`,
      {
        headers: { 'Accept': 'application/json', 'User-Agent': 'h2h-arbitrage/1.0' },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      },
    ),
  );
  if (!res.ok) throw new Error(`Polymarket API error: ${res.status}`);
  const data = await res.json();
  debugLog('[PM gamma] slug:', slug, 'markets:', (data.markets || []).map((m: PMMarket) => ({ q: m.question?.slice(0, 20), p: m.outcomePrices })));
  return data;
  });
}

/**
 * Fetch a single Polymarket market by its slug (from /market/ URLs).
 * If the market belongs to an event group, fetch ALL sibling markets from
 * the event so multi-outcome markets (e.g. House races) surface every outcome.
 * Falls back to wrapping just the single market if event lookup fails.
 */
export async function fetchPolymarketMarketAsEvent(slug: string): Promise<PMEvent | null> {
  return gammaEventMemo(`market:${slug}`, async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await rateLimiters.gamma.execute(() =>
      fetch(
        `https://gamma-api.polymarket.com/markets?slug=${slug}&_t=${Date.now()}`,
        {
          headers: { 'Accept': 'application/json', 'User-Agent': 'h2h-arbitrage/1.0' },
          cache: 'no-store',
          signal: controller.signal,
        },
      ),
    );
    if (!res.ok) throw new Error(`Polymarket markets API error: ${res.status}`);
    const markets = await res.json() as PMMarket[];
    if (!markets || markets.length === 0) return null;

    const m = markets[0];

    // Try to resolve the parent event to get all sibling markets.
    // The markets API includes an `events` array on each market when expanded.
    // We also try the `negRiskMarketID` as a fallback lookup.
    const eventSlug = extractParentEventSlug(m);

    if (eventSlug) {
      try {
        const eventRes = await rateLimiters.gamma.execute(() =>
          fetch(
            `https://gamma-api.polymarket.com/events/slug/${eventSlug}?_t=${Date.now()}`,
            {
              headers: { 'Accept': 'application/json', 'User-Agent': 'h2h-arbitrage/1.0' },
              cache: 'no-store',
              signal: controller.signal,
            },
          ),
        );
        if (eventRes.ok) {
          const event = await eventRes.json() as PMEvent;
          if (event && event.markets && event.markets.length > 1) {
            // Return the full event with all sibling markets
            return event;
          }
        }
      } catch {
        // Event lookup failed — fall back to single market wrap
      }
    }

    // Fallback: wrap single market in an event-like structure
    return {
      id: m.id,
      title: m.question,
      slug: m.slug,
      description: '',
      active: m.active,
      closed: m.closed,
      markets: markets,
      endDate: m.endDate,
    } as PMEvent;
  } finally {
    clearTimeout(timer);
  }
  });
}

/**
 * Parse Gamma's serialized binary prices without allowing malformed upstream
 * values to leak NaN into scan responses or stake calculations.
 */
export function parseOutcomePrices(serialized: string | undefined): [number, number] {
  try {
    const values: unknown = JSON.parse(serialized || '[]');
    if (!Array.isArray(values)) return [0, 1];

    const normalized = (value: unknown, fallback: number): number => {
      const parsed = finiteDecimal(value);
      return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : fallback;
    };

    return [normalized(values[0], 0), normalized(values[1], 1)];
  } catch {
    return [0, 1];
  }
}

export function parseOutcomes(market: PMMarket): { outcomes: string[]; prices: number[] } {
  try {
    const outcomes = JSON.parse(market.outcomes) as string[];
    return {
      outcomes,
      prices: parseOutcomePrices(market.outcomePrices),
    };
  } catch {
    return { outcomes: [], prices: [] };
  }
}

const gammaAllMemo = createTtlMemo<PMMarket[]>(30_000);

/**
 * Fetch all active (open) Polymarket markets via Gamma API.
 * Paginates through `/markets?limit=500&active=true&closed=false`.
 * Uses the existing gamma rate limiter. No PredictionHunt dependency.
 */
export async function fetchAllPolymarketMarkets(options?: {
  onPage?: (count: number) => void;
}): Promise<PMMarket[]> {
  return gammaAllMemo('all-active', async () => {
    const all: PMMarket[] = [];
    const seen = new Set<string>();
    const pageSize = 100; // Gamma currently caps this endpoint at 100 rows.
    const windowSize = 10;
    const maxPages = 100;

    const firstPage = await fetchPMPage(0, pageSize);
    if (!firstPage) return all;
    accumulate(firstPage);
    options?.onPage?.(all.length);
    if (firstPage.length < pageSize) return all;

    let nextPage = 1;
    while (nextPage < maxPages) {
      const offsets = Array.from(
        { length: Math.min(windowSize, maxPages - nextPage) },
        (_, index) => (nextPage + index) * pageSize,
      );
      const pages = await Promise.all(offsets.map((offset) => fetchPMPage(offset, pageSize)));
      let reachedEnd = false;
      for (const page of pages) {
        if (!page) continue;
        accumulate(page);
        options?.onPage?.(all.length);
        if (page.length < pageSize) reachedEnd = true;
      }
      nextPage += offsets.length;
      if (reachedEnd) break;
    }

    return all;

    function accumulate(markets: PMMarket[]) {
      for (const m of markets) {
        if (m.conditionId && !seen.has(m.conditionId)) {
          seen.add(m.conditionId);
          all.push(m);
        }
      }
    }
  });
}

async function fetchPMPage(offset: number, limit: number): Promise<PMMarket[] | null> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    active: 'true',
    closed: 'false',
  });
  params.set('_t', String(Date.now()));

  const res = await rateLimiters.gamma.execute(() =>
    fetch(
      `https://gamma-api.polymarket.com/markets?${params.toString()}`,
      {
        headers: { 'Accept': 'application/json', 'User-Agent': 'h2h-arbitrage/1.0' },
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      },
    ),
  );
  // Gamma returns 422 when an offset is past the final page.
  if (res.status === 422) return [];
  if (!res.ok) throw new Error(`Polymarket API error: ${res.status}`);
  const data: any = await res.json();
  return Array.isArray(data) ? data : (data.markets || []);
}