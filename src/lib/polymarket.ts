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
}

export interface PMEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  active: boolean;
  closed: boolean;
  markets: PMMarket[];
}

export function extractPolymarketSlug(url: string): string | null {
  // Accept both /event/{slug} and /sports/{category}/{slug}
  const match = url.match(/polymarket\.com\/(?:event|(?:sports(?:\/[^/]+)+))\/([^\/\s\?\#]+)/);
  return match ? match[1] : null;
}

export async function fetchPolymarketEvent(slug: string): Promise<PMEvent | null> {
  const res = await fetch(
    `https://gamma-api.polymarket.com/events/slug/${slug}`,
    { headers: { 'Accept': 'application/json', 'User-Agent': 'h2h-arbitrage/1.0' }, cache: 'no-store' }
  );
  if (!res.ok) throw new Error(`Polymarket API error: ${res.status}`);
  return res.json();
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
