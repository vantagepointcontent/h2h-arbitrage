// Rate Limiter — token bucket with FIFO queue, throttle indicator, 429 retry
// Usage:
//   import { rateLimiters, RateLimiter, ThrottleIndicator } from '@/lib/rate-limiter';
//   const limiter = rateLimiters.gamma;
//   const res = await limiter.execute(() => fetch(url, options));
//
// Per-endpoint configs are exposed as named instances. Callers pick by endpoint,
// not by constructing their own limiter (avoids duplicate buckets).

/* ──────────────────────────── Types ──────────────────────────── */

export interface RateLimiterConfig {
  /** Maximum burst size (tokens refilled up to this cap) */
  maxTokens: number;
  /** Milliseconds between token refills (controls sustained rate) */
  refillIntervalMs: number;
  /** Initial tokens on creation (defaults to maxTokens) */
  initialTokens?: number;
  /** Maximum queued requests when bucket is empty (-1 = unlimited) */
  maxQueueSize: number;
  /** Max retries on HTTP 429 */
  maxRetries: number;
  /** Base delay for exponential backoff on 429 (ms) */
  retryBaseDelayMs: number;
}

export interface ThrottleSnapshot {
  /** Tokens currently available */
  tokens: number;
  /** Requests waiting in the FIFO queue */
  queueLength: number;
  /** Whether new requests are being delayed */
  isThrottled: boolean;
  /** Effective rate: tokens per second */
  effectiveRate: number;
}

export interface RateLimiterMetrics {
  /** Total requests processed (queued + immediate) */
  totalRequests: number;
  /** Requests that had to wait in the queue */
  queuedRequests: number;
  /** Requests rejected due to queue overflow */
  rejectedRequests: number;
  /** Total 429 retries attempted */
  retry429Count: number;
  /** Average queue wait time in ms (0 if nothing queued) */
  avgQueueWaitMs: number;
}

/* ──────────────────────────── Token Bucket ───────────────────── */

/**
 * Token bucket rate limiter with FIFO queue.
 *
 * Algorithm:
 *   - Bucket holds up to `maxTokens` tokens.
 *   - Tokens refill by 1 every `refillIntervalMs` milliseconds.
 *   - `execute(fn)` consumes 1 token. If none available, the caller enqueues
 *     and waits FIFO-style until a token frees up.
 *   - On HTTP 429, the response is retried with exponential backoff (independent
 *     of the bucket — server-side rate limits are separate from our shaping).
 */
export class RateLimiter {
  private tokens: number;
  private queue: (() => void)[] = [];
  private lastRefill: number;
  private intervalId: ReturnType<typeof setInterval>;

  // Metrics
  private _totalRequests = 0;
  private _queuedRequests = 0;
  private _rejectedRequests = 0;
  private _retry429Count = 0;
  private _queueWaitTotalMs = 0;

  constructor(
    private readonly label: string,
    private readonly config: RateLimiterConfig,
  ) {
    this.tokens = config.initialTokens ?? config.maxTokens;
    this.lastRefill = Date.now();
    this.intervalId = this.scheduleRefill();
  }

  /* ── Public API ── */

  /**
   * Execute an async function with rate limiting.
   * Consumes 1 token, queues if empty, retries 429s.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this._totalRequests++;
    const enqueueTime = Date.now();

    // Wait for a token (FIFO queue)
    await this.waitForToken();

    const queueWaitMs = Date.now() - enqueueTime;
    if (queueWaitMs > 0) {
      this._queuedRequests++;
      this._queueWaitTotalMs += queueWaitMs;
    }

    // Execute with 429 retry
    return this.withRetry(fn);
  }

  /** Get a point-in-time snapshot of throttle state. */
  getThrottleSnapshot(): ThrottleSnapshot {
    this.refill();
    return {
      tokens: this.tokens,
      queueLength: this.queue.length,
      isThrottled: this.tokens <= 0 || this.queue.length > 0,
      effectiveRate: 1000 / this.config.refillIntervalMs,
    };
  }

  /** Cumulative metrics since creation. */
  getMetrics(): RateLimiterMetrics {
    return {
      totalRequests: this._totalRequests,
      queuedRequests: this._queuedRequests,
      rejectedRequests: this._rejectedRequests,
      retry429Count: this._retry429Count,
      avgQueueWaitMs:
        this._queuedRequests > 0
          ? Math.round(this._queueWaitTotalMs / this._queuedRequests)
          : 0,
    };
  }

