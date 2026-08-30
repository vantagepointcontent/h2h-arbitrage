import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSavedMarkets: vi.fn(),
  reconcileSavedMarketMatchSummaries: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('@/lib/persistence', () => ({
  getSavedMarkets: mocks.getSavedMarkets,
  reconcileSavedMarketMatchSummaries: mocks.reconcileSavedMarketMatchSummaries,
  saveMarket: vi.fn(),
  updateSavedMarket: vi.fn(),
  archiveMarket: vi.fn(),
  restoreMarket: vi.fn(),
  deleteMarket: vi.fn(),
}));
vi.mock('fs/promises', () => ({ default: { readFile: mocks.readFile } }));
vi.mock('@/lib/bot-api-consumer', () => ({
  upsertSavedMarketSubscription: vi.fn(),
  disableSavedMarketSubscriptions: vi.fn(),
}));

import { GET } from './route';

describe('GET /api/saved-markets lifecycle projection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T16:00:00.000Z'));
    mocks.reconcileSavedMarketMatchSummaries.mockResolvedValue(0);
    mocks.readFile.mockResolvedValue(JSON.stringify({
      'market-1': {
        lastAttemptAt: '2026-08-30T15:50:00.000Z',
        lastSuccessAt: '2026-08-30T15:00:00.000Z',
        failureReason: 'HTTP 503 (DISK_CAPACITY)',
        freshnessSlaMs: 3_600_000,
      },
    }));
    mocks.getSavedMarkets.mockResolvedValue([{
      id: 'market-1',
      eventTitle: 'Cached failure',
      kalshiUrl: 'https://kalshi.example/market-1',
      polymarketUrl: 'https://polymarket.example/market-1',
      createdAt: '2026-08-30T14:00:00.000Z',
      canonicalApyObservedAt: '2026-08-30T15:00:00.000Z',
      lastScanResult: {
        matchStatus: 'matched',
        scannedAt: '2026-08-30T15:00:00.000Z',
        matchedCount: 1,
        bestRoiPct: 2,
        bestProfit: 1,
        strategy: 'Buy YES Kalshi + NO PM',
        allArbs: [],
      },
      liveResult: {
        matchStatus: 'unavailable',
        scannedAt: '2026-08-30T15:55:00.000Z',
        matchedCount: 1,
        refreshStatus: 'partial',
        _priceDataObservedAt: '2026-08-30T15:54:59.000Z',
        refreshLifecycle: {
          requestedAt: '2026-08-30T15:54:58.000Z',
          structureFetchedAt: null,
          completedAt: '2026-08-30T15:55:00.000Z',
        },
        platformDiagnostics: {
          kalshi: { status: 'failed', count: 0, reason: 'Kalshi credentials unavailable' },
          polymarket: { status: 'fresh', count: 1 },
        },
      },
    }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns the same canonical lifecycle in basic and detail payloads', async () => {
    const basicResponse = await GET(new NextRequest('http://localhost/api/saved-markets?fields=basic'));
    const detailResponse = await GET(new NextRequest('http://localhost/api/saved-markets?id=market-1'));
    const basic = (await basicResponse.json()).markets[0];
    const detail = (await detailResponse.json()).market;

    expect(basicResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    expect(basic.lifecycle).toEqual(detail.lifecycle);
    expect(basic.lifecycle).toMatchObject({
      overallStatus: 'partial',
      fullScan: { status: 'failed', reason: 'HTTP 503 (DISK_CAPACITY)' },
      manualRefresh: { status: 'partial' },
      venues: {
        kalshi: { status: 'credentials_unavailable' },
        polymarket: { status: 'fresh' },
      },
      cachedData: { status: 'available', observedAt: '2026-08-30T15:54:59.000Z' },
    });
  });
});
