import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  quickPricesScan: vi.fn(),
  reconcileSavedMarketMatchSummary: vi.fn(),
  reserveSavedMarketPublication: vi.fn(),
  persistPlatformPriceSnapshots: vi.fn(),
  snapshotInputsFromOutcomes: vi.fn(),
  consume: vi.fn(() => ({ allowed: true })),
}));

vi.mock('@/lib/quick-prices', () => ({ quickPricesScan: mocks.quickPricesScan }));
vi.mock('@/lib/persistence', () => ({
  reconcileSavedMarketLiveSummary: mocks.reconcileSavedMarketMatchSummary,
  reserveSavedMarketPublication: mocks.reserveSavedMarketPublication,
}));
vi.mock('@/lib/current-price-snapshots', () => ({
  persistPlatformPriceSnapshots: mocks.persistPlatformPriceSnapshots,
  snapshotInputsFromOutcomes: mocks.snapshotInputsFromOutcomes,
}));
vi.mock('@/lib/scan-rate-limit', () => ({
  scanRateLimiter: { consume: mocks.consume },
  getScanClientKey: () => 'test',
}));

import { POST } from './route';

function quickRequest(marketId = 'nc-14', capital = 1000) {
  return new NextRequest('http://localhost/api/quick-prices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ marketId, capital }),
  });
}

