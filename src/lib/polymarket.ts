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
  // Accept both /event/{slug} and /sports/{category}/{slug}
  const match = url.match(/polymarket\.com\/(?:event|(?:sports(?:\/[^/]+)+))\/([^\/\s\?\#]+)/);
  return match ? match[1] : null;
}

import { rateLimiters } from '@/lib/rate-limiter';

const DEBUG_H2H = process.env.DEBUG_H2H === '1' || process.env.DEBUG_H2H === 'true';

function debugLog(...args: unknown[]) {
  if (DEBUG_H2H) console.log(...args);
}

export async function fetchPolymarketEvent(slug: string): Promise<PMEvent | null> {
  const res = await rateLimiters.gamma.execute(() =>
    fetch(
      `https://gamma-api.polymarket.com/events/slug/${slug}?_t=${Date.now()}`,
      {
        headers: { 'Accept': 'application/json', 'User-Agent': 'h2h-arbitrage/1.0' },
        cache: 'no-store',
      },
    ),
  );
  if (!res.ok) throw new Error(`Polymarket API error: ${res.status}`);
  const data = await res.json();
  debugLog('[PM gamma] slug:', slug, 'markets:', (data.markets || []).map((m: PMMarket) => ({ q: m.question?.slice(0, 20), p: m.outcomePrices })));
  return data;
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
