// Polymarket CLOB API — live orderbook prices (best bid / ask / last trade)
// Base URL: https://clob.polymarket.com
// Needed because gamma-api caches outcomePrices aggressively

import { rateLimiters } from '@/lib/rate-limiter';
import { finiteDecimal } from '@/lib/market-price';
import { normalizePolymarketResolution } from './settlement-resolution';
import { isPriceAlignedToTick } from './venue-constraints';
import { correlationId } from './correlation';

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
  asset_id?: string;
  /** CLOB snapshot time: 13-digit Unix epoch milliseconds encoded as a decimal string. */
  timestamp?: string;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  min_order_size: string;
  tick_size: string;
  neg_risk?: boolean;
  last_trade_price?: string;
}

export type ClobBookFetchStatus = 'success' | 'timeout' | 'error' | 'unavailable';

export interface ClobBookFetchDiagnostic {
  tokenId: string;
  status: ClobBookFetchStatus;
  attemptCount: number;
  queueWaitMs: number;
  upstreamLatencyMs: number;
  totalLatencyMs: number;
  deadlineSource: 'per-token' | 'refresh-budget' | 'none';
  upstreamStatus?: number;
  reason?: string;
  observedAt?: string;
}

export interface ClobBooksDetailedResult {
  books: Map<string, ClobBook | null>;
  diagnostics: Map<string, ClobBookFetchDiagnostic>;
  metrics: {
    tokenCount: number;
    successCount: number;
    timeoutCount: number;
    errorCount: number;
    unavailableCount: number;
    retryCount: number;
    queueWaitMs: number;
    upstreamLatencyMs: number;
    durationMs: number;
  };
}

const CLOB_RETRIES = 2;
const CLOB_MAX_CONCURRENCY = 10;
/** Server-owned live-placement freshness bounds; request data cannot weaken them. */
export const CLOB_LIVE_BOOK_MAX_AGE_MS = 10_000;
export const CLOB_LIVE_BOOK_MAX_FUTURE_SKEW_MS = 1_000;
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