describe('POST /api/quick-prices diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reserveSavedMarketPublication.mockResolvedValue(7);
    mocks.reconcileSavedMarketMatchSummary.mockResolvedValue(undefined);
    mocks.persistPlatformPriceSnapshots.mockResolvedValue({ attempted: 0, applied: 0 });
    mocks.snapshotInputsFromOutcomes.mockImplementation((
      _outcomes: unknown[], _observedAt: unknown, _source: unknown,
      publication: { attemptedAt: string; generation: number; scope: string },
    ) => [{ platform: 'kalshi', marketId: 'KX-TEST', ...publication }]);
  });

  it('deduplicates repeated clicks before reserving or fetching the same refresh', async () => {
    let release!: (value: Record<string, unknown>) => void;
    mocks.quickPricesScan.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const first = POST(quickRequest('mlb-steals'));
    await vi.waitFor(() => expect(mocks.quickPricesScan).toHaveBeenCalledTimes(1));
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenNthCalledWith(1, 'mlb-steals', expect.objectContaining({
      matchStatus: 'refreshing',
      refreshLifecycle: {
        requestedAt: expect.any(String), structureFetchedAt: null, completedAt: null,
      },
    }));
    const repeated = POST(quickRequest('mlb-steals'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release({
      matchedCount: 1,
      matchStatus: 'matched',
      matchedPairs: [{ artist: 'Aaron Judge', kalshiTicker: 'KX-JUDGE', pmConditionId: 'pm-judge' }],
      refreshStatus: 'complete',
      retryable: false,
      platformWarnings: [],
      platformDiagnostics: {
        kalshi: { status: 'fresh', count: 1 },
        polymarket: { status: 'fresh', count: 1 },
      },
      outcomes: [{ artist: 'Aaron Judge' }],
      _pmFetchedAt: '2026-08-14T09:45:00.000Z',
    });

    const [firstResponse, repeatedResponse] = await Promise.all([first, repeated]);
    expect(firstResponse.status).toBe(200);
    expect(repeatedResponse.status).toBe(200);
    expect(mocks.quickPricesScan).toHaveBeenCalledTimes(1);
    expect(mocks.reserveSavedMarketPublication).toHaveBeenCalledTimes(1);
    expect(mocks.reserveSavedMarketPublication).toHaveBeenCalledWith('mlb-steals', 'live');
    expect(repeatedResponse.headers.get('x-quick-prices-deduplicated')).toBe('true');
  });

  it('carries request-start publication order across overlapping capital refreshes', async () => {
    let releaseOlder!: (value: Record<string, unknown>) => void;
    let releaseNewer!: (value: Record<string, unknown>) => void;
    mocks.reserveSavedMarketPublication
      .mockResolvedValueOnce(11)
      .mockResolvedValueOnce(12);
    mocks.quickPricesScan
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseNewer = resolve; }));
    const result = (observedAt: string) => ({
      matchedCount: 1, matchStatus: 'matched', matchedPairs: [],
      refreshStatus: 'complete', retryable: false, platformWarnings: [],
      platformDiagnostics: {
        kalshi: { status: 'fresh', count: 1 }, polymarket: { status: 'fresh', count: 1 },
      },
      outcomes: [{ artist: 'Matched outcome' }],
      pmRefresh: { outcomes: [] },
      _kalshiFetchedAt: observedAt, _pmFetchedAt: observedAt,
    });

    const older = POST(quickRequest('overlap-market', 1000));
    await vi.waitFor(() => expect(mocks.quickPricesScan).toHaveBeenCalledTimes(1));
    const newer = POST(quickRequest('overlap-market', 2000));
    await vi.waitFor(() => expect(mocks.quickPricesScan).toHaveBeenCalledTimes(2));
    releaseNewer(result('2026-08-17T12:01:00.000Z'));
    await newer;
    releaseOlder(result('2026-08-17T12:02:00.000Z'));
    await older;

    expect(mocks.snapshotInputsFromOutcomes).toHaveBeenNthCalledWith(
      1, expect.any(Array), expect.any(Object), 'saved-market-quick-refresh',
      expect.objectContaining({ attemptedAt: expect.any(String), generation: 12, scope: 'overlap-market' }),
    );
    expect(mocks.snapshotInputsFromOutcomes).toHaveBeenNthCalledWith(
      2, expect.any(Array), expect.any(Object), 'saved-market-quick-refresh',
      expect.objectContaining({ attemptedAt: expect.any(String), generation: 11, scope: 'overlap-market' }),
    );
  });

  it('returns live prices even when the optional publication reservation hits SQLITE_BUSY', async () => {
    const busy = Object.assign(new Error('SQLITE_BUSY: database is locked'), {
      name: 'LibsqlError', code: 'SQLITE_BUSY',
    });
    mocks.reserveSavedMarketPublication.mockRejectedValue(busy);
    mocks.quickPricesScan.mockResolvedValue({
      matchedCount: 1, matchStatus: 'matched', refreshStatus: 'complete', retryable: false,
      matchedPairs: [{ artist: 'Democratic', kalshiTicker: 'NC14-D', pmConditionId: 'pm-d' }],
      platformWarnings: [],
      platformDiagnostics: {
        kalshi: { status: 'fresh', count: 1 },
        polymarket: { status: 'fresh', count: 1 },
      },
      outcomes: [{ artist: 'Democratic' }],
      _pmFetchedAt: '2026-08-13T18:30:00.000Z',
    });
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'quick-busy-cid' },
      body: JSON.stringify({ marketId: 'nc-14', capital: 1000 }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.quickPricesScan).toHaveBeenCalledWith('nc-14', 1000);
    expect(body.outcomes).toEqual([{ artist: 'Democratic' }]);
    expect(body.persistenceWarning).toContain('temporarily unavailable');
  });

  it('returns a retryable 503 with per-platform reasons when neither linked event refreshes', async () => {
    mocks.quickPricesScan.mockResolvedValue({
      matchedCount: 0, matchStatus: 'unavailable', matchedPairs: [],
      matchError: 'Both linked venues failed.', refreshStatus: 'failed', retryable: true,
      platformWarnings: ['Kalshi request failed.', 'Polymarket request failed.'],
      platformDiagnostics: {
        kalshi: { status: 'failed', count: 0, reason: 'Kalshi request failed.' },
        polymarket: { status: 'failed', count: 0, reason: 'Polymarket request failed.' },
      },
      outcomes: [], _pmFetchedAt: '2026-08-13T18:30:00.000Z',
    });
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marketId: 'nc-14', capital: 1000 }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(body.retryable).toBe(true);
    expect(body.platformDiagnostics.kalshi.status).toBe('failed');
    expect(body.platformDiagnostics.polymarket.reason).toBe('Polymarket request failed.');
  });

  it('returns partial linked-event data without discarding the successful platform', async () => {
    mocks.snapshotInputsFromOutcomes.mockReturnValueOnce([{
      platform: 'polymarket', marketId: 'pm-democratic', side: 'yes', tokenId: 'pm-democratic-yes',
      priceCents: 20, priceMicrocents: 20_000_000, observedAt: '2026-08-13T18:30:00.000Z',
      source: 'saved-market-quick-refresh',
    }]);
    mocks.quickPricesScan.mockResolvedValue({
      matchedCount: 0, matchStatus: 'unavailable', matchedPairs: [],
      refreshStatus: 'partial', retryable: true, platformWarnings: ['Kalshi request failed.'],
      platformDiagnostics: {
        kalshi: { status: 'failed', count: 0, reason: 'Kalshi request failed.' },
        polymarket: { status: 'fresh', count: 1 },
      },
      outcomes: [{
        artist: 'Democratic', kalshi: null,
        polymarket: {
          conditionId: 'pm-democratic', yesTokenId: 'pm-democratic-yes', noTokenId: 'pm-democratic-no',
          yesPrice: 0.2, noPrice: 0.8,
        },
      }],
      _kalshiFetchedAt: '2026-08-13T18:29:59.000Z',
      _pmFetchedAt: '2026-08-13T18:30:00.000Z',
      _priceDataObservedAt: '2026-08-13T18:30:00.000Z',
      refreshLifecycle: {
        requestedAt: '2026-08-13T18:29:58.000Z', structureFetchedAt: '2026-08-13T18:29:59.000Z',
        completedAt: '2026-08-13T18:30:01.000Z',
      },
    });
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marketId: 'nc-14', capital: 1000 }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(207);
    expect(body.outcomes[0].polymarket.yesPrice).toBe(0.2);
    expect(body.platformDiagnostics.kalshi.status).toBe('failed');
    expect(body.venuePriceFreshness).toEqual({
      kalshi: {
        status: 'failed', observedAt: null, source: null, reason: 'Kalshi request failed.',
      },
      polymarket: {
        status: 'fresh', observedAt: '2026-08-13T18:30:00.000Z',
        source: 'saved-market-quick-refresh', reason: null,
      },
    });
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenLastCalledWith('nc-14', expect.objectContaining({
      refreshStatus: 'partial',
      scannedAt: body.refreshLifecycle.completedAt,
      refreshLifecycle: body.refreshLifecycle,
      platformDiagnostics: body.platformDiagnostics,
      _kalshiFetchedAt: '2026-08-13T18:29:59.000Z',
      _pmFetchedAt: '2026-08-13T18:30:00.000Z',
      _priceDataObservedAt: '2026-08-13T18:30:00.000Z',
      venuePriceFreshness: body.venuePriceFreshness,
    }));
  });

  it('atomically reconciles canonical pair ids before returning a successful detail refresh', async () => {
    const result = {
      matchedCount: 2,
      matchStatus: 'matched',
      matchedPairs: [
        { artist: 'Democratic', kalshiTicker: 'TX07-D', pmConditionId: 'pm-d' },
        { artist: 'Republican', kalshiTicker: 'TX07-R', pmConditionId: 'pm-r' },
      ],
      _pmFetchedAt: '2026-08-12T19:49:14.096Z',
    };
    mocks.quickPricesScan.mockResolvedValue(result);
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marketId: 'tx-07', capital: 1000 }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenNthCalledWith(1, 'tx-07', {
      matchedCount: 0,
      matchStatus: 'refreshing',
      matchError: undefined,
      matchedPairs: undefined,
      scannedAt: expect.any(String),
      publicationGeneration: 7,
      refreshLifecycle: {
        requestedAt: expect.any(String), structureFetchedAt: null, completedAt: null,
      },
    });
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenNthCalledWith(2, 'tx-07', {
      matchedCount: 2,
      matchStatus: 'matched',
      matchError: undefined,
      matchedPairs: result.matchedPairs,
      scannedAt: result._pmFetchedAt,
      publicationGeneration: 7,
      _pmFetchedAt: result._pmFetchedAt,
      venuePriceFreshness: {
        kalshi: {
          status: 'not_scanned', observedAt: null, source: null,
          reason: 'No Kalshi price snapshot has been recorded',
        },
        polymarket: {
          status: 'not_scanned', observedAt: null, source: null,
          reason: 'No Polymarket price snapshot has been recorded',
        },
      },
    });
  });

  it('returns an actionable failure with the request correlation ID', async () => {
    mocks.quickPricesScan.mockRejectedValue(new Error('unexpected internal failure'));
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'quick-test-cid' },
      body: JSON.stringify({ marketId: 'saved-1', capital: 1000 }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get('x-correlation-id')).toBe('quick-test-cid');
    expect(body.error).toMatch(/^Saved-market price refresh failed \(Error, ref: [a-f0-9]{16}\/quick-test-cid\)$/);
    expect(body.error).not.toContain('Unknown error');
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenLastCalledWith('saved-1', {
      matchedCount: 0,
      matchStatus: 'unavailable',
      matchError: body.error,
      matchedPairs: undefined,
      scannedAt: expect.any(String),
      publicationGeneration: 7,
      refreshStatus: 'failed',
      refreshLifecycle: {
        requestedAt: expect.any(String), structureFetchedAt: null, completedAt: expect.any(String),
      },
    });
  });

  it('returns an actionable missing saved-market response with diagnostics', async () => {
    const error = Object.assign(new Error('Market not found'), { status: 404 });
    mocks.quickPricesScan.mockRejectedValue(error);
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'quick-missing-cid' },
      body: JSON.stringify({ marketId: 'deleted-market', capital: 1000 }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(response.headers.get('x-correlation-id')).toBe('quick-missing-cid');
    expect(body.error).toMatch(
      /^Saved market not found\. It may have been removed; return to Markets and select it again\. \(Error, ref: [a-f0-9]{16}\/quick-missing-cid\)$/,
    );
    expect(body.error).not.toContain('Saved-market price refresh failed');
  });

  it('returns an actionable invalid Kalshi-link response with diagnostics', async () => {
    const error = Object.assign(new Error('A valid Kalshi market link is required.'), { status: 400 });
    mocks.quickPricesScan.mockRejectedValue(error);
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'quick-kalshi-link-cid' },
      body: JSON.stringify({ marketId: 'stale-kalshi-link', capital: 1000 }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get('x-correlation-id')).toBe('quick-kalshi-link-cid');
    expect(body.error).toMatch(
      /^Saved market has an invalid Kalshi link\. Return to Markets and update or re-add this saved market\. \(Error, ref: [a-f0-9]{16}\/quick-kalshi-link-cid\)$/,
    );
    expect(body.error).not.toContain('Saved-market price refresh failed');
  });

  it('returns an actionable invalid Polymarket-link response with diagnostics', async () => {
    const error = Object.assign(new Error('A valid Polymarket market link is required.'), { status: 400 });
    mocks.quickPricesScan.mockRejectedValue(error);
    const request = new NextRequest('http://localhost/api/quick-prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'quick-pm-link-cid' },
      body: JSON.stringify({ marketId: 'stale-pm-link', capital: 1000 }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get('x-correlation-id')).toBe('quick-pm-link-cid');
    expect(body.error).toMatch(
      /^Saved market has an invalid Polymarket link\. Return to Markets and update or re-add this saved market\. \(Error, ref: [a-f0-9]{16}\/quick-pm-link-cid\)$/,
    );
    expect(body.error).not.toContain('Saved-market price refresh failed');
  });
});
