import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getCapacityUtilization: vi.fn(),
  getOperationalTelemetryFreshness: vi.fn(),
  persistRateLimiterMetrics: vi.fn(),
}));

vi.mock('@/lib/persistence', () => mocks);

import { GET } from './route';

describe('GET /api/dashboard/capacity telemetry truthfulness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:30:00.000Z'));
    mocks.getCapacityUtilization.mockResolvedValue([{
      hour: '2026-08-16T11:00:00', limiter: 'kalshi', utilizationPct: 0,
      totalRequests: 0, maxRequests: 100, isThrottled: 0, avgQueueWaitMs: 0,
      rejectedRequests: 0, sampleCount: 12, lastSampleAt: '2026-08-16T11:59:00.000Z',
    }]);
    mocks.getOperationalTelemetryFreshness.mockResolvedValue({
      latestCapacitySampleAt: '2026-08-16T11:59:00.000Z',
      latestWorkerCapacitySampleAt: '2026-08-16T11:59:00.000Z',
      latestCompletedScanAt: '2026-08-16T12:29:00.000Z',
    });
  });

  it('keeps missing buckets null instead of silently turning them into zero usage', async () => {
    const response = await GET(new NextRequest('http://localhost/api/dashboard/capacity?range=today'));
    const json = await response.json();
    const kalshi = json.series.find((series: { name: string }) => series.name === 'Kalshi');

    expect(kalshi.data.find((point: { hour: string }) => point.hour === '2026-08-16T11:00:00')).toMatchObject({
      utilizationPct: 0,
      sampleState: 'confirmed_zero',
    });
    expect(kalshi.data.find((point: { hour: string }) => point.hour === '2026-08-16T12:00:00')).toMatchObject({
      utilizationPct: null,
      sampleState: 'no_samples',
    });
  });

  it('reports collector and scanner freshness independently', async () => {
    const response = await GET(new NextRequest('http://localhost/api/dashboard/capacity?range=today'));
    const json = await response.json();
    expect(json.telemetry).toMatchObject({
      collector: { state: 'collector_degraded' },
      scanner: { state: 'healthy' },
    });
  });

  it('does not let fresh next-app samples mask a stale full-scan-worker collector', async () => {
    mocks.getOperationalTelemetryFreshness.mockResolvedValue({
      latestCapacitySampleAt: '2026-08-16T12:29:00.000Z',
      latestWorkerCapacitySampleAt: '2026-08-16T11:59:00.000Z',
      latestCompletedScanAt: '2026-08-16T12:29:00.000Z',
    });
    const response = await GET(new NextRequest('http://localhost/api/dashboard/capacity?range=today'));
    const json = await response.json();
    expect(json.telemetry).toMatchObject({
      collector: { state: 'healthy' },
      workerCollector: { state: 'worker_collector_degraded' },
      scanner: { state: 'healthy' },
    });
  });
});