export async function fetchClobMarket(
  conditionId: string,
  options?: { bypassCache?: boolean },
): Promise<ClobMarket | null> {
  if (!options?.bypassCache) {
    const cached = getCached(conditionId);
    if (cached) {
      debugLog('[CLOB] cache hit', conditionId.slice(0, 12));
      return cached;
    }
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
export async function fetchClobBook(
  tokenId: string,
  options?: { bypassCache?: boolean },
): Promise<ClobBook | null> {
  if (!options?.bypassCache) {
    const cached = getCachedBook(tokenId);
    if (cached !== undefined) {
      debugLog('[CLOB] book cache hit', tokenId.slice(0, 12));
      return cached;
    }
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

function exactClobBook(value: unknown, tokenId: string): ClobBook | null {
  if (!value || typeof value !== 'object') return null;
  const book = value as ClobBook;
  const levelsAreValid = (levels: unknown): levels is ClobBook['bids'] =>
    Array.isArray(levels) && levels.every((level) => level != null && typeof level === 'object'
      && typeof (level as { price?: unknown }).price === 'string'
      && typeof (level as { size?: unknown }).size === 'string');
  return book.asset_id === tokenId && levelsAreValid(book.bids) && levelsAreValid(book.asks) ? book : null;
}

/** Fetch exact token books independently so one slow book cannot suppress siblings. */
export async function fetchClobBooksDetailed(
  tokenIds: string[],
  options?: {
    bypassCache?: boolean;
    concurrency?: number;
    maxAttempts?: number;
    requestTimeoutMs?: number;
    retryBackoffMs?: number;
    totalDeadlineMs?: number;
  },
): Promise<ClobBooksDetailedResult> {
  const uniqueIds = [...new Set(tokenIds.filter((tokenId) => tokenId.trim() !== ''))];
  const books = new Map<string, ClobBook | null>();
  const diagnostics = new Map<string, ClobBookFetchDiagnostic>();
  const startedAt = performance.now();
  const enqueuedAt = new Map(uniqueIds.map((tokenId) => [tokenId, performance.now()]));
  const concurrency = Math.max(1, Math.min(10, Math.floor(options?.concurrency ?? 4)));
  const maxAttempts = Math.max(1, Math.min(3, Math.floor(options?.maxAttempts ?? 2)));
  const requestTimeoutMs = Math.max(100, Math.min(10_000, Math.floor(options?.requestTimeoutMs ?? 3_500)));
  const retryBackoffMs = Math.max(0, Math.min(2_000, Math.floor(options?.retryBackoffMs ?? 250)));
  const totalDeadlineMs = Math.max(requestTimeoutMs, Math.min(30_000, Math.floor(options?.totalDeadlineMs ?? 12_000)));
  const deadlineAt = startedAt + totalDeadlineMs;
  let cursor = 0;

  const fetchOne = async (tokenId: string): Promise<void> => {
    const tokenStartedAt = performance.now();
    let queueWaitMs = Math.max(0, Math.round(tokenStartedAt - (enqueuedAt.get(tokenId) ?? tokenStartedAt)));
    if (!options?.bypassCache) {
      const cached = getCachedBook(tokenId);
      if (cached !== undefined) {
        books.set(tokenId, cached);
        diagnostics.set(tokenId, {
          tokenId, status: cached ? 'success' : 'unavailable', attemptCount: 0,
          queueWaitMs, upstreamLatencyMs: 0, totalLatencyMs: 0, deadlineSource: 'none',
          ...(cached ? { observedAt: new Date().toISOString() } : { reason: 'cached unavailable book' }),
        });
        return;
      }
    }

    let upstreamLatencyMs = 0;
    let lastStatus: number | undefined;
    let lastReason = 'Polymarket order book unavailable';
    let finalStatus: ClobBookFetchStatus = 'error';
    let deadlineSource: ClobBookFetchDiagnostic['deadlineSource'] = 'none';
    let attemptCount = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const backoffMs = attempt > 1 ? retryBackoffMs * (attempt - 1) : 0;
      if (deadlineAt - performance.now() <= backoffMs) {
        finalStatus = 'timeout';
        deadlineSource = 'refresh-budget';
        lastReason = `refresh budget ${totalDeadlineMs}ms exhausted`;
        break;
      }
      if (backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
      const semaphoreWaitStartedAt = performance.now();
      await clobSemaphore.acquire();
      queueWaitMs += Math.max(0, Math.round(performance.now() - semaphoreWaitStartedAt));
      const remainingMs = deadlineAt - performance.now();
      if (remainingMs <= 0) {
        clobSemaphore.release();
        finalStatus = 'timeout';
        deadlineSource = 'refresh-budget';
        lastReason = `refresh budget ${totalDeadlineMs}ms exhausted`;
        break;
      }
      attemptCount = attempt;
      const attemptStartedAt = performance.now();
      let successfulBook: ClobBook | null = null;
      try {
        const timeoutMs = Math.max(1, Math.min(requestTimeoutMs, Math.floor(remainingMs)));
        // This path owns its exact-token retry accounting. Do not wrap it in
        // the generic rate limiter, whose internal retries would be invisible
        // to per-token attempt metrics and could duplicate successful work.
        const response = await fetch(
          `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}&_t=${Date.now()}`,
          {
            headers: { 'Accept': 'application/json', 'User-Agent': 'h2h-arbitrage/1.0', 'Accept-Encoding': 'gzip, deflate' },
            cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
          },
        );
        lastStatus = response.status;
        if (response.ok) {
          successfulBook = exactClobBook(await response.json(), tokenId);
          if (!successfulBook) {
            finalStatus = 'unavailable';
            lastReason = 'empty, malformed, or mismatched token book';
          }
        } else {
          lastReason = `HTTP ${response.status}`;
          finalStatus = response.status === 404 ? 'unavailable' : 'error';
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error ? error.name : '';
        const timedOut = name === 'AbortError' || name === 'TimeoutError' || /timed out|timeout/i.test(message);
        finalStatus = timedOut ? 'timeout' : 'error';
        deadlineSource = timedOut ? 'per-token' : 'none';
        lastReason = message || (timedOut ? 'request timed out' : 'request failed');
      } finally {
        upstreamLatencyMs += Math.max(0, Math.round(performance.now() - attemptStartedAt));
        clobSemaphore.release();
      }
      if (successfulBook) {
        books.set(tokenId, successfulBook);
        setCachedBook(tokenId, successfulBook);
        diagnostics.set(tokenId, {
          tokenId, status: 'success', attemptCount, queueWaitMs, upstreamLatencyMs,
          totalLatencyMs: Math.max(0, Math.round(performance.now() - tokenStartedAt)),
          deadlineSource: 'per-token', upstreamStatus: lastStatus, observedAt: new Date().toISOString(),
        });
        return;
      }
      const retryable = finalStatus === 'timeout' || lastStatus === 429 || (lastStatus != null && lastStatus >= 500);
      if (!retryable) break;
    }
    books.set(tokenId, null);
    diagnostics.set(tokenId, {
      tokenId, status: finalStatus, attemptCount, queueWaitMs, upstreamLatencyMs,
      totalLatencyMs: Math.max(0, Math.round(performance.now() - tokenStartedAt)), deadlineSource,
      ...(lastStatus != null ? { upstreamStatus: lastStatus } : {}), reason: lastReason,
    });
  };

  const worker = async () => {
    while (cursor < uniqueIds.length) await fetchOne(uniqueIds[cursor++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueIds.length) }, () => worker()));
  const values = [...diagnostics.values()];
  const metrics = {
    tokenCount: uniqueIds.length,
    successCount: values.filter((value) => value.status === 'success').length,
    timeoutCount: values.filter((value) => value.status === 'timeout').length,
    errorCount: values.filter((value) => value.status === 'error').length,
    unavailableCount: values.filter((value) => value.status === 'unavailable').length,
    retryCount: values.reduce((sum, value) => sum + Math.max(0, value.attemptCount - 1), 0),
    queueWaitMs: values.reduce((sum, value) => sum + value.queueWaitMs, 0),
    upstreamLatencyMs: values.reduce((sum, value) => sum + value.upstreamLatencyMs, 0),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
  console.info(JSON.stringify({
    event: 'polymarket_clob_token_refresh', correlationId: correlationId.current ?? null, metrics, tokens: values,
  }));
  return { books, diagnostics, metrics };
}

/**
 * Fetch multiple token orderbooks with one CLOB request. Cached books are
 * reused and only missing token IDs are sent to the batch endpoint.
 */
export async function fetchClobBooks(
  tokenIds: string[],
  options?: { throwOnFailure?: boolean; bypassCache?: boolean },
): Promise<Map<string, ClobBook | null>> {
  const uniqueIds = [...new Set(tokenIds.filter(Boolean))];
  const result = new Map<string, ClobBook | null>();
  const uncached: string[] = [];

  for (const tokenId of uniqueIds) {
    const cached = options?.bypassCache ? undefined : getCachedBook(tokenId);
    if (cached !== undefined) result.set(tokenId, cached);
    else uncached.push(tokenId);
  }

  if (uncached.length === 0) return result;

  await clobSemaphore.acquire();
  try {
    const res = await rateLimiters.clobBook.execute(() =>
      fetch('https://clob.polymarket.com/books', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'h2h-arbitrage/1.0',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify(uncached.map((token_id) => ({ token_id, side: 'BUY' }))),
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }),
    );

    if (!res.ok && options?.throwOnFailure) {
      throw new Error(`Polymarket CLOB books request failed with HTTP ${res.status}`);
    }
    const books: unknown = res.ok ? await res.json() : [];
    const byAssetId = new Map<string, ClobBook>();
    const assetIdCounts = new Map<string, number>();
    const isLevelArray = (value: unknown): value is ClobBook['bids'] =>
      Array.isArray(value) && value.every((level) =>
        level != null && typeof level === 'object' &&
        typeof (level as { price?: unknown }).price === 'string' &&
        typeof (level as { size?: unknown }).size === 'string',
      );
    if (Array.isArray(books)) {
      for (const candidate of books) {
        if (!candidate || typeof candidate !== 'object') continue;
        const assetId = (candidate as { asset_id?: unknown }).asset_id;
        if (typeof assetId === 'string') assetIdCounts.set(assetId, (assetIdCounts.get(assetId) ?? 0) + 1);
      }
      for (const candidate of books) {
        if (!candidate || typeof candidate !== 'object') continue;
        const book = candidate as ClobBook;
        if (typeof book.asset_id === 'string' && assetIdCounts.get(book.asset_id) === 1 &&
            isLevelArray(book.bids) && isLevelArray(book.asks)) {
          byAssetId.set(book.asset_id, book);
        }
      }
    }

    for (const tokenId of uncached) {
      const book = byAssetId.get(tokenId) ?? null;
      setCachedBook(tokenId, book);
      result.set(tokenId, book);
    }
  } catch (error) {
    if (options?.throwOnFailure) throw error;
    for (const tokenId of uncached) {
      setCachedBook(tokenId, null);
      result.set(tokenId, null);
    }
  } finally {
    clobSemaphore.release();
  }

  return result;
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

function bestBidShareDepth(book: ClobBook | null): { price: number; shares: number } | null {
  if (!book?.bids?.length) return null;
  const validBids = book.bids
    .map(({ price, size }) => ({ price: finiteDecimal(price), size: finiteDecimal(size) }))
    .filter((level): level is { price: number; size: number } =>
      level.price !== null && level.price > 0 && level.price <= 1
      && level.size !== null && level.size > 0);
  if (!validBids.length) return null;
  const price = Math.max(...validBids.map((level) => level.price));
  return {
    price,
    shares: validBids.filter((level) => level.price === price).reduce((sum, level) => sum + level.size, 0),
  };
}

function positiveBookConstraint(value: unknown): number | null {
  const parsed = finiteDecimal(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export interface OneShareBookValidation {
  valid: boolean;
  minimumOrderSize: number | null;
  tickSize: number | null;
  bestAsk: number | null;
  bestAskShares: number;
  blocker?: string;
}

/** Validate a canonical one-share buy against authoritative token-book metadata. */
export function validateOneShareBookOrder(
  book: ClobBook | null,
  expectedTokenId: string | undefined,
  limitPrice: number,
): OneShareBookValidation {
  const invalid = (blocker: string): OneShareBookValidation => ({
    valid: false,
    minimumOrderSize: null,
    tickSize: null,
    bestAsk: null,
    bestAskShares: 0,
    blocker,
  });
  const validLevels = (value: unknown): value is ClobBook['asks'] =>
    Array.isArray(value) && value.every((level) => {
      if (level == null || typeof level !== 'object') return false;
      const price = (level as { price?: unknown }).price;
      const size = (level as { size?: unknown }).size;
      const parsedPrice = finiteDecimal(price);
      const parsedSize = finiteDecimal(size);
      return typeof price === 'string' && typeof size === 'string'
        && parsedPrice !== null && parsedPrice > 0 && parsedPrice <= 1
        && parsedSize !== null && parsedSize > 0;
    });

  if (!book) return invalid('Polymarket order book is unavailable');
  if (!expectedTokenId) return invalid('Polymarket requested token is unavailable');
  if (typeof book.asset_id !== 'string' || book.asset_id.length === 0) {
    return invalid('Polymarket order book token is unavailable');
  }
  if (book.asset_id !== expectedTokenId) {
    return invalid('Polymarket order book token does not match requested token');
  }
  if (!validLevels(book.bids)) return invalid('Polymarket order book bids are malformed');
  if (!validLevels(book.asks)) return invalid('Polymarket order book asks are malformed');

  const timestamp = book.timestamp;
  if (timestamp == null) return invalid('Polymarket order book timestamp is unavailable');
  // CLOB emits Unix epoch milliseconds as a JSON string. Reject numbers, ISO
  // dates, epoch seconds, whitespace, signs, decimals, and non-canonical width.
  // Preserve epoch zero as a well-formed but necessarily stale sentinel.
  if (typeof timestamp !== 'string' || (timestamp !== '0' && !/^[1-9]\d{12}$/.test(timestamp))) {
    return invalid('Polymarket order book timestamp is malformed');
  }
  const observedAtMs = Number(timestamp);
  if (!Number.isSafeInteger(observedAtMs)) {
    return invalid('Polymarket order book timestamp is malformed');
  }
  const nowMs = Date.now();
  if (observedAtMs > nowMs + CLOB_LIVE_BOOK_MAX_FUTURE_SKEW_MS) {
    return invalid('Polymarket order book timestamp is in the future');
  }
  if (nowMs - observedAtMs > CLOB_LIVE_BOOK_MAX_AGE_MS) {
    return invalid('Polymarket order book is stale');
  }

  const minimumOrderSize = positiveBookConstraint(book?.min_order_size);
  const tickSize = positiveBookConstraint(book?.tick_size);
  const asks = book.asks
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0);
  const bestAsk = asks.length > 0 ? Math.min(...asks.map((level) => level.price)) : null;
  const bestAskShares = bestAsk == null
    ? 0
    : asks.filter((level) => Math.abs(level.price - bestAsk) <= 1e-9).reduce((sum, level) => sum + level.size, 0);

  let blocker: string | undefined;
  if (minimumOrderSize == null) blocker = 'Polymarket minimum order is unavailable';
  else if (minimumOrderSize > 1) blocker = `Polymarket minimum order is ${minimumOrderSize} shares; requested 1 share`;
  else if (tickSize == null) blocker = 'Polymarket tick size is unavailable';
  else if (!isPriceAlignedToTick(limitPrice, tickSize)) {
    blocker = `Polymarket limit price ${limitPrice} is not aligned to tick size ${tickSize}`;
  } else if (bestAsk == null) blocker = 'Polymarket best ask is unavailable';
  else if (limitPrice !== bestAsk) {
    blocker = `Polymarket limit price ${limitPrice} does not match authoritative best ask ${bestAsk}`;
  }
  else if (bestAskShares < 1) blocker = `Polymarket top-of-book depth ${bestAskShares} cannot fill requested 1 share`;

  return {
    valid: blocker == null,
    minimumOrderSize,
    tickSize,
    bestAsk,
    bestAskShares,
    ...(blocker ? { blocker } : {}),
  };
}

function bookConstraints(yesBook: ClobBook | null, noBook: ClobBook | null): Pick<
  ClobPrices,
  'yesMinOrderSize' | 'noMinOrderSize' | 'yesTickSize' | 'noTickSize'
> {
  const yesMinOrderSize = positiveBookConstraint(yesBook?.min_order_size);
  const noMinOrderSize = positiveBookConstraint(noBook?.min_order_size);
  const yesTickSize = positiveBookConstraint(yesBook?.tick_size);
  const noTickSize = positiveBookConstraint(noBook?.tick_size);
  return {
    ...(yesMinOrderSize != null ? { yesMinOrderSize } : {}),
    ...(noMinOrderSize != null ? { noMinOrderSize } : {}),
    ...(yesTickSize != null ? { yesTickSize } : {}),
    ...(noTickSize != null ? { noTickSize } : {}),
  };
}

/**
 * Fetch executable YES and NO depth from CLOB token books. Unknown, missing,
 * or empty books fail closed as zero; Gamma liquidity is not fillable depth.
 */
export async function getClobAskDepths(clob: ClobMarket): Promise<{
  yesAskDepth: number;
  noAskDepth: number;
  yesBid: number | null;
  noBid: number | null;
  yesBidDepth: number | null;
  noBidDepth: number | null;
  yesMinOrderSize: number | null;
  noMinOrderSize: number | null;
  yesTickSize: number | null;
  noTickSize: number | null;
}> {
  const yesToken = clob.tokens?.find(token => token.outcome === 'Yes');
  const noToken = clob.tokens?.find(token => token.outcome === 'No');
  if (!yesToken || !noToken) return {
    yesAskDepth: 0, noAskDepth: 0,
    yesBid: null, noBid: null, yesBidDepth: null, noBidDepth: null,
    yesMinOrderSize: null, noMinOrderSize: null,
    yesTickSize: null, noTickSize: null,
  };

  const [yesBook, noBook] = await Promise.all([
    fetchClobBook(yesToken.token_id),
    fetchClobBook(noToken.token_id),
  ]);
  const yesBid = bestBidShareDepth(yesBook);
  const noBid = bestBidShareDepth(noBook);
  return {
    yesAskDepth: bestAskDollarDepth(yesBook),
    noAskDepth: bestAskDollarDepth(noBook),
    yesBid: yesBid?.price ?? null,
    noBid: noBid?.price ?? null,
    yesBidDepth: yesBid?.shares ?? null,
    noBidDepth: noBid?.shares ?? null,
    yesMinOrderSize: positiveBookConstraint(yesBook?.min_order_size),
    noMinOrderSize: positiveBookConstraint(noBook?.min_order_size),
    yesTickSize: positiveBookConstraint(yesBook?.tick_size),
    noTickSize: positiveBookConstraint(noBook?.tick_size),
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

export interface ClobBidPrices {
  yesBidCents: number | null;
  noBidCents: number | null;
  resolved: boolean;
}

function priceToCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return Math.round(value * 100);
}

/**
 * Extract executable sell prices for both outcome tokens. Token books are the
 * source of truth and are deliberately scanned for MAX(bid), because CLOB
 * levels are not reliably sorted. Token metadata `price` is never used.
 */
export function extractClobBidPrices(
  clob: ClobMarket,
  yesBook: ClobBook | null,
  noBook: ClobBook | null,
): ClobBidPrices {
  const yesToken = clob.tokens?.find((token) => token.outcome.toLowerCase() === 'yes');
  const noToken = clob.tokens?.find((token) => token.outcome.toLowerCase() === 'no');

  const resolution = normalizePolymarketResolution(clob);
  if (resolution.verified) return {
    yesBidCents: resolution.yesPayoutCents,
    noBidCents: resolution.noPayoutCents,
    resolved: true,
  };

  const yesPrices = getBestPriceFromBook(yesBook);
  const noPrices = getBestPriceFromBook(noBook);
  let yesBidCents = yesPrices && yesPrices.bestBid > 0 ? priceToCents(yesPrices.bestBid) : null;
  let noBidCents = noPrices && noPrices.bestBid > 0 ? priceToCents(noPrices.bestBid) : null;

  // Aggregate complementary quotes are valid only for standard binary markets.
  // Neg-risk outcomes are independent and must never be inferred as 1-price.
  if (clob.neg_risk !== true) {
    if (yesBidCents == null) yesBidCents = priceToCents(clob.best_bid);
    if (noBidCents == null && typeof clob.best_ask === 'number' && clob.best_ask > 0) {
      noBidCents = priceToCents(1 - clob.best_ask);
    }
  }
  return { yesBidCents, noBidCents, resolved: false };
}

/** Fetch executable YES/NO sell bids from the two token orderbooks. */
export async function getClobBidPrices(clob: ClobMarket): Promise<ClobBidPrices> {
  const yesToken = clob.tokens?.find((token) => token.outcome.toLowerCase() === 'yes');
  const noToken = clob.tokens?.find((token) => token.outcome.toLowerCase() === 'no');
  if (!yesToken || !noToken) return extractClobBidPrices(clob, null, null);
  const [yesBook, noBook] = await Promise.all([
    fetchClobBook(yesToken.token_id),
    fetchClobBook(noToken.token_id),
  ]);
  return extractClobBidPrices(clob, yesBook, noBook);
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

export interface ClobPrices {
  yesPrice: number;
  noPrice: number;
  bestBid: number;
  bestAsk: number;
  lastTradePrice: number;
  yesAskDepth?: number;
  noAskDepth?: number;
  yesBid?: number;
  noBid?: number;
  yesBidDepth?: number;
  noBidDepth?: number;
  yesMinOrderSize?: number;
  noMinOrderSize?: number;
  yesTickSize?: number;
  noTickSize?: number;
}

/** Derive executable prices from token books already fetched by the caller. */
export function getClobPricesFromBooks(
  clob: ClobMarket,
  yesBook: ClobBook | null = null,
  noBook: ClobBook | null = null,
): ClobPrices | null {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const isExecutablePrice = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
  const yesPrices = getBestPriceFromBook(yesBook);
  const noPrices = getBestPriceFromBook(noBook);
  const yesBid = bestBidShareDepth(yesBook);
  const noBid = bestBidShareDepth(noBook);
  const exactBidEvidence = {
    ...(yesBid ? { yesBid: yesBid.price, yesBidDepth: yesBid.shares } : {}),
    ...(noBid ? { noBid: noBid.price, noBidDepth: noBid.shares } : {}),
  };

  if (clob.neg_risk !== true && isExecutablePrice(clob.best_bid) && isExecutablePrice(clob.best_ask)) {
    // Keep executable price and depth on the same token-book level. Gamma's
    // aggregate quote can lag the book and must not be paired with unrelated
    // depth for sizing.
    const yesPrice = yesPrices?.bestAsk && yesPrices.bestAsk > 0 ? clamp(yesPrices.bestAsk) : clamp(clob.best_ask);
    const noPrice = noPrices?.bestAsk && noPrices.bestAsk > 0 ? clamp(noPrices.bestAsk) : clamp(1 - clob.best_bid);
    return {
      yesPrice,
      noPrice,
      bestBid: yesPrices?.bestBid && yesPrices.bestBid > 0 ? clamp(yesPrices.bestBid) : clamp(clob.best_bid),
      bestAsk: yesPrice,
      lastTradePrice: clob.last_trade_price ?? yesPrice,
      yesAskDepth: bestAskDollarDepth(yesBook),
      noAskDepth: bestAskDollarDepth(noBook),
      ...exactBidEvidence,
      ...bookConstraints(yesBook, noBook),
    };
  }

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
    yesAskDepth: bestAskDollarDepth(yesBook),
    noAskDepth: bestAskDollarDepth(noBook),
    ...exactBidEvidence,
    ...bookConstraints(yesBook, noBook),
  };
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
  
  // NO price: only an actual NO ask or an executable YES bid can fund the
  // complementary leg. Token metadata `price` is indicative midpoint/last
  // data and must never be presented or calculated as available liquidity.
  let noPrice: number;
  if (n.bestAsk != null && n.bestAsk > 0) {
    noPrice = clamp(n.bestAsk);
  } else if (y.bestBid != null && y.bestBid > 0) {
    noPrice = clamp(1 - y.bestBid);
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
