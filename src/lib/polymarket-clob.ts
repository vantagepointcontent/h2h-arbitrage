// Polymarket CLOB API — live orderbook prices (best bid / ask / last trade)
// Base URL: https://clob.polymarket.com
// Needed because gamma-api caches outcomePrices aggressively

import { rateLimiters } from '@/lib/rate-limiter';
import { finiteDecimal } from '@/lib/market-price';

export interface ClobMarket {
  condition_id: string;
  best_bid?: number;
  best_ask?: number;
  last_trade_price?: number;
  tokens: { token_id: string; outcome: string; price?: number; winner?: boolean }[];
  question?: string;
  closed?: boolean;
  active?: boolean;
  neg_risk?: boolean;
}

export interface ClobBook {
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  min_order_size: string;
  tick_size: string;
  neg_risk?: boolean;
  last_trade_price?: string;
}

const CLOB_RETRIES = 2;
const CLOB_MAX_CONCURRENCY = 10;
// PERF-P2: 15s (was 2s). Poller tiers are ≥5min and UI auto-refresh is 60s,
// so a 15s orderbook cache is well within staleness tolerance for scanning.
// Live WS uses its own REST-seed + WS-delta path and is unaffected.
const CLOB_CACHE_TTL_MS = Number(process.env.H2H_CLOB_CACHE_TTL_MS || 15_000);
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
  // NOTE: single shared deadline across all retry attempts (not per-attempt) --
  // AbortController kept here deliberately since AbortSignal.timeout() would
  // reset per fetch() call inside the loop, changing retry timing semantics.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    for (let attempt = 0; attempt < CLOB_RETRIES; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
        const res = await rateLimiters.clobMarkets.execute(() =>
          fetch(
            `https://clob.polymarket.com/markets/${conditionId}?_t=${Date.now()}`,
            {
              headers: {
                'Accept': 'application/json',
                'User-Agent': 'h2h-arbitrage/1.0',
                'Accept-Encoding': 'gzip, deflate',
              },
              cache: 'no-store',
              signal: controller.signal,
            },
          ),
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
    clearTimeout(timer);
    clobSemaphore.release();
  }
}

// PERF-P2: short-lived cache for token orderbooks — auto-refresh + manual
// refresh hit the same books repeatedly, and each neg-risk market makes 2-4
// book calls. 15s TTL matches clobCache staleness tolerance.
const clobBookCache = new Map<string, { data: ClobBook | null; expires: number }>();

function getCachedBook(tokenId: string): ClobBook | null | undefined {
  const entry = clobBookCache.get(tokenId);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    clobBookCache.delete(tokenId);
    return undefined;
  }
  // undefined vs null: cache hit that resolved to empty book is stored as null
  return entry.data;
}

function setCachedBook(tokenId: string, data: ClobBook | null): void {
  clobBookCache.set(tokenId, { data, expires: Date.now() + CLOB_CACHE_TTL_MS });
  if (clobBookCache.size > 200) {
    const now = Date.now();
    for (const [key, entry] of clobBookCache.entries()) {
      if (now > entry.expires) clobBookCache.delete(key);
    }
  }
}

/**
 * Fetch orderbook for a specific token (used for neg-risk markets).
 */
export async function fetchClobBook(tokenId: string): Promise<ClobBook | null> {
  const cached = getCachedBook(tokenId);
  if (cached !== undefined) {
    debugLog('[CLOB] book cache hit', tokenId.slice(0, 12));
    return cached;
  }

  await clobSemaphore.acquire();
  try {
    const res = await rateLimiters.clobBook.execute(() =>
      fetch(
        `https://clob.polymarket.com/book?token_id=${tokenId}&_t=${Date.now()}`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'h2h-arbitrage/1.0',
            'Accept-Encoding': 'gzip, deflate',
          },
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        },
      ),
    );
    if (!res.ok) {
      setCachedBook(tokenId, null);
      return null;
    }
    const data = await res.json();
    setCachedBook(tokenId, data);
    return data;
  } catch {
    setCachedBook(tokenId, null);
    return null;
  } finally {
    clobSemaphore.release();
  }
}

/**
 * Dollar liquidity available at the best ask only. Depth at worse prices is
 * excluded: an executable arb must be fillable at the displayed quote.
 */
