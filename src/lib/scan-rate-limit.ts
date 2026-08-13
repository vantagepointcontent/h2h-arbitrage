export interface ScanRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface WindowEntry {
  count: number;
  resetsAt: number;
}

/**
 * Small, process-local fixed-window guard for the expensive scan route.
 * Upstream API limiters remain the backstop; this prevents one browser/client
 * from filling their queues before a scan reaches those upstream calls.
 */
export class ScanRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(
    private readonly maxRequests = 30,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string): ScanRateLimitResult {
    const now = this.now();
    const existing = this.entries.get(key);
    const entry = !existing || existing.resetsAt <= now
      ? { count: 0, resetsAt: now + this.windowMs }
      : existing;

    entry.count += 1;
    this.entries.set(key, entry);

    const remaining = Math.max(0, this.maxRequests - entry.count);
    return {
      allowed: entry.count <= this.maxRequests,
      remaining,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetsAt - now) / 1000)),
    };
  }
}

/**
 * Process-local admission control for the CPU-heavy full scan route. A rate
 * limit alone still permits a burst of expensive scans to run concurrently,
 * starving lightweight health and Logs requests on Node's event loop.
 */
export class ScanConcurrencyLimiter {
  private active = 0;

  constructor(private readonly maxConcurrent = 1) {}

  tryAcquire(): (() => void) | null {
    if (this.active >= this.maxConcurrent) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}

export function getScanClientKey(headers: Headers): string {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  const forwardedIp = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwardedIp || 'anonymous';
}

export const scanRateLimiter = new ScanRateLimiter();
export const scanConcurrencyLimiter = new ScanConcurrencyLimiter(
  Math.max(1, Number(process.env.H2H_SCAN_CONCURRENCY || 1)),
);
