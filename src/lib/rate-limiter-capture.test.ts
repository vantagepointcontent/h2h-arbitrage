import { describe, expect, it, vi } from 'vitest';
import { captureAndPersistRateLimiterMetrics } from './rate-limiter-capture';

describe('captureAndPersistRateLimiterMetrics', () => {
  it('persists the worker-local limiter counters before resetting them', async () => {
    const persist = vi.fn(async () => undefined);
    const reset = vi.fn();
    const snapshots = [{
      label: 'kalshi',
      metrics: { totalRequests: 7, queuedRequests: 2, rejectedRequests: 0, retry429Count: 1, avgQueueWaitMs: 3 },
      throttle: { tokens: 42, isThrottled: false, effectiveRate: 5 },
      config: { refillIntervalMs: 200 },
    }];

    const count = await captureAndPersistRateLimiterMetrics({
      serviceIdentity: 'full-scan-worker',
      now: () => new Date('2026-08-16T12:00:00.000Z'),
      snapshot: () => snapshots as never,
      persist,
      resetters: [reset],
    });

    expect(count).toBe(1);
    expect(persist).toHaveBeenCalledWith([expect.objectContaining({
      limiterName: 'kalshi',
      timestamp: '2026-08-16T12:00:00.000Z',
      totalRequests: 7,
      queuedRequests: 2,
      retry429Count: 1,
      serviceIdentity: 'full-scan-worker',
    })]);
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(reset.mock.invocationCallOrder[0]);
  });

  it('does not erase counters when persistence fails', async () => {
    const reset = vi.fn();
    await expect(captureAndPersistRateLimiterMetrics({
      serviceIdentity: 'next-app',
      snapshot: () => [{
        label: 'gamma',
        metrics: { totalRequests: 1, queuedRequests: 0, rejectedRequests: 0, retry429Count: 0, avgQueueWaitMs: 0 },
        throttle: { tokens: 1, isThrottled: false, effectiveRate: 1 },
        config: { refillIntervalMs: 1000 },
      }] as never,
      persist: vi.fn(async () => { throw new Error('database locked'); }),
      resetters: [reset],
    })).rejects.toThrow('database locked');
    expect(reset).not.toHaveBeenCalled();
  });

  it('retries transient SQLite writer contention before resetting counters', async () => {
    const persist = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }))
      .mockResolvedValueOnce(undefined);
    const reset = vi.fn();
    await captureAndPersistRateLimiterMetrics({
      serviceIdentity: 'full-scan-worker',
      snapshot: () => [{
        label: 'kalshi',
        metrics: { totalRequests: 2, queuedRequests: 0, rejectedRequests: 0, retry429Count: 0, avgQueueWaitMs: 0 },
        throttle: { tokens: 1, queueLength: 0, isThrottled: false, effectiveRate: 1 },
        config: { maxTokens: 1, refillIntervalMs: 1000, maxQueueSize: 1, maxRetries: 1, retryBaseDelayMs: 1 },
      }],
      persist,
      resetters: [reset],
    });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledOnce();
  });
});