  /** Reset all counters (useful for periodic reporting). */
  resetMetrics(): void {
    this._totalRequests = 0;
    this._queuedRequests = 0;
    this._rejectedRequests = 0;
    this._retry429Count = 0;
    this._queueWaitTotalMs = 0;
  }

  /** Shut down the refill interval (cleanup). */
  dispose(): void {
    clearInterval(this.intervalId);
  }

  /* ── Token bucket internals ── */

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor(elapsed / this.config.refillIntervalMs);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(
        this.config.maxTokens,
        this.tokens + tokensToAdd,
      );
      this.lastRefill += tokensToAdd * this.config.refillIntervalMs;
    }
  }

  private scheduleRefill(): ReturnType<typeof setInterval> {
    return setInterval(() => this.refill(), this.config.refillIntervalMs);
  }

  /**
   * Wait for a token. Rejects if queue is full.
   */
  private waitForToken(): Promise<void> {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return Promise.resolve();
    }

    // Queue is empty — check capacity
    if (
      this.config.maxQueueSize >= 0 &&
      this.queue.length >= this.config.maxQueueSize
    ) {
      this._rejectedRequests++;
      return Promise.reject(
        new Error(
          `[rate-limit:${this.label}] Queue full (${this.config.maxQueueSize}), rejecting request`,
        ),
      );
    }

    return new Promise<void>(resolve => {
      this.queue.push(() => {
        this.tokens--;
        resolve();
      });
      this.drainQueue();
    });
  }

  /**
   * Called whenever tokens are refilled to drain the FIFO queue.
   */
  private drainQueue(): void {
    this.refill();
    while (this.tokens > 0 && this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    }
  }

  /**
   * Retry a fetch on HTTP 429 with exponential backoff + jitter.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    const maxRetries = this.config.maxRetries;
    const baseDelay = this.config.retryBaseDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();

        // If the result is a Response-like object with status 429, retry
        if (
          attempt < maxRetries &&
          result &&
          typeof result === 'object' &&
          'status' in result &&
          (result as any).status === 429
        ) {
          const delay = this.backoffDelay(attempt, baseDelay);
          this._retry429Count++;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        return result;
      } catch (err) {
        lastError = err;
        // Retry on AbortError (timeout) too, up to maxRetries
        if (attempt < maxRetries) {
          const delay = this.backoffDelay(attempt, baseDelay);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Exponential backoff with +/-25% jitter.
   * delay = base * 2^attempt * (0.75 .. 1.25)
   */
  private backoffDelay(attempt: number, baseMs: number): number {
    const exp = Math.pow(2, attempt);
    const jitter = 0.75 + Math.random() * 0.5; // 0.75..1.25
    return Math.round(baseMs * exp * jitter);
  }
}

/* ──────────────────────────── Endpoint Configs ───────────────── */

/**
 * Default rate limits per upstream endpoint.
 * Override via environment variables:
 *   H2H_GAMMA_MAX_TOKENS, H2H_GAMMA_REFILL_MS
 *   H2H_CLOB_MAX_TOKENS, H2H_CLOB_REFILL_MS
 *   H2H_KALSHI_MAX_TOKENS, H2H_KALSHI_REFILL_MS
 *   H2H_PREDICTIONHUNT_MAX_TOKENS, H2H_PREDICTIONHUNT_REFILL_MS
 */

function envInt(key: string, fallback: number): number {
  const v = parseInt(process.env[key] || '', 10);
  return isNaN(v) ? fallback : v;
}

const GAMMA_CFG: RateLimiterConfig = {
  maxTokens: envInt('H2H_GAMMA_MAX_TOKENS', 300),
  refillIntervalMs: envInt('H2H_GAMMA_REFILL_MS', 33), // ~30 req/s sustained
  maxQueueSize: envInt('H2H_GAMMA_QUEUE_SIZE', 100),
  maxRetries: 3,
  retryBaseDelayMs: 100,
};

const CLOB_MARKETS_CFG: RateLimiterConfig = {
  maxTokens: envInt('H2H_CLOB_MAX_TOKENS', 50),
  refillIntervalMs: envInt('H2H_CLOB_REFILL_MS', 100), // ~10 req/s
  maxQueueSize: envInt('H2H_CLOB_QUEUE_SIZE', 50),
  maxRetries: 2,
  retryBaseDelayMs: 200,
};

