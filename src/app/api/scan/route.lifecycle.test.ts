import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { executableEnvelopeFixture } from '@/lib/test-fixtures/calculation-envelope';

const mocks = vi.hoisted(() => ({
  upstream: vi.fn(),
  calculateAllArbitrages: vi.fn((): unknown[] => []),
  appendScanHistory: vi.fn(async () => undefined),
  findSavedMarketByUrls: vi.fn(),
  persistAndConsumeBotScan: vi.fn(async () => undefined),
  reserveSavedMarketPublication: vi.fn(),
  reconcileSavedMarketMatchSummary: vi.fn(),
  acquireSavedMarketScanLock: vi.fn(),
  releaseSavedMarketScanLock: vi.fn(async () => undefined),
}));

vi.mock('@/lib/kalshi', () => ({
  extractKalshiEventTicker: () => 'KXTX07',
  extractKalshiSeriesFromUrl: () => null,
  extractKalshiMatchKey: () => null,
  filterKalshiMarketsToMatch: (markets: unknown[]) => markets,
  fetchKalshiEventMarkets: mocks.upstream,
  fetchKalshiSeriesMarkets: vi.fn(async () => []),
  fetchKalshiMultiSeriesMarkets: vi.fn(async () => ({ markets: [], seriesFetched: [] })),
}));
vi.mock('@/lib/polymarket', () => ({
  extractPolymarketSlug: () => 'tx-07',
  fetchPolymarketEvent: vi.fn(async () => ({ id: 'pm-event', title: 'TX-07', markets: [], active: true })),
  fetchPolymarketMarketAsEvent: vi.fn(),
  isPolymarketMarketUrl: () => false,
  parseOutcomePrices: () => [0, 0],
}));
vi.mock('@/lib/polymarket-clob', () => ({
  fetchClobMarkets: vi.fn(async () => new Map()),
  getClobAskDepths: vi.fn(),
  getClobPrices: vi.fn(),
}));
vi.mock('@/lib/matcher', () => ({
  buildKalshiArbShape: vi.fn(),
  matchOutcomes: () => [],
  calculateAllArbitrages: mocks.calculateAllArbitrages,
  attachOutcomeContingentApy: (outcomes: unknown[]) => outcomes,
  parseDepth: vi.fn(),
  computeApy: () => 0,
  applyManualMatches: (outcomes: unknown[]) => outcomes,
  setSuspiciousRoiPct: vi.fn(),
}));
vi.mock('@/lib/settings', () => ({ getSetting: vi.fn(async () => null) }));
vi.mock('@/lib/manual-matches', () => ({ getManualMatches: vi.fn(async () => []) }));
vi.mock('@/lib/decoupled-pairs', () => ({
  getDecoupledPairs: vi.fn(async () => []),
  applyDecoupledPairs: (outcomes: unknown[]) => outcomes,
}));
vi.mock('@/lib/persistence', () => ({
  findSavedMarketByUrls: mocks.findSavedMarketByUrls,
  reserveSavedMarketPublication: mocks.reserveSavedMarketPublication,
  reconcileSavedMarketMatchSummary: mocks.reconcileSavedMarketMatchSummary,
  updateSavedMarketScanResult: vi.fn(async () => true),
  appendScanHistory: mocks.appendScanHistory,
}));
vi.mock('@/lib/bot-scan-consumer', () => ({ persistAndConsumeBotScan: mocks.persistAndConsumeBotScan }));
vi.mock('@/lib/arb-lifecycle', () => ({ recordArbObservations: vi.fn(async () => ({ opened: 0, extended: 0, closed: 0 })) }));
vi.mock('@/lib/telegram-alerts', () => ({ sendBatchAlerts: vi.fn(async () => undefined) }));
vi.mock('@/lib/saved-market-scan-lock', () => ({
  acquireSavedMarketScanLock: mocks.acquireSavedMarketScanLock,
  releaseSavedMarketScanLock: mocks.releaseSavedMarketScanLock,
}));
vi.mock('@/lib/scan-shared', () => ({
  withTimeout: (promise: Promise<unknown>) => promise,
  chooseBestPmStructure: (markets: unknown[]) => markets,
}));
vi.mock('@/app/lib/page-shared', () => ({ computePriceResolved: () => false }));
vi.mock('@/lib/scan-links', () => ({
  resolveScanLinks: () => ({
    platformLinks: {},
    kalshiUrl: 'https://kalshi.com/markets/tx/tx/KXTX07',
    polymarketUrl: 'https://polymarket.com/event/tx-07',
  }),
  getUnavailableScanPlatforms: () => [],
}));
vi.mock('@/lib/scan-request', () => ({ parseScanCapital: () => 1000 }));
vi.mock('@/lib/scan-clob-selection', () => ({ selectMatchedClobConditionIds: () => [] }));

