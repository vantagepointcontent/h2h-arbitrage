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
}));
vi.mock('fs/promises', () => ({ default: { readFile: mocks.readFile } }));

import { POST } from './route';

describe('POST /api/saved-markets/list-refresh', () => {
  beforeEach(() => {
    vi.stubEnv('H2H_API_TOKEN', 'list-secret');
    mocks.reconcileSavedMarketMatchSummaries.mockResolvedValue(0);
    mocks.readFile.mockResolvedValue(JSON.stringify({
      'market-1': { lastSuccessAt: '2026-08-19T14:55:00.000Z', inProgress: false },
    }));
    mocks.getSavedMarkets.mockResolvedValue([{
      id: 'market-1', eventTitle: 'Market 1', kalshiUrl: 'k', polymarketUrl: 'p',
      createdAt: '2026-08-01T00:00:00.000Z', expiryDate: '2026-09-01T00:00:00.000Z',
      canonicalApyPct: 18.2, canonicalApyObservedAt: '2026-08-19T14:50:00.000Z',
      canonicalApySource: 'full_scan', canonicalApyRevision: 7,
      canonicalCurrentRoiPct: 2.5, canonicalCurrentProfit: 5,
      canonicalCurrentRoiStatus: 'available', canonicalCurrentRoiUnavailableReason: null,
      canonicalCurrentProfitStatus: 'available', canonicalCurrentProfitUnavailableReason: null,
      canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
      canonicalCurrentDaysToExpiry: 365 * Math.log(1.025) / Math.log(1.182),
      canonicalCurrentExpiryAt: '2026-09-01T00:00:00.000Z', canonicalCurrentRevision: 7,
      lastScanResult: {
        bestRoiPct: 2.5, bestProfit: 5, strategy: 'arb', scannedAt: '2026-08-19T14:50:00.000Z',
        matchedCount: 1, matchStatus: 'matched', allArbs: [{ artist: 'Yes', roiPct: 2.5, expectedProfit: 5, strategy: 'arb', apyPct: 18.2 }],
      },
    }]);
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it('rejects a missing internal credential without reading persistence', async () => {
    const response = await POST(new NextRequest('http://localhost/api/saved-markets/list-refresh', { method: 'POST' }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    expect(mocks.getSavedMarkets).not.toHaveBeenCalled();
  });

  it('reads canonical persistence plus scheduler state without venue calls', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await POST(new NextRequest('http://localhost/api/saved-markets/list-refresh', {
      method: 'POST', headers: { 'x-h2h-token': 'list-secret' },
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      source: 'persisted-saved-markets', revision: expect.stringMatching(/^[a-f0-9]{40}$/), observedAt: expect.any(String),
      markets: [{
        id: 'market-1', canonicalApyPct: 18.2, canonicalApySource: 'full_scan', canonicalApyRevision: 7,
        canonicalCurrentRoiPct: 2.5, canonicalCurrentProfit: 5,
        canonicalCurrentRoiStatus: 'available', canonicalCurrentRoiUnavailableReason: null,
        canonicalCurrentProfitStatus: 'available', canonicalCurrentProfitUnavailableReason: null,
        canonicalCurrentStrategy: 'Buy YES Kalshi + NO PM',
        canonicalCurrentDaysToExpiry: 365 * Math.log(1.025) / Math.log(1.182),
        canonicalCurrentExpiryAt: '2026-09-01T00:00:00.000Z', canonicalCurrentRevision: 7,
        scheduler: { lastSuccessAt: '2026-08-19T14:55:00.000Z', inProgress: false },
        lastScanResult: { bestRoiPct: 2.5, scannedAt: '2026-08-19T14:50:00.000Z' },
      }],
    });
    expect(mocks.getSavedMarkets).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed instead of returning an APY-only current projection', async () => {
    mocks.getSavedMarkets.mockResolvedValueOnce([{
      id: 'market-1', eventTitle: 'Market 1', kalshiUrl: 'k', polymarketUrl: 'p',
      createdAt: '2026-08-01T00:00:00.000Z', expiryDate: '2026-09-01T00:00:00.000Z',
      canonicalApyPct: 18.2, canonicalApyObservedAt: '2026-08-19T14:50:00.000Z',
      canonicalApySource: 'full_scan', canonicalApyRevision: 7,
      canonicalCurrentRoiPct: null, canonicalCurrentProfit: null,
      canonicalCurrentStrategy: 'No arb', canonicalCurrentDaysToExpiry: null,
      canonicalCurrentExpiryAt: null, canonicalCurrentRevision: 7,
    }]);

    const response = await POST(new NextRequest('http://localhost/api/saved-markets/list-refresh', {
      method: 'POST', headers: { 'x-h2h-token': 'list-secret' },
    }));

    await expect(response.json()).resolves.toMatchObject({
      markets: [{
        canonicalApyPct: null,
        canonicalApyUnavailableReason: 'current_metric_invariant_failed',
        canonicalCurrentRoiPct: null,
        canonicalCurrentStrategy: 'No arb',
        canonicalCurrentRevision: 7,
      }],
    });
  });
});