function bestAskDollarDepth(book: ClobBook | null): number {
  if (!book?.asks?.length) return 0;
  const validAsks = book.asks
    .map(({ price, size }) => ({ price: finiteDecimal(price), size: finiteDecimal(size) }))
    .filter((level): level is { price: number; size: number } =>
      level.price !== null && level.price > 0 && level.price < 1 &&
      level.size !== null && level.size > 0,
    );
  if (!validAsks.length) return 0;

  const bestAsk = Math.min(...validAsks.map(level => level.price));
  return validAsks
    .filter(level => level.price === bestAsk)
    .reduce((total, level) => total + level.price * level.size, 0);
}

/**
 * Fetch executable YES and NO depth from CLOB token books. Unknown, missing,
 * or empty books fail closed as zero; Gamma liquidity is not fillable depth.
 */
export async function getClobAskDepths(clob: ClobMarket): Promise<{ yesAskDepth: number; noAskDepth: number }> {
  const yesToken = clob.tokens?.find(token => token.outcome === 'Yes');
  const noToken = clob.tokens?.find(token => token.outcome === 'No');
  if (!yesToken || !noToken) return { yesAskDepth: 0, noAskDepth: 0 };

  const [yesBook, noBook] = await Promise.all([
    fetchClobBook(yesToken.token_id),
    fetchClobBook(noToken.token_id),
  ]);
  return {
    yesAskDepth: bestAskDollarDepth(yesBook),
    noAskDepth: bestAskDollarDepth(noBook),
  };
}

/**
 * Extract best ask/bid from token orderbook.
 * NOTE: CLOB orderbooks are NOT properly sorted — asks are descending (high→low)
 * and bids are ascending (low→high). We must find MIN(ask) and MAX(bid) manually.
 */
