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

import { rateLimiters } from '@/lib/rate-limiter';

const DEBUG_H2H = process.env.DEBUG_H2H === '1' || process.env.DEBUG_H2H === 'true';

function debugLog(...args: unknown[]) {
  if (DEBUG_H2H) console.log(...args);
}

export async function fetchPolymarketEvent(slug: string): Promise<PMEvent | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await rateLimiters.gamma.execute(() =>
      fetch(
        `https://gamma-api.polymarket.com/events/slug/${slug}?_t=${Date.now()}`,
        {
          headers: { 'Accept': 'application/json', 'User-Agent': 'h2h-arbitrage/1.0' },
          cache: 'no-store',
          signal: controller.signal,
        },
      ),
    );
    if (!res.ok) throw new Error(`Polymarket API error: ${res.status}`);
    const data = await res.json();
    debugLog('[PM gamma] slug:', slug, 'markets:', (data.markets || []).map((m: PMMarket) => ({ q: m.question?.slice(0, 20), p: m.outcomePrices })));
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a single Polymarket market by its slug (from /market/ URLs).
 * Wraps it in a PMEvent-like structure so downstream code works unchanged.
 */
export async function fetchPolymarketMarketAsEvent(slug: string): Promise<PMEvent | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
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
    // Wrap single market in an event-like structure
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
}

export function parseOutcomes(market: PMMarket): { outcomes: string[]; prices: number[] } {
  try {
    const outcomes = JSON.parse(market.outcomes) as string[];
    const prices = JSON.parse(market.outcomePrices) as string[];
    return {
      outcomes,
      prices: prices.map(p => parseFloat(p)),
    };
  } catch {
    return { outcomes: [], prices: [] };
  }
}