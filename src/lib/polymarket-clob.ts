// Polymarket CLOB API — live orderbook prices (best bid / ask / last trade)
// Base URL: https://clob.polymarket.com
// Needed because gamma-api caches outcomePrices aggressively

export interface ClobMarket {
  condition_id: string;
  best_bid?: number;
  best_ask?: number;
  last_trade_price?: number;
  tokens: { token_id: string; outcome: string; price?: number; winner?: boolean }[];
  question?: string;
  closed?: boolean;
  active?: boolean;
}

const CLOB_TIMEOUT = 8000;

export async function fetchClobMarket(conditionId: string): Promise<ClobMarket | null> {
  try {
    const res = await fetch(
      `https://clob.polymarket.com/markets/${conditionId}?_t=${Date.now()}`,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'h2h-arbitrage/1.0',
          'Accept-Encoding': 'gzip, deflate',
        },
        cache: 'no-store',
      }
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function fetchClobMarkets(conditionIds: string[]): Promise<Map<string, ClobMarket>> {
  const promises = conditionIds.map(async (cid) => {
    const market = await fetchClobMarket(cid);
    return { cid, market };
  });

  const results = await Promise.all(promises);
  const map = new Map<string, ClobMarket>();
  for (const { cid, market } of results) {
    if (market) map.set(cid, market);
  }
  return map;
}

/**
 * Get real-time YES/NO prices from CLOB.
 * Uses token prices if available, falls back to best_bid/best_ask/last_trade_price.
 */
export function getClobPrices(clob: ClobMarket): {
  yesPrice: number;
  noPrice: number;
  bestBid: number;
  bestAsk: number;
  lastTradePrice: number;
} | null {
  if (!clob) return null;
  const tokens = clob.tokens || [];

  // Token prices are the ground truth (CLOB mid/update price)
  const yesToken = tokens.find(t => t.outcome?.toLowerCase() === 'yes');
  const noToken = tokens.find(t => t.outcome?.toLowerCase() === 'no');

  let yesPrice = yesToken?.price ?? clob.best_ask;
  let noPrice = noToken?.price ?? clob.best_ask;

  // Fallback: derive noPrice from yesPrice if we only have one side
  if (yesPrice !== undefined && (noPrice === undefined || noPrice === null)) {
    noPrice = 1 - yesPrice;
  }
  if (noPrice !== undefined && (yesPrice === undefined || yesPrice === null)) {
    yesPrice = 1 - noPrice;
  }

  // Final fallback to cached gamma values if CLOB gave nothing useful
  yesPrice = yesPrice ?? 0;
  noPrice = noPrice ?? 0;

  if (yesPrice === 0 && noPrice === 0) return null;

  return {
    yesPrice,
    noPrice,
    bestBid: clob.best_bid ?? yesPrice,
    bestAsk: clob.best_ask ?? yesPrice,
    lastTradePrice: clob.last_trade_price ?? yesPrice,
  };
}
