import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  persistRateLimiterMetrics: vi.fn(),
  resetMetrics: vi.fn(),
  snapshotRateLimiterMetrics: vi.fn(),
}));

vi.mock('@/lib/persistence', () => ({ persistRateLimiterMetrics: mocks.persistRateLimiterMetrics }));
vi.mock('@/lib/rate-limiter', () => ({
  snapshotRateLimiterMetrics: mocks.snapshotRateLimiterMetrics,
  rateLimiters: { kalshi: { resetMetrics: mocks.resetMetrics } },
}));

import { POST } from './route';

describe('POST /api/snapshot-limiters service identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistRateLimiterMetrics.mockResolvedValue(undefined);
    mocks.snapshotRateLimiterMetrics.mockReturnValue([{
      label: 'kalshi',
      metrics: { totalRequests: 2, queuedRequests: 0, rejectedRequests: 0, retry429Count: 0, avgQueueWaitMs: 0 },
      throttle: { tokens: 3, isThrottled: false, effectiveRate: 4 },
      config: { refillIntervalMs: 250 },
    }]);
  });

  it('tags every in-process sample as next-app rather than unknown', async () => {
    const response = await POST(new NextRequest('http://localhost/api/snapshot-limiters', { method: 'POST' }));

    expect(response.status).toBe(200);
    expect(mocks.persistRateLimiterMetrics).toHaveBeenCalledWith([
      expect.objectContaining({ limiterName: 'kalshi', serviceIdentity: 'next-app' }),
    ]);
  });

  it('does not reset counters when the durable write fails', async () => {
    mocks.persistRateLimiterMetrics.mockRejectedValue(new Error('SQLITE_BUSY worker write'));

    const response = await POST(new NextRequest('http://localhost/api/snapshot-limiters', { method: 'POST' }));

    expect(response.status).toBe(500);
    expect(mocks.resetMetrics).not.toHaveBeenCalled();
  });
});