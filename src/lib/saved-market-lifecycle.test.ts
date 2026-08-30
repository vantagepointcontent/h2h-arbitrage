import { describe, expect, it } from 'vitest';
import { buildSavedMarketLifecycle, formatSavedMarketLifecycleSummary } from './saved-market-lifecycle';

const now = Date.parse('2026-08-30T17:00:00.000Z');
const successfulScan = {
  matchStatus: 'matched' as const,
  scannedAt: '2026-08-30T16:00:00.000Z',
  publicationGeneration: 10,
  matchedCount: 2,
  allArbs: [{ artist: 'A' }],
};

describe('BUG-859 canonical saved-market lifecycle', () => {
  it('formats cached failures and partial refreshes as explicit combined states', () => {
    const cachedFailure = buildSavedMarketLifecycle({
      scheduler: {
        lastAttemptAt: '2026-08-30T16:50:00.000Z', lastSuccessAt: '2026-08-30T16:00:00.000Z',
        failureReason: 'HTTP 503 (DISK_CAPACITY)', freshnessSlaMs: 3_600_000,
      },
      lastScanResult: successfulScan, liveResult: null,
    }, now);
    expect(formatSavedMarketLifecycleSummary(cachedFailure, now)).toEqual({
      label: 'Last scan failed · showing data from 1h ago', reason: 'HTTP 503 (DISK_CAPACITY)',
    });

    const partial = buildSavedMarketLifecycle({
      scheduler: {
        lastAttemptAt: '2026-08-30T16:50:00.000Z', lastSuccessAt: '2026-08-30T16:00:00.000Z',
        failureReason: 'Kalshi credentials unavailable',
      },
      lastScanResult: successfulScan,
      liveResult: {
        matchStatus: 'unavailable', scannedAt: '2026-08-30T16:55:00.000Z', refreshStatus: 'partial',
        refreshLifecycle: { requestedAt: '2026-08-30T16:54:58.000Z', structureFetchedAt: null, completedAt: '2026-08-30T16:55:00.000Z' },
        _priceDataObservedAt: '2026-08-30T16:54:59.000Z',
        platformDiagnostics: {
          kalshi: { status: 'failed', count: 0, reason: 'Kalshi credentials unavailable' },
          polymarket: { status: 'fresh', count: 4 },
        },
      },
    }, now);
    expect(formatSavedMarketLifecycleSummary(partial, now)).toEqual({
      label: 'Partial refresh · last scan credentials unavailable · showing data from 5m ago',
      reason: 'Kalshi credentials unavailable',
    });
  });

  it('describes a failed scheduled full scan together with available cached data', () => {
    expect(buildSavedMarketLifecycle({
      scheduler: {
        lastAttemptAt: '2026-08-30T16:50:00.000Z',
        lastSuccessAt: '2026-08-30T16:00:00.000Z',
        failureReason: 'HTTP 503 (DISK_CAPACITY)',
        freshnessSlaMs: 3_600_000,
      },
      lastScanResult: successfulScan,
      liveResult: null,
      canonicalApyObservedAt: '2026-08-30T16:00:00.000Z',
    }, now)).toMatchObject({
      overallStatus: 'failed',
      fullScan: { status: 'failed', reason: 'HTTP 503 (DISK_CAPACITY)' },
      manualRefresh: { status: 'not_refreshed' },
      cachedData: { status: 'available', observedAt: '2026-08-30T16:00:00.000Z' },
    });
  });

  it('keeps a scheduled failure while recording one-venue manual refresh as partial', () => {
    expect(buildSavedMarketLifecycle({
      scheduler: {
        lastAttemptAt: '2026-08-30T16:50:00.000Z',
        lastSuccessAt: '2026-08-30T16:00:00.000Z',
        failureReason: 'Kalshi credentials unavailable',
      },
      lastScanResult: successfulScan,
      liveResult: {
        matchStatus: 'unavailable',
        scannedAt: '2026-08-30T16:55:00.000Z',
        refreshStatus: 'partial',
        refreshLifecycle: {
          requestedAt: '2026-08-30T16:54:58.000Z',
          structureFetchedAt: '2026-08-30T16:54:59.000Z',
          completedAt: '2026-08-30T16:55:00.000Z',
        },
        _priceDataObservedAt: '2026-08-30T16:54:59.000Z',
        platformDiagnostics: {
          kalshi: { status: 'failed', count: 0, reason: 'Kalshi credentials unavailable' },
          polymarket: { status: 'fresh', count: 4 },
        },
      },
    }, now)).toMatchObject({
      overallStatus: 'partial',
      fullScan: { status: 'credentials_unavailable' },
      manualRefresh: { status: 'partial' },
      venues: {
        kalshi: { status: 'credentials_unavailable' },
        polymarket: { status: 'fresh', observedAt: '2026-08-30T16:54:59.000Z' },
      },
      cachedData: { status: 'available' },
    });
  });

  it('describes a complete manual refresh without clearing a failed full scan', () => {
    const lifecycle = buildSavedMarketLifecycle({
      scheduler: {
        lastAttemptAt: '2026-08-30T16:50:00.000Z',
        lastSuccessAt: '2026-08-30T16:00:00.000Z',
        failureReason: 'Kalshi HTTP 503',
      },
      lastScanResult: successfulScan,
      liveResult: {
        matchStatus: 'matched', scannedAt: '2026-08-30T16:55:00.000Z', refreshStatus: 'complete',
        refreshLifecycle: {
          requestedAt: '2026-08-30T16:54:58.000Z', structureFetchedAt: '2026-08-30T16:54:59.000Z',
          completedAt: '2026-08-30T16:55:00.000Z',
        },
        _priceDataObservedAt: '2026-08-30T16:54:59.000Z',
        platformDiagnostics: {
          kalshi: { status: 'fresh', count: 2 }, polymarket: { status: 'fresh', count: 2 },
        },
      },
    }, now);

    expect(lifecycle).toMatchObject({
      overallStatus: 'partial',
      fullScan: { status: 'failed' },
      manualRefresh: { status: 'fresh' },
    });
    expect(formatSavedMarketLifecycleSummary(lifecycle, now)).toEqual({
      label: 'Prices refreshed · last scan failed · showing data from 5m ago',
      reason: 'Kalshi HTTP 503',
    });
  });

  it('lets a later successful full scan clear an older scheduler failure', () => {
    expect(buildSavedMarketLifecycle({
      scheduler: {
        lastAttemptAt: '2026-08-30T16:10:00.000Z',
        lastSuccessAt: '2026-08-30T16:00:00.000Z',
        failureReason: 'HTTP 503',
        freshnessSlaMs: 3_600_000,
      },
      lastScanResult: { ...successfulScan, scannedAt: '2026-08-30T16:45:00.000Z', publicationGeneration: 11 },
      liveResult: null,
    }, now)).toMatchObject({
      overallStatus: 'fresh',
      fullScan: { status: 'fresh', lastSuccessAt: '2026-08-30T16:45:00.000Z', reason: null },
      cachedData: { status: 'available', observedAt: '2026-08-30T16:45:00.000Z' },
    });
  });

  it('marks retained manual refresh data stale without collapsing it to unavailable', () => {
    expect(buildSavedMarketLifecycle({
      scheduler: null,
      lastScanResult: successfulScan,
      liveResult: {
        matchStatus: 'matched',
        scannedAt: '2026-08-30T16:40:00.000Z',
        refreshStatus: 'complete',
        refreshLifecycle: {
          requestedAt: '2026-08-30T16:39:58.000Z', structureFetchedAt: null,
          completedAt: '2026-08-30T16:40:00.000Z',
        },
        _priceDataObservedAt: '2026-08-30T16:39:59.000Z',
        platformDiagnostics: {
          kalshi: { status: 'fresh', count: 2 }, polymarket: { status: 'fresh', count: 2 },
        },
      },
    }, now, { manualFreshnessMs: 10 * 60_000 })).toMatchObject({
      overallStatus: 'stale',
      manualRefresh: { status: 'stale' },
      cachedData: { status: 'available', observedAt: '2026-08-30T16:39:59.000Z' },
      venues: { kalshi: { status: 'stale' }, polymarket: { status: 'stale' } },
    });
  });
});
