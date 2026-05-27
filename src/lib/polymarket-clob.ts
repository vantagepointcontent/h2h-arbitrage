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
const CLOB_MAX_CONCURRENCY = 10;
const CLOB_CACHE_TTL_MS = 2000;
const DEBUG_H2H = process.env.DEBUG_H2H === '1' || process.env.DEBUG_H2H === 'true';

function debugLog(...args: unknown[]) {
  if (DEBUG_H2H) console.log(...args);
}

// Global concurrency limiter for CLOB requests
class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

const clobSemaphore = new Semaphore(CLOB_MAX_CONCURRENCY);

// Short-lived cache for CLOB prices (prevents duplicate requests during polling burst)
const clobCache = new Map<string, { data: ClobMarket; expires: number }>();

function getCached(conditionId: string): ClobMarket | null {
  const entry = clobCache.get(conditionId);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    clobCache.delete(conditionId);
    return null;
  }
  return entry.data;
}

function setCached(conditionId: string, data: ClobMarket): void {
  clobCache.set(conditionId, {
    data,
    expires: Date.now() + CLOB_CACHE_TTL_MS,
  });
  // Clean up expired entries periodically
  if (clobCache.size > 100) {
    const now = Date.now();
    for (const [key, entry] of clobCache.entries()) {
      if (now > entry.expires) clobCache.delete(key);
    }
  }
}

export async function fetchClobMarket(conditionId: string): Promise<ClobMarket | null> {
  // Check cache first
  const cached = getCached(conditionId);
  if (cached) {
    debugLog('[CLOB] cache hit', conditionId.slice(0, 12));
    return cached;
  }

  // Acquire semaphore to limit concurrent requests
  await clobSemaphore.acquire();
  try {
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
          debugLog('[CLOB] HTTP', res.status, 'for', conditionId.slice(0, 12), 'attempt', attempt + 1);
          continue;
        }
        const data = await res.json();
        debugLog('[CLOB] success', conditionId.slice(0, 12), 'tokens:', (data.tokens || []).map((t: { outcome?: string; price?: number }) => `${t.outcome}=${(((t.price ?? 0) * 100)).toFixed(1)}¢`).join(', '));
        setCached(conditionId, data);
        return data;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog('[CLOB] error', conditionId.slice(0, 12), 'attempt', attempt + 1, msg);
      }
    }
    debugLog('[CLOB] giving up on', conditionId.slice(0, 12));
    return null;
  } finally {
    clobSemaphore.release();
  }
}

export async function fetchClobMarkets(conditionIds: string[]): Promise<Map<string, ClobMarket>> {
  // Deduplicate conditionIds and filter out already-cached ones
  const uniqueIds = [...new Set(conditionIds)];
  const uncached = uniqueIds.filter(cid => !getCached(cid));
  debugLog('[CLOB] fetchClobMarkets total:', uniqueIds.length, 'uncached:', uncached.length);

  const promises = uncached.map(async (cid) => {
    const market = await fetchClobMarket(cid);
    return { cid, market };
  });

  await Promise.all(promises);

  // Build result map from all unique IDs (cached + newly fetched)
  const map = new Map<string, ClobMarket>();
  for (const cid of uniqueIds) {
    const market = getCached(cid);
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
  const clamp = (v: number) => Math.max(0, Math.min(1, v));

  const yesToken = tokens.find(t => /^yes$/i.test(t.outcome || ''));
  const noToken = tokens.find(t => /^no$/i.test(t.outcome || ''));
  let yesPrice = yesToken?.price;
  let noPrice = noToken?.price;

  // If token data is partial, binary parity is safer than crossing market-level sides.
  if (yesPrice !== undefined && yesPrice !== null && (noPrice === undefined || noPrice === null)) {
    noPrice = clamp(1 - yesPrice);
  }
  if (noPrice !== undefined && noPrice !== null && (yesPrice === undefined || yesPrice === null)) {
    yesPrice = clamp(1 - noPrice);
  }

  // If token data is absent, treat market-level best_ask/best_bid as YES-side book:
  // buy YES at yesAsk; buy NO at 1 - yesBid. This preserves binary parity.
  if ((yesPrice === undefined || yesPrice === null) && clob.best_ask !== undefined) {
    yesPrice = clob.best_ask;
  }
  if ((noPrice === undefined || noPrice === null) && clob.best_bid !== undefined) {
    noPrice = clamp(1 - clob.best_bid);
  }

  yesPrice = yesPrice ?? 0;
  noPrice = noPrice ?? 0;

  if (yesPrice === 0 && noPrice === 0) return null;

  // Enforce YES/NO parity for binary markets. Avoid impossible prices from mixed token/book fallbacks.
  if (yesPrice > 0 && noPrice > 0 && Math.abs((yesPrice + noPrice) - 1) > 0.02) {
    noPrice = clamp(1 - yesPrice);
  }

  return {
    yesPrice,
    noPrice,
    bestBid: clob.best_bid ?? clamp(1 - noPrice),
    bestAsk: clob.best_ask ?? yesPrice,
    lastTradePrice: clob.last_trade_price ?? yesPrice,
  };
}