const CLOB_BOOK_CFG: RateLimiterConfig = {
  maxTokens: envInt('H2H_CLOB_BOOK_MAX_TOKENS', 30),
  refillIntervalMs: envInt('H2H_CLOB_BOOK_REFILL_MS', 200), // ~5 req/s
  maxQueueSize: envInt('H2H_CLOB_BOOK_QUEUE_SIZE', 30),
  maxRetries: 2,
  retryBaseDelayMs: 300,
};

const KALSHI_CFG: RateLimiterConfig = {
  maxTokens: envInt('H2H_KALSHI_MAX_TOKENS', 60),
  refillIntervalMs: envInt('H2H_KALSHI_REFILL_MS', 167), // ~6 req/s
  maxQueueSize: envInt('H2H_KALSHI_QUEUE_SIZE', 50),
  maxRetries: 3,
  retryBaseDelayMs: 100,
};

const PH_CFG: RateLimiterConfig = {
  maxTokens: envInt('H2H_PREDICTIONHUNT_MAX_TOKENS', 20),
  refillIntervalMs: envInt('H2H_PREDICTIONHUNT_REFILL_MS', 500), // ~2 req/s
  maxQueueSize: envInt('H2H_PREDICTIONHUNT_QUEUE_SIZE', 20),
  maxRetries: 3,
  retryBaseDelayMs: 200,
};

/* ──────────────────────────── Singleton Instances ────────────── */

const gammaInstance = new RateLimiter('gamma', GAMMA_CFG);
const clobMarketsInstance = new RateLimiter('clob-markets', CLOB_MARKETS_CFG);
const clobBookInstance = new RateLimiter('clob-book', CLOB_BOOK_CFG);
const kalshiInstance = new RateLimiter('kalshi', KALSHI_CFG);
const phInstance = new RateLimiter('predictionhunt', PH_CFG);

/**
 * Named rate limiter instances — import and use directly.
 *
 *   import { rateLimiters } from '@/lib/rate-limiter';
 *   const res = await rateLimiters.gamma.execute(() => fetch(url));
 */
export const rateLimiters = {
  /** Polymarket Gamma API (gamma-api.polymarket.com) */
  gamma: gammaInstance,
  /** CLOB markets endpoint (/markets/:id) */
  clobMarkets: clobMarketsInstance,
  /** CLOB book endpoint (/book?token_id=:) */
  clobBook: clobBookInstance,
  /** Kalshi Trade API (external-api.kalshi.com) */
  kalshi: kalshiInstance,
  /** PredictionHunt API (predictionhunt.com/api/v2) */
  predictionhunt: phInstance,
} as const;

export type RateLimiterKey = keyof typeof rateLimiters;

/**
 * Convenience: get a limiter by key string.
 */
export function getLimiter(key: RateLimiterKey): RateLimiter {
  return rateLimiters[key];
}

/**
 * Aggregate throttle status across all limiters.
 */
export function getAllThrottleSnapshots(): Record<string, ThrottleSnapshot> {
  const snapshots: Record<string, ThrottleSnapshot> = {};
  for (const [key, limiter] of Object.entries(rateLimiters)) {
    snapshots[key] = limiter.getThrottleSnapshot();
  }
  return snapshots;
}

/**
 * Aggregate metrics across all limiters.
 */
export function getAllMetrics(): Record<string, RateLimiterMetrics> {
  const metrics: Record<string, RateLimiterMetrics> = {};
  for (const [key, limiter] of Object.entries(rateLimiters)) {
    metrics[key] = limiter.getMetrics();
  }
  return metrics;
}

/* ──────────────────────────── Helper: fetch wrapper ──────────── */

/**
 * Wrap a fetch call with rate limiting. Use this as a drop-in replacement
 * for `fetch()` in venue adapter modules.
 *
 *   import { rateLimitedFetch } from '@/lib/rate-limiter';
 *   const res = await rateLimitedFetch('gamma', url, init);
 */
export async function rateLimitedFetch(
  limiterKey: RateLimiterKey,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const limiter = rateLimiters[limiterKey];
  return limiter.execute(() => fetch(url, init));
}

/**
 * Check if any limiter is currently throttled.
 */
export function isAnyThrottled(): boolean {
  for (const limiter of Object.values(rateLimiters)) {
    const snap = limiter.getThrottleSnapshot();
    if (snap.isThrottled) return true;
  }
  return false;
}
