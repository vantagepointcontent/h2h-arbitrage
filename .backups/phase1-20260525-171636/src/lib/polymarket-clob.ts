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

const CLOB_RETRIES = 2;

export async function fetchClobMarket(conditionId: string): Promise<ClobMarket | null> {
  let lastErr: any;
  for (let attempt = 0; attempt < CLOB_RETRIES; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
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
      if (!res.ok) {
        console.log('[CLOB] HTTP', res.status, 'for', conditionId.slice(0, 12), 'attempt', attempt + 1);
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      console.log('[CLOB] success', conditionId.slice(0, 12), 'tokens:', (data.tokens || []).map((t: any) => `${t.outcome}=${(t.price * 100).toFixed(1)}¢`).join(', '));
      return data;
    } catch (err: any) {
      lastErr = err;
      console.log('[CLOB] error', conditionId.slice(0, 12), 'attempt', attempt + 1, err.message || err);
    }
  }
  console.log('[CLOB] giving up on', conditionId.slice(0, 12));
  return null;
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
  const yesToken = tokens.find(t => /yes/i.test(t.outcome || ''));
  const noToken = tokens.find(t => /no/i.test(t.outcome || ''));
  let yesPrice = yesToken?.price;
  let noPrice = noToken?.price;

  // If we have one side, derive the other (prices must sum to 1 in binary)
  if (yesPrice !== undefined && yesPrice !== null && (noPrice === undefined || noPrice === null)) {
    noPrice = Math.max(0, Math.min(1, 1 - yesPrice));
  }
  if (noPrice !== undefined && noPrice !== null && (yesPrice === undefined || yesPrice === null)) {
    yesPrice = Math.max(0, Math.min(1, 1 - noPrice));
  }

  // Fallback: use CLOB orderbook if token prices missing
  yesPrice = yesPrice ?? clob.best_ask ?? clob.best_bid;
  noPrice = noPrice ?? clob.best_bid ?? clob.best_ask;

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
