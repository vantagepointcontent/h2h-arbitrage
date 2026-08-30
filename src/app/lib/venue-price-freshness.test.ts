import { describe, expect, it } from 'vitest';
import {
  mergeVenuePriceFreshness,
  selectSavedMarketPriceCache,
  venuePriceFreshnessFromScan,
  type LastScanResult,
  type VenuePriceFreshnessMap,
} from './page-shared';

const previous: VenuePriceFreshnessMap = {
  kalshi: {
    status: 'fresh', observedAt: '2026-08-30T12:00:00.000Z',
    source: 'saved-market-full-scan', reason: null,
  },
  polymarket: {
    status: 'fresh', observedAt: '2026-08-30T12:01:00.000Z',
    source: 'saved-market-quick-refresh', reason: null,
  },
};

describe('independent venue price freshness', () => {
  it('uses each successful venue observation timestamp independently', () => {
    expect(venuePriceFreshnessFromScan({
      _kalshiFetchedAt: '2026-08-30T12:02:00.000Z',
      _pmFetchedAt: '2026-08-30T12:03:00.000Z',
      platformDiagnostics: {
        kalshi: { status: 'fresh', count: 2 },
        polymarket: { status: 'fresh', count: 2 },
      },
    }, 'saved-market-quick-refresh')).toEqual({
      kalshi: {
        status: 'fresh', observedAt: '2026-08-30T12:02:00.000Z',
        source: 'saved-market-quick-refresh', reason: null,
      },
      polymarket: {
        status: 'fresh', observedAt: '2026-08-30T12:03:00.000Z',
        source: 'saved-market-quick-refresh', reason: null,
      },
    });
  });

  it.each([
    ['credentials_unavailable', 'Kalshi credentials unavailable'],
    ['rate_limited', 'Kalshi HTTP 429 rate limited'],
    ['failed', 'Kalshi HTTP 503'],
  ] as const)('preserves the failed venue timestamp and classifies %s independently', (status, reason) => {
    const next = mergeVenuePriceFreshness(previous, venuePriceFreshnessFromScan({
      _kalshiFetchedAt: '2026-08-30T12:05:00.000Z',
      _pmFetchedAt: '2026-08-30T12:06:00.000Z',
      platformDiagnostics: {
        kalshi: { status: 'failed', count: 0, reason },
        polymarket: { status: 'fresh', count: 2 },
      },
    }, 'saved-market-quick-refresh'));

    expect(next.kalshi).toEqual({ ...previous.kalshi, status, reason });
    expect(next.polymarket.observedAt).toBe('2026-08-30T12:06:00.000Z');
    expect(next.polymarket.status).toBe('fresh');
  });

  it('does not borrow the sibling timestamp when a venue has no trustworthy observation', () => {
    const next = venuePriceFreshnessFromScan({
      _pmFetchedAt: '2026-08-30T12:06:00.000Z',
      platformDiagnostics: {
        kalshi: { status: 'empty', count: 0, reason: 'No Kalshi markets returned' },
        polymarket: { status: 'fresh', count: 2 },
      },
    }, 'saved-market-quick-refresh');

    expect(next.kalshi).toEqual({
      status: 'unavailable', observedAt: null, source: null, reason: 'No Kalshi markets returned',
    });
    expect(next.polymarket.observedAt).toBe('2026-08-30T12:06:00.000Z');
  });

  it('reconciles persisted price rows with the latest per-venue refresh status after restart', () => {
    const cached = selectSavedMarketPriceCache({
      lastScanResult: {
        bestRoiPct: 1, bestProfit: 2, strategy: 'cached', outcomeCount: 1,
        matchedCount: 1, kalshiCount: 1, pmCount: 1, scannedAt: '2026-08-30T12:01:00.000Z',
        allArbs: [{ artist: 'Outcome', roiPct: 1, expectedProfit: 2, strategy: 'cached',
          kalshiTicker: 'KX-OUTCOME', kalshiYesAsk: 0.4, pmConditionId: 'pm-outcome', pmYesPrice: 0.5 }],
        venuePriceFreshness: previous,
      },
      liveResult: {
        bestRoiPct: 1, bestProfit: 2, strategy: 'cached', scannedAt: '2026-08-30T12:06:00.000Z',
        _kalshiFetchedAt: '2026-08-30T12:05:00.000Z', _pmFetchedAt: '2026-08-30T12:06:00.000Z',
        platformDiagnostics: {
          kalshi: { status: 'failed', count: 0, reason: 'Kalshi credentials unavailable' },
          polymarket: { status: 'fresh', count: 1 },
        },
      },
    });

    expect((cached as LastScanResult)?.allArbs?.[0].kalshiYesAsk).toBe(0.4);
    expect(cached?.venuePriceFreshness).toEqual({
      kalshi: { ...previous.kalshi, status: 'credentials_unavailable', reason: 'Kalshi credentials unavailable' },
      polymarket: {
        status: 'fresh', observedAt: '2026-08-30T12:06:00.000Z',
        source: 'saved-market-quick-refresh', reason: null,
      },
    });
  });

  it('uses the exact persisted quick-refresh freshness after restart instead of reconstructing a sibling timestamp', () => {
    const exactQuickRefresh: VenuePriceFreshnessMap = {
      kalshi: {
        status: 'credentials_unavailable', observedAt: null, source: null,
        reason: 'Kalshi credentials unavailable',
      },
      polymarket: {
        status: 'fresh', observedAt: '2026-08-30T12:05:17.000Z',
        source: 'saved-market-quick-refresh', reason: null,
      },
    };
    const cached = selectSavedMarketPriceCache({
      lastScanResult: {
        bestRoiPct: 1, bestProfit: 2, strategy: 'cached', outcomeCount: 1,
        matchedCount: 1, kalshiCount: 1, pmCount: 1, scannedAt: '2026-08-30T12:01:00.000Z',
        allArbs: [{ artist: 'Outcome', roiPct: 1, expectedProfit: 2, strategy: 'cached',
          kalshiTicker: 'KX-OUTCOME', kalshiYesAsk: 0.4, pmConditionId: 'pm-outcome', pmYesPrice: 0.5 }],
        venuePriceFreshness: previous,
      },
      liveResult: {
        bestRoiPct: 1, bestProfit: 2, strategy: 'cached', scannedAt: '2026-08-30T12:06:00.000Z',
        _kalshiFetchedAt: '2026-08-30T12:06:00.000Z',
        _pmFetchedAt: '2026-08-30T12:06:00.000Z',
        venuePriceFreshness: exactQuickRefresh,
        platformDiagnostics: {
          kalshi: { status: 'failed', count: 0, reason: 'Kalshi credentials unavailable' },
          polymarket: { status: 'fresh', count: 1 },
        },
      },
    });

    expect(cached?.venuePriceFreshness).toEqual({
      kalshi: { ...previous.kalshi, status: 'credentials_unavailable', reason: 'Kalshi credentials unavailable' },
      polymarket: exactQuickRefresh.polymarket,
    });
  });
});