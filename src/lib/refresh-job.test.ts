import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  getSavedMarkets: vi.fn(),
  updateSavedMarketScanResult: vi.fn(),
  getManualMatches: vi.fn(),
  refreshSingleMarket: vi.fn(),
}));

vi.mock('fs', () => ({ promises: { readFile: mocks.readFile, writeFile: mocks.writeFile } }));
vi.mock('@/lib/persistence', () => ({
  getSavedMarkets: mocks.getSavedMarkets,
  updateSavedMarketScanResult: mocks.updateSavedMarketScanResult,
}));
vi.mock('@/lib/manual-matches', () => ({ getManualMatches: mocks.getManualMatches }));
vi.mock('@/app/api/saved-markets/refresh/refresh-single', () => ({
  refreshSingleMarket: mocks.refreshSingleMarket,
}));

import { getRefreshStatus, runRefreshJob } from './refresh-job';

const markets = [
  { id: 'one', eventTitle: 'One', expiryDate: null },
  { id: 'two', eventTitle: 'Two', expiryDate: null },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('H2H_REFRESH_CONCURRENCY', '1');
  vi.stubEnv('H2H_REFRESH_TIMEOUT_MS', '60000');
  mocks.readFile.mockRejectedValue(new Error('missing'));
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.getSavedMarkets.mockResolvedValue(markets);
  mocks.getManualMatches.mockResolvedValue([]);
  mocks.updateSavedMarketScanResult.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('refresh job timeout cancellation', () => {
  it('recovers a persisted running state left behind by a stopped process', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({
      running: true,
      startedAt: '2000-01-01T00:00:00.000Z',
      total: 10,
      processed: 2,
      succeeded: 2,
      failed: 0,
      currentMarketId: 'stale-market',
      errors: [],
    }));

    const status = await getRefreshStatus();

    expect(status.running).toBe(false);
    expect(status.currentMarketId).toBeUndefined();
    expect(status.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '__stale__' }),
    ]));
    expect(mocks.writeFile).toHaveBeenCalledOnce();
  });

  it('keeps ownership until workers drain and blocks post-timeout persistence', async () => {
    let resolveRefresh!: (value: any) => void;
    mocks.refreshSingleMarket.mockImplementation(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    let settled = false;
    const job = runRefreshJob().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(settled).toBe(false);
    expect(mocks.refreshSingleMarket).toHaveBeenCalledTimes(1);

    resolveRefresh({
      bestRoiPct: 1,
      bestProfit: 1,
      strategy: 'test',
      matchedCount: 1,
      kalshiCount: 1,
      pmCount: 1,
      scannedAt: new Date().toISOString(),
      allArbs: [],
      expiryDate: null,
    });
    await job;

    expect(mocks.refreshSingleMarket).toHaveBeenCalledTimes(1);
    expect(mocks.updateSavedMarketScanResult).not.toHaveBeenCalled();
    const finalState = JSON.parse(mocks.writeFile.mock.calls.at(-1)![1]);
    expect(finalState.running).toBe(false);
    expect(finalState.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '__timeout__' }),
    ]));
  });
});
