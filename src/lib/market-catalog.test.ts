import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter, rateLimiters, RateLimitedError, isRateLimitedError } from '@/lib/rate-limiter';

describe('FEAT-046 rate limiter 429 handling', () => {
  it('throws RateLimitedError after exhausting 429 retries', async () => {
    const limiter = new RateLimiter('test', {
      maxTokens: 10,
      refillIntervalMs: 1,
      maxQueueSize: 0,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    });

    const failingFn = vi.fn().mockResolvedValue({ status: 429, ok: false });

    await expect(limiter.execute(failingFn)).rejects.toBeInstanceOf(RateLimitedError);
    expect(failingFn).toHaveBeenCalledTimes(3); // initial + 2 retries
    limiter.dispose();
  });

  it('isRateLimitedError identifies RateLimitedError', () => {
    expect(isRateLimitedError(new RateLimitedError('boom', 3))).toBe(true);
    expect(isRateLimitedError(new Error('boom'))).toBe(false);
    expect(isRateLimitedError(null)).toBe(false);
  });
});

describe('FEAT-046 catalog throttle constants', () => {
  it('exposes Kalshi and Polymarket minimum page delays', async () => {
    const { CATALOG_THROTTLE } = await import('@/lib/market-catalog');
    expect(CATALOG_THROTTLE.kalshiMinPageDelayMs).toBeGreaterThanOrEqual(200);
    expect(CATALOG_THROTTLE.polymarketMinPageDelayMs).toBeGreaterThanOrEqual(50);
  });
});

// Note: the full catalog fetch path touches the live network, so it is not run
// as a unit test. The fetch helpers are exercised separately in their own
// module tests; this file guards the new 429 signal path and throttle config.
