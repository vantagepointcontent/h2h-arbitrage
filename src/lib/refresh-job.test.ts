import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  getSavedMarkets: vi.fn(),
  updateSavedMarketScanResult: vi.fn(),
  reconcileSavedMarketMatchSummary: vi.fn(),
  reserveSavedMarketPublication: vi.fn(),
  getManualMatches: vi.fn(),
  refreshSingleMarket: vi.fn(),
  persistAndConsumeBotScan: vi.fn(),
}));

vi.mock('fs', () => ({ promises: { readFile: mocks.readFile, writeFile: mocks.writeFile } }));
vi.mock('@/lib/persistence', () => ({
  getSavedMarkets: mocks.getSavedMarkets,
  updateSavedMarketScanResult: mocks.updateSavedMarketScanResult,
  reconcileSavedMarketMatchSummary: mocks.reconcileSavedMarketMatchSummary,
  reserveSavedMarketPublication: mocks.reserveSavedMarketPublication,
}));
vi.mock('@/lib/manual-matches', () => ({ getManualMatches: mocks.getManualMatches }));
vi.mock('@/app/api/saved-markets/refresh/refresh-single', () => ({
  refreshSingleMarket: mocks.refreshSingleMarket,
}));
vi.mock('@/lib/bot-scan-consumer', () => ({ persistAndConsumeBotScan: mocks.persistAndConsumeBotScan }));

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
  mocks.updateSavedMarketScanResult.mockResolvedValue(true);
  mocks.reconcileSavedMarketMatchSummary.mockResolvedValue(undefined);
  mocks.reserveSavedMarketPublication.mockResolvedValue(11);
  mocks.persistAndConsumeBotScan.mockResolvedValue({ id: 1, decision: null, backlogProcessed: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('refresh job timeout cancellation', () => {
  it('persists completed scheduled scans through the durable BotTrader consumer', async () => {
    mocks.getSavedMarkets.mockResolvedValue([markets[0]]);
    const outcomeApy = {
      apyPct: null,
      scenarioA: { settlementAt: '2027-01-04T15:00:00.000Z' },
      scenarioB: { settlementAt: '2026-11-03T00:00:00.000Z' },
    };
    mocks.refreshSingleMarket.mockResolvedValue({
      bestRoiPct: 3,
      bestProfit: 3,
      strategy: 'test',
      matchedCount: 1,
      kalshiCount: 1,
      pmCount: 1,
      scannedAt: new Date().toISOString(),
      allArbs: [{ artist: 'A', roiPct: 3, outcomeApy }],
      expiryDate: null,
    });

    await runRefreshJob();

    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenNthCalledWith(1, 'one', {
      matchedCount: 0,
      matchStatus: 'refreshing',
      matchError: undefined,
      matchedPairs: undefined,
      scannedAt: expect.any(String),
      publicationGeneration: 11,
    });
    expect(mocks.persistAndConsumeBotScan).toHaveBeenCalledWith(
      'one',
      expect.objectContaining({ positiveArbCount: 1, expiryAt: null, outcomeApy }),
      'scheduled',
    );
    expect(mocks.updateSavedMarketScanResult).toHaveBeenCalledWith(
      'one',
      expect.objectContaining({ publicationGeneration: 11 }),
      null,
    );
  });

  it('persists unavailable state and reason after a scheduled refresh failure', async () => {
    mocks.getSavedMarkets.mockResolvedValue([markets[0]]);
    mocks.refreshSingleMarket.mockRejectedValue(new Error('Polymarket timed out'));

    await runRefreshJob();

    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenNthCalledWith(1, 'one',
      expect.objectContaining({ matchStatus: 'refreshing', publicationGeneration: 11 }));
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenNthCalledWith(2, 'one', {
      matchedCount: 0,
      matchStatus: 'unavailable',
      matchError: 'Polymarket timed out',
      matchedPairs: undefined,
      scannedAt: expect.any(String),
      publicationGeneration: 11,
    });
    expect(mocks.updateSavedMarketScanResult).not.toHaveBeenCalled();
  });

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
    let resolveRefresh!: (value: unknown) => void;
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
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenLastCalledWith('one', {
      matchedCount: 0,
      matchStatus: 'unavailable',
      matchError: 'Scheduled refresh timed out',
      matchedPairs: undefined,
      scannedAt: expect.any(String),
      publicationGeneration: 11,
    });
    const finalState = JSON.parse(mocks.writeFile.mock.calls.at(-1)![1]);
    expect(finalState.running).toBe(false);
    expect(finalState.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '__timeout__' }),
    ]));
  });
});