import { executeFullScan } from './scan-execution';

function request(): NextRequest {
  return new NextRequest('http://localhost/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capital: 1000 }),
  });
}

describe('POST /api/scan saved-market lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upstream.mockReset();
    mocks.upstream.mockResolvedValue([]);
    mocks.appendScanHistory.mockReset();
    mocks.appendScanHistory.mockResolvedValue(undefined);
    mocks.acquireSavedMarketScanLock.mockResolvedValue({
      status: 'acquired',
      lock: { path: '/tmp/test-lock', ownerPid: 1, ownerToken: 'test' },
    });
    mocks.findSavedMarketByUrls.mockResolvedValue({ id: 'tx-07', eventTitle: 'TX-07' });
    mocks.reserveSavedMarketPublication.mockResolvedValue(41);
    mocks.reconcileSavedMarketMatchSummary.mockResolvedValue(undefined);
  });

  it('publishes refreshing before waiting for upstream market data', async () => {
    let rejectUpstream!: (error: Error) => void;
    mocks.upstream.mockImplementation(() => new Promise((_resolve, reject) => { rejectUpstream = reject; }));

    const pending = executeFullScan(request());
    await vi.waitFor(() => {
      expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenCalledWith('tx-07', {
        matchedCount: 0,
        matchStatus: 'refreshing',
        matchError: undefined,
        matchedPairs: undefined,
        scannedAt: expect.any(String),
        publicationGeneration: 41,
      });
    });

    rejectUpstream(new Error('Kalshi upstream timed out'));
    await pending;
  });

  it('rejects a second full scan while the first saved-market scan is still executing', async () => {
    let resolveUpstream!: (markets: unknown[]) => void;
    mocks.upstream.mockImplementationOnce(() => new Promise(resolve => { resolveUpstream = resolve; }));
    let savedMarketLockAttempts = 0;
    mocks.acquireSavedMarketScanLock.mockImplementation(async (lockId: string) => {
      if (lockId === 'tx-07' && ++savedMarketLockAttempts > 1) {
        return {
          status: 'busy',
          reason: 'owner_live',
          retryable: true,
          retryAfterMs: 5_000,
        };
      }
      return {
        status: 'acquired',
        lock: { path: `/tmp/${lockId}`, ownerPid: 1, ownerToken: `${lockId}-${savedMarketLockAttempts}` },
      };
    });

    const first = executeFullScan(request());
    await vi.waitFor(() => expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenCalledTimes(1));

    const duplicate = await executeFullScan(request());
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: expect.stringContaining('already in progress'),
    });
    expect(mocks.reserveSavedMarketPublication).toHaveBeenCalledTimes(1);

    resolveUpstream([]);
    await first;
  });

  it('retries scan-history publication when concurrent workers hand off the SQLite writer', async () => {
    mocks.appendScanHistory
      .mockRejectedValueOnce(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }))
      .mockRejectedValueOnce(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' }))
      .mockResolvedValueOnce(undefined);

    const response = await executeFullScan(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fullScanPersisted: true });
    expect(mocks.appendScanHistory).toHaveBeenCalledTimes(3);
  });

  it('keeps the primary full scan durable when secondary history persistence fails', async () => {
    mocks.appendScanHistory.mockRejectedValueOnce(new Error('history persistence unavailable'));

    const response = await executeFullScan(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fullScanPersisted: true });
  });

  it('keeps a durable full scan successful when secondary bot persistence fails', async () => {
    mocks.persistAndConsumeBotScan.mockRejectedValueOnce(new Error('bot persistence unavailable'));

    const response = await executeFullScan(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fullScanPersisted: true });
  });

  it('publishes unavailable with the reserved generation after terminal upstream failure', async () => {
    mocks.upstream.mockRejectedValue(new Error('Kalshi upstream timed out'));

    const response = await executeFullScan(request());
    const body = await response.json();

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenLastCalledWith('tx-07', {
      matchedCount: 0,
      matchStatus: 'unavailable',
      matchError: body.error,
      matchedPairs: undefined,
      scannedAt: expect.any(String),
      publicationGeneration: 41,
    });
  });

  it('cannot let an older failed scan overwrite a newer generation', async () => {
    let currentGeneration = 41;
    const accepted: string[] = [];
    mocks.reconcileSavedMarketMatchSummary.mockImplementation(async (_id, summary) => {
      if (summary.publicationGeneration === currentGeneration) accepted.push(summary.matchStatus);
    });
    mocks.upstream.mockImplementation(async () => {
      currentGeneration = 42;
      throw new Error('Kalshi upstream timed out');
    });

    await executeFullScan(request());

    expect(accepted).toEqual(['refreshing']);
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenLastCalledWith(
      'tx-07',
      expect.objectContaining({ matchStatus: 'unavailable', publicationGeneration: 41 }),
    );
  });

  it('persists requested scan capital separately from aggregate candidate stake', async () => {
    mocks.upstream.mockResolvedValue([]);
    mocks.calculateAllArbitrages.mockReturnValue([
      {
        artist: 'Candidate A',
        kalshiMarketQuestion: 'Will Candidate A win on Kalshi?',
        pmMarketQuestion: 'Will Candidate A win on Polymarket?',
        kalshiOutcomeLabel: 'Kalshi Candidate A',
        pmOutcomeLabel: 'Polymarket Candidate A',
        kalshi: { ticker: 'KXTX07-A', yesAsk: 0.4, noAsk: 0.6, yesAskDepth: 500, noAskDepth: 500 },
        polymarket: { conditionId: 'pm-a', yesPrice: 0.42, noPrice: 0.58, askDepth: 500, noAskDepth: 500 },
        arbitrage: {
          roiPct: 2,
          expectedProfit: 2,
          strategy: 'Buy YES Kalshi + NO PM',
          arbType: 'direct',
          kalshiStake: 60,
          pmStake: 40,
          executionStatus: 'executable',
          fees: { kalshiFee: 0.5, pmFee: 0.5 },
          calculationEnvelope: executableEnvelopeFixture,
        },
      },
      {
        artist: 'Candidate B',
        kalshi: { ticker: 'KXTX07-B', yesAsk: 0.45, noAsk: 0.55, yesAskDepth: 500, noAskDepth: 500 },
        polymarket: { conditionId: 'pm-b', yesPrice: 0.47, noPrice: 0.53, askDepth: 500, noAskDepth: 500 },
        arbitrage: {
          roiPct: 1,
          expectedProfit: 1,
          strategy: 'Buy YES Kalshi + NO PM',
          arbType: 'direct',
          kalshiStake: 55,
          pmStake: 45,
          executionStatus: 'executable',
          fees: { kalshiFee: 0.5, pmFee: 0.5 },
        },
      },
    ]);

    const response = await executeFullScan(request());

    expect(response.status).toBe(200);
    expect(mocks.persistAndConsumeBotScan).toHaveBeenCalledWith(
      'tx-07',
      expect.objectContaining({
        totalStake: 200,
        calculationEnvelope: executableEnvelopeFixture,
        raw: expect.objectContaining({ scanCapital: 1000 }),
      }),
      'scan_api',
    );
    const calls = mocks.persistAndConsumeBotScan.mock.calls as unknown as Array<[string, {
      raw?: { allArbs?: Array<{
        fees?: unknown;
        kalshiMarketQuestion?: string | null;
        pmMarketQuestion?: string | null;
        kalshiOutcomeLabel?: string | null;
        pmOutcomeLabel?: string | null;
        calculationEnvelope?: unknown;
      }> };
    }, string]>;
    const persisted = calls.at(-1)?.[1];
    expect(persisted?.raw?.allArbs?.[0]?.fees).toEqual({ kalshiFee: 0.5, pmFee: 0.5 });
    expect(persisted?.raw?.allArbs?.[0]).toMatchObject({
      kalshiMarketQuestion: 'Will Candidate A win on Kalshi?',
      pmMarketQuestion: 'Will Candidate A win on Polymarket?',
      kalshiOutcomeLabel: 'Kalshi Candidate A',
      pmOutcomeLabel: 'Polymarket Candidate A',
      calculationEnvelope: executableEnvelopeFixture,
    });
  });

  it('does not persist an indicative non-executable quote as a completed positive arb', async () => {
    mocks.upstream.mockResolvedValue([]);
    mocks.calculateAllArbitrages.mockReturnValue([{
      artist: 'Indicative only',
      kalshi: { ticker: 'KXTX07-I', yesAsk: 0.4, noAsk: 0.6, yesAskDepth: 0, noAskDepth: 0 },
      polymarket: { conditionId: 'pm-i', yesPrice: 0.42, noPrice: 0.58, askDepth: 0, noAskDepth: 0 },
      arbitrage: {
        roiPct: 12.5,
        expectedProfit: 0,
        strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct',
        kalshiStake: 0,
        pmStake: 0,
        executionStatus: 'non_executable',
        executionBlocker: 'Captured direct legs cannot fill one share',
      },
    }]);

    const response = await executeFullScan(request());
    expect(response.status).toBe(200);
    expect(mocks.persistAndConsumeBotScan).toHaveBeenLastCalledWith(
      'tx-07',
      expect.objectContaining({ positiveArbCount: 0, bestProfit: 0, totalStake: 0 }),
      'scan_api',
    );
    expect(mocks.appendScanHistory).toHaveBeenLastCalledWith(expect.objectContaining({ positiveArbCount: 0, totalProfit: 0 }));
  });
});
