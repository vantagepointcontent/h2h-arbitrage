import { describe, expect, it } from 'vitest';
import { buildBasicSavedMarketList } from './saved-markets-list';
import type { SavedMarket } from './persistence';

describe('buildBasicSavedMarketList expiry provenance', () => {
  it('projects persisted expiry provenance without venue requests', () => {
    const market = {
      id: 'market-1',
      eventTitle: 'Who will be arrested before 2027?',
      kalshiUrl: 'https://kalshi.com/markets/kxarrest/arrests/kxarrest-27jan',
      polymarketUrl: 'https://polymarket.com/event/who-will-be-arrested-before-2027',
      expiryDate: '2027-01-01T04:59:00Z',
      expirySource: 'kalshi_market_close_time',
      expirySourceId: 'KXARREST-27JAN',
      expiryObservedAt: '2026-08-24T23:05:20.392Z',
      category: 'Politics',
      archived: false,
      createdAt: '2026-08-01T00:00:00Z',
      lastScanResult: null,
      liveResult: null,
    } as unknown as SavedMarket;

    expect(buildBasicSavedMarketList([market], {})[0]).toMatchObject({
      expiryDate: '2027-01-01T04:59:00Z',
      expirySource: 'kalshi_market_close_time',
      expirySourceId: 'KXARREST-27JAN',
      expiryObservedAt: '2026-08-24T23:05:20.392Z',
    });
  });

  it('projects one canonical lifecycle for cached data after a failed scheduled scan', () => {
    const market = {
      id: 'market-cached-failure', eventTitle: 'Cached failure', kalshiUrl: 'k', polymarketUrl: 'p',
      createdAt: '2026-08-30T14:00:00.000Z', canonicalApyObservedAt: '2026-08-30T15:00:00.000Z',
      lastScanResult: {
        matchStatus: 'matched', scannedAt: '2026-08-30T15:00:00.000Z', matchedCount: 1,
        bestRoiPct: 2, bestProfit: 1, strategy: 'Buy YES Kalshi + NO PM', outcomeCount: 1,
        kalshiCount: 1, pmCount: 1, allArbs: [{ artist: 'Outcome', roiPct: 2, expectedProfit: 1, strategy: 'Buy YES Kalshi + NO PM' }],
      },
      liveResult: {
        matchStatus: 'unavailable', scannedAt: '2026-08-30T15:55:00.000Z', matchedCount: 1,
        refreshStatus: 'partial', _priceDataObservedAt: '2026-08-30T15:54:59.000Z',
        refreshLifecycle: { requestedAt: '2026-08-30T15:54:58.000Z', structureFetchedAt: null, completedAt: '2026-08-30T15:55:00.000Z' },
        platformDiagnostics: {
          kalshi: { status: 'failed', count: 0, reason: 'Kalshi credentials unavailable' },
          polymarket: { status: 'fresh', count: 1 },
        },
      },
    } as unknown as SavedMarket;
    const scheduler = {
      'market-cached-failure': {
        lastAttemptAt: '2026-08-30T15:50:00.000Z', lastSuccessAt: '2026-08-30T15:00:00.000Z',
        failureReason: 'HTTP 503 (DISK_CAPACITY)', freshnessSlaMs: 3_600_000,
      },
    };

    expect(buildBasicSavedMarketList([market], scheduler, Date.parse('2026-08-30T16:00:00.000Z'))[0].lifecycle).toMatchObject({
      overallStatus: 'partial',
      fullScan: { status: 'failed', reason: 'HTTP 503 (DISK_CAPACITY)' },
      manualRefresh: { status: 'partial' },
      venues: {
        kalshi: { status: 'credentials_unavailable' }, polymarket: { status: 'fresh' },
      },
      cachedData: { status: 'available', observedAt: '2026-08-30T15:54:59.000Z' },
    });
  });
});