function getBestPriceFromBook(book: ClobBook | null): { bestBid: number; bestAsk: number } | null {
  if (!book) return null;

  // CLOB data is external input. parseFloat("0.25junk") would turn a malformed
  // level into a plausible executable quote, while Infinity would later clamp
  // to $1. Reject both rather than manufacturing a price.
  const parseQuotePrice = (value: unknown): number | null => {
    if (typeof value !== 'string' || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) return null;
    const price = Number(value);
    return Number.isFinite(price) && price > 0 && price <= 1 ? price : null;
  };
  
  // Find MIN ask (best price to BUY)
  let bestAsk: number | null = null;
  for (const ask of book.asks) {
    const price = parseQuotePrice(ask.price);
    if (price === null) continue;
    if (bestAsk === null || price < bestAsk) bestAsk = price;
  }
  
  // Find MAX bid (best price to SELL)
  let bestBid: number | null = null;
  for (const bid of book.bids) {
    const price = parseQuotePrice(bid.price);
    if (price === null) continue;
    if (bestBid === null || price > bestBid) bestBid = price;
  }
  
  if (bestBid === null && bestAsk === null) return null;
  return { bestBid: bestBid ?? 0, bestAsk: bestAsk ?? 0 };
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
 * ONLY uses live orderbook data (best_ask/best_bid). If no orderbook data exists,
 * returns null so callers can fallback to gamma-api prices.
 *
 * For standard binary Yes/No markets:
 *   - YES ask (buy price) = best_ask
 *   - NO ask (buy price) = 1 - best_bid
 *
 * For neg-risk markets (each outcome is independent Yes/No):
 *   Same logic! The CLOB market endpoint doesn't have best_bid/best_ask for neg-risk,
 *   but each outcome has its own token orderbook. The binary market "Yes/No" for
 *   "Will Giannis play for Memphis" has YES token and NO token. The tradeable prices:
 *   - YES buy = YES token ask
 *   - NO buy = 1 - YES token bid  (NOT NO token ask, which is typically illiquid)
 *
 * Returns null when CLOB has no orderbook.
 */
export async function getClobPrices(clob: ClobMarket): Promise<{
  yesPrice: number;
  noPrice: number;
  bestBid: number;
  bestAsk: number;
  lastTradePrice: number;
} | null> {
  if (!clob) return null;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  // The CLOB response is external input despite the TypeScript interface. Do
  // not turn NaN/Infinity/negative values into executable-looking quotes via
  // clamp; use token books as the authoritative fallback instead.
  const isExecutablePrice = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1;

  const isNegRisk = clob.neg_risk === true;

  // Standard binary market: use clob.best_bid / best_ask
  if (!isNegRisk) {
    const hasBid = isExecutablePrice(clob.best_bid);
    const hasAsk = isExecutablePrice(clob.best_ask);

    if (hasBid && hasAsk) {
      const yesPrice = clamp(clob.best_ask!);
      const noPrice = clamp(1 - clob.best_bid!);

      if (yesPrice === 0 && noPrice === 0) return null;

      return {
        yesPrice,
        noPrice,
        bestBid: clamp(clob.best_bid!),
        bestAsk: yesPrice,
        lastTradePrice: clob.last_trade_price ?? yesPrice,
      };
    }

    // Some active standard markets omit aggregate best_bid/best_ask even though
    // their individual YES and NO token books have live liquidity. Treating this
    // as an empty book suppresses every calculation and leaves the scan UI at 0.
    // Fall back to those authoritative token books before declaring the market
    // non-executable.
    const yesToken = clob.tokens?.find(t => t.outcome === 'Yes');
    const noToken = clob.tokens?.find(t => t.outcome === 'No');
    if (!yesToken || !noToken) return null;

    const [yesBook, noBook] = await Promise.all([
      fetchClobBook(yesToken.token_id),
      fetchClobBook(noToken.token_id),
    ]);
    const yesPrices = getBestPriceFromBook(yesBook);
    const noPrices = getBestPriceFromBook(noBook);
    if (!yesPrices) return null;

    const yesPrice = clamp(yesPrices.bestAsk);
    const noPrice = noPrices?.bestAsk && noPrices.bestAsk > 0
      ? clamp(noPrices.bestAsk)
      : yesPrices.bestBid > 0
        ? clamp(1 - yesPrices.bestBid)
        : 0;
    if (yesPrice === 0 && noPrice === 0) return null;

    return {
      yesPrice,
      noPrice,
      bestBid: clamp(yesPrices.bestBid),
      bestAsk: yesPrice,
      lastTradePrice: clob.last_trade_price ?? yesPrice,
    };
  }

  // Neg-risk market: fetch YES token (for YES price) and NO token (for NO price)
  const yesToken = clob.tokens?.find(t => t.outcome === 'Yes');
  const noToken = clob.tokens?.find(t => t.outcome === 'No');

  if (!yesToken || !noToken) {
    debugLog('[CLOB] neg-risk: missing Yes/No tokens');
    return null;
  }

  const [yesBook, noBook] = await Promise.all([
    fetchClobBook(yesToken.token_id),
    fetchClobBook(noToken.token_id),
  ]);

  const yesPrices = getBestPriceFromBook(yesBook);
  const noPrices = getBestPriceFromBook(noBook);
  
  debugLog('[CLOB] neg-risk prices:', {
    conditionId: clob.condition_id,
    yesToken: yesToken.token_id.slice(0, 10),
    noToken: noToken.token_id.slice(0, 10),
    yesBook: yesPrices,
    noBook: noPrices,
  });

  if (!yesPrices || !noPrices) {
    debugLog('[CLOB] neg-risk: missing orderbooks');
    return null;
  }

  // TypeScript: after the guard above, yesPrices/noPrices are guaranteed non-null
  const y = yesPrices!;
  const n = noPrices!;

  // For neg-risk markets:
  // - YES price = YES token bestAsk (price to buy YES)
  // - NO price = NO token bestAsk (price to buy NO) if available
  //   Otherwise derive from YES token: 1 - YES token bestBid
  //   Otherwise use NO token midpoint from CLOB markets endpoint
  // These are INDEPENDENT and can sum to >1 (that's the point of neg-risk)
  const yesPrice = clamp(y.bestAsk);
  
  // NO price: priority order - NO token bestAsk -> 1 - YES token bestBid -> NO token midpoint
  let noPrice: number;
  if (n.bestAsk != null && n.bestAsk > 0) {
    noPrice = clamp(n.bestAsk);
  } else if (y.bestBid != null && y.bestBid > 0) {
    noPrice = clamp(1 - y.bestBid);
  } else if (noToken.price != null && noToken.price > 0) {
    noPrice = clamp(noToken.price);
  } else {
    noPrice = 0;
  }

  if (yesPrice === 0 && noPrice === 0) return null;

  // Use YES token bid as reference bestBid (price to sell YES = buy NO via YES token)
  const bestBid = clamp(y.bestBid);

  return {
    yesPrice,
    noPrice,
    bestBid,
    bestAsk: yesPrice,
    lastTradePrice: clob.last_trade_price ?? yesPrice,
  };
}
