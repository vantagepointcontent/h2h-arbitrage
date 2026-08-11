export interface CurrentPriceRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface WindowEntry {
  count: number;
  resetsAt: number;
}

const MAX_REQUESTS_PER_WINDOW = 10;
const WINDOW_MS = 60_000;
const MAX_CLIENT_ENTRIES = 1_000;

/** Process-local guard that caps traffic to the two downstream quote providers. */
export class CurrentPriceRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(
    private readonly maxRequests = MAX_REQUESTS_PER_WINDOW,
    private readonly windowMs = WINDOW_MS,
    private readonly maxEntries = MAX_CLIENT_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string): CurrentPriceRateLimitResult {
    const now = this.now();
    this.pruneExpired(now);

    const existing = this.entries.get(key);
    if (!existing && this.entries.size >= this.maxEntries) {
      let earliestReset = now + this.windowMs;
      for (const entry of this.entries.values()) {
        earliestReset = Math.min(earliestReset, entry.resetsAt);
      }
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((earliestReset - now) / 1_000)),
      };
    }

    const entry = existing ?? { count: 0, resetsAt: now + this.windowMs };
    entry.count += 1;
    if (!existing) this.entries.set(key, entry);

    return {
      allowed: entry.count <= this.maxRequests,
      remaining: Math.max(0, this.maxRequests - entry.count),
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetsAt - now) / 1_000)),
    };
  }

  reset(): void {
    this.entries.clear();
  }

  getStoredEntryCountForTests(): number {
    return this.entries.size;
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetsAt <= now) this.entries.delete(key);
    }
  }
}

const GLOBAL_ENDPOINT_KEY = 'current-prices';
const currentPriceRateLimiter = new CurrentPriceRateLimiter();

export function consumeCurrentPriceGlobalRateLimit(): CurrentPriceRateLimitResult {
  return currentPriceRateLimiter.consume(GLOBAL_ENDPOINT_KEY);
}

export function resetCurrentPriceRateLimitForTests(): void {
  currentPriceRateLimiter.reset();
}
