import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { executableEnvelopeFixture } from '@/lib/test-fixtures/calculation-envelope';
import { evaluateBotTrade } from '@/lib/bot-trader';
import { parseBotScanCandidate } from '@/lib/bot-scan-consumer';

const mocks = vi.hoisted(() => ({
  upstream: vi.fn(),
  calculateAllArbitrages: vi.fn((): unknown[] => []),
  appendScanHistory: vi.fn(async () => undefined),
  findSavedMarketByUrls: vi.fn(),
  persistAndConsumeBotScan: vi.fn(async () => undefined),
  reserveSavedMarketPublication: vi.fn(),
  reconcileSavedMarketMatchSummary: vi.fn(),
  updateSavedMarketScanResult: vi.fn(async () => true),
  fetchClobMarkets: vi.fn(),
  getClobAskDepths: vi.fn(),
  getClobPrices: vi.fn(),
  acquireSavedMarketScanLock: vi.fn(),
  releaseSavedMarketScanLock: vi.fn(async () => undefined),
  filterKalshiMarketsToMatch: vi.fn((markets: unknown[]) => markets),
}));

vi.mock('@/lib/kalshi', () => ({
  extractKalshiEventTicker: () => 'KXTX07',
  extractKalshiSeriesFromUrl: () => null,
  extractKalshiMatchKey: () => null,
  filterKalshiMarketsToMatch: mocks.filterKalshiMarketsToMatch,
  fetchKalshiEventMarkets: mocks.upstream,
  fetchKalshiSeriesMarkets: vi.fn(async () => []),
  fetchKalshiMultiSeriesMarkets: vi.fn(async () => ({ markets: [], seriesFetched: [] })),
}));
vi.mock('@/lib/polymarket', () => ({
  extractPolymarketSlug: () => 'tx-07',
  fetchPolymarketEvent: vi.fn(async () => ({
    id: 'pm-event', title: 'TX-07', active: true,
    markets: [{ id: 'pm-yes', conditionId: 'pm-condition', question: 'Will TX-07 occur?', outcomePrices: '[0.4,0.6]' }],
  })),
  fetchPolymarketMarketAsEvent: vi.fn(),
  isPolymarketMarketUrl: () => false,
  parseOutcomePrices: () => [0, 0],
}));
vi.mock('@/lib/polymarket-clob', () => ({
  fetchClobMarkets: mocks.fetchClobMarkets,
  getClobAskDepths: mocks.getClobAskDepths,
  getClobPrices: mocks.getClobPrices,
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
  updateSavedMarketScanResult: mocks.updateSavedMarketScanResult,
  appendScanHistory: mocks.appendScanHistory,
}));
vi.mock('@/lib/bot-scan-consumer', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/bot-scan-consumer')>(),
  persistAndConsumeBotScan: mocks.persistAndConsumeBotScan,
}));
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
vi.mock('@/lib/scan-clob-selection', () => ({ selectMatchedClobConditionIds: () => ['pm-condition'] }));

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
    mocks.upstream.mockResolvedValue([{ ticker: 'KXTX07-YES', title: 'Will TX-07 occur?', yes_ask: 40, no_ask: 60 }]);
    mocks.filterKalshiMarketsToMatch.mockImplementation((markets: unknown[]) => markets);
    mocks.appendScanHistory.mockReset();
    mocks.appendScanHistory.mockResolvedValue(undefined);
    mocks.acquireSavedMarketScanLock.mockResolvedValue({
      status: 'acquired',
      lock: { path: '/tmp/test-lock', ownerPid: 1, ownerToken: 'test' },
    });
    mocks.findSavedMarketByUrls.mockResolvedValue({ id: 'tx-07', eventTitle: 'TX-07' });
    mocks.reserveSavedMarketPublication.mockResolvedValue(41);
    mocks.reconcileSavedMarketMatchSummary.mockResolvedValue(undefined);
    mocks.fetchClobMarkets.mockResolvedValue(new Map([['pm-condition', {
      condition_id: 'pm-condition',
      tokens: [{ outcome: 'Yes', price: 0.4 }, { outcome: 'No', price: 0.6 }],
    }]]));
    mocks.getClobPrices.mockResolvedValue({
      yesPrice: 0.4, noPrice: 0.6, bestBid: 0.39, bestAsk: 0.4, lastTradePrice: 0.4,
    });
    mocks.getClobAskDepths.mockResolvedValue({
      yesAskDepth: 500, noAskDepth: 500, yesBid: 0.39, noBid: 0.59,
      yesBidDepth: 500, noBidDepth: 500,
      yesMinOrderSize: 1, noMinOrderSize: 1, yesTickSize: 0.01, noTickSize: 0.01,
    });
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
    expect(body).toMatchObject({ reasonCode: 'kalshi_source_timeout', fullScanPersisted: false });
    expect(body.error).not.toContain('Kalshi 0.00');
    expect(body.error).not.toContain('Kalshi $0.00');
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenLastCalledWith('tx-07', {
      matchedCount: 0,
      matchStatus: 'unavailable',
      matchError: body.error,
      matchedPairs: undefined,
      scannedAt: expect.any(String),
      publicationGeneration: 41,
    });
  });

  it('does not publish a completed sparse scan when one venue returns no usable market data', async () => {
    mocks.upstream.mockResolvedValue([]);

    const response = await executeFullScan(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ reasonCode: 'kalshi_market_data_unavailable', fullScanPersisted: false });
    expect(mocks.updateSavedMarketScanResult).not.toHaveBeenCalled();
    expect(mocks.persistAndConsumeBotScan).not.toHaveBeenCalled();
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenLastCalledWith('tx-07', expect.objectContaining({
      matchStatus: 'unavailable',
      matchError: expect.stringContaining('Kalshi'),
      publicationGeneration: 41,
    }));
  });

  it.each([
    ['Kalshi API error: 429', 'kalshi_source_rate_limited'],
    ['Kalshi API connection reset', 'kalshi_source_unavailable'],
  ])('preserves the exact Kalshi source failure instead of rendering numeric zero: %s', async (message, reasonCode) => {
    mocks.upstream.mockRejectedValue(new Error(message));

    const response = await executeFullScan(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ reasonCode, fullScanPersisted: false });
    expect(body.error).toContain(message);
    expect(body.error).not.toContain('Kalshi 0.00');
    expect(body.error).not.toContain('Kalshi $0.00');
    expect(mocks.updateSavedMarketScanResult).not.toHaveBeenCalled();
    expect(mocks.persistAndConsumeBotScan).not.toHaveBeenCalled();
  });

  it('distinguishes a filtered wrong-ticker result from an authoritative empty book', async () => {
    mocks.filterKalshiMarketsToMatch.mockReturnValueOnce([]);

    const response = await executeFullScan(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ reasonCode: 'kalshi_wrong_ticker', fullScanPersisted: false });
    expect(body.error).toContain('matched no market for the requested ticker/outcome');
    expect(body.error).not.toContain('0.00');
  });

  it.each([
    ['metadata request failure', () => mocks.fetchClobMarkets.mockRejectedValueOnce(new Error('CLOB timeout')), 'clob_metadata_unavailable'],
    ['missing metadata for a selected condition', () => mocks.fetchClobMarkets.mockResolvedValueOnce(new Map()), 'clob_metadata_incomplete'],
    ['per-book request failure', () => mocks.getClobPrices.mockRejectedValueOnce(new Error('book timeout')), 'clob_book_unavailable'],
    ['empty executable book', () => mocks.getClobPrices.mockResolvedValueOnce(null), 'clob_book_empty'],
  ])('preserves the prior completed publication on %s', async (_label, arrange, reasonCode) => {
    arrange();

    const response = await executeFullScan(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reasonCode, fullScanPersisted: false });
    expect(mocks.updateSavedMarketScanResult).not.toHaveBeenCalled();
    expect(mocks.persistAndConsumeBotScan).not.toHaveBeenCalled();
    expect(mocks.reconcileSavedMarketMatchSummary).toHaveBeenLastCalledWith('tx-07', expect.objectContaining({
      matchStatus: 'unavailable',
      matchError: expect.stringContaining(reasonCode),
      publicationGeneration: 41,
    }));
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

  it('publishes a wholly non-executable candidate set as a completed no-arbitrage observation', async () => {
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
    expect(await response.json()).toMatchObject({
      fullScanPersisted: true,
    });
    expect(mocks.updateSavedMarketScanResult).toHaveBeenCalledWith(
      'tx-07',
      expect.objectContaining({
        bestRoiPct: 0,
        bestProfit: 0,
        strategy: 'No arb',
        arbType: null,
        matchStatus: 'confirmed_zero',
        allArbs: [expect.objectContaining({ executionStatus: 'non_executable' })],
      }),
      undefined,
      undefined,
    );
    expect(mocks.persistAndConsumeBotScan).toHaveBeenCalledWith(
      'tx-07',
      expect.objectContaining({
        bestRoiPct: 0,
        bestProfit: 0,
        strategy: 'No arb',
        positiveArbCount: 0,
      }),
      'scan_api',
    );
    expect(mocks.appendScanHistory).toHaveBeenCalledWith(expect.objectContaining({ positiveArbCount: 0 }));
  });

  it('does not publish a negative executable candidate as a current arbitrage', async () => {
    mocks.calculateAllArbitrages.mockReturnValue([{
      artist: 'Executable but unprofitable',
      kalshi: { ticker: 'KXTX07-N', yesAsk: 0.6, noAsk: 0.4, yesAskDepth: 100, noAskDepth: 100 },
      polymarket: { conditionId: 'pm-n', yesPrice: 0.6, noPrice: 0.4, askDepth: 100, noAskDepth: 100 },
      arbitrage: {
        roiPct: -1,
        expectedProfit: -1,
        strategy: 'Buy YES Kalshi + NO PM',
        arbType: 'direct',
        kalshiStake: 60,
        pmStake: 40,
        executionStatus: 'executable',
      },
    }]);

    const response = await executeFullScan(request());
    expect(response.status).toBe(200);
    expect(mocks.updateSavedMarketScanResult).toHaveBeenCalledWith(
      'tx-07',
      expect.objectContaining({
        bestRoiPct: 0,
        bestProfit: 0,
        strategy: 'No arb',
        arbType: null,
        matchStatus: 'confirmed_zero',
      }),
      undefined,
      undefined,
    );
    expect(mocks.persistAndConsumeBotScan).toHaveBeenCalledWith(
      'tx-07',
      expect.objectContaining({ positiveArbCount: 0, strategy: 'No arb' }),
      'scan_api',
    );
  });

  it('persists a stale Kalshi venue observation and BotTrader renders its exact age without numeric zero', async () => {
    vi.setSystemTime(new Date('2026-08-30T17:35:00.000Z'));
    mocks.calculateAllArbitrages.mockReturnValue([{
      artist: 'Stale Candidate',
      kalshiMarketQuestion: 'Will Stale Candidate win on Kalshi?',
      pmMarketQuestion: 'Will Stale Candidate win on Polymarket?',
      kalshiOutcomeLabel: 'Stale Candidate',
      pmOutcomeLabel: 'Stale Candidate',
      kalshi: {
        ticker: 'KXTX07-STALE', yesBid: 0.44, yesAsk: 0.45, noBid: 0.54, noAsk: 0.55,
        lastPrice: 0.44, yesAskDepth: '45.000000', noAskDepth: '55.000000',
        yesAskDepthStatus: 'available', noAskDepthStatus: 'available',
        yesTickSize: 0.01, noTickSize: 0.01,
        quoteObservedAt: '2026-08-30T17:30:00.000Z',
      },
      polymarket: {
        conditionId: 'pm-condition', yesPrice: 0.49, noPrice: 0.5,
        askDepth: 49, noAskDepth: 50, yesTickSize: 0.01, noTickSize: 0.01,
        yesMinOrderSize: 1, noMinOrderSize: 1,
      },
      arbitrage: {
        roiPct: 5, expectedProfit: 5, strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct',
        kalshiStake: 45, pmStake: 50, executionStatus: 'executable',
        selectedKalshiSide: 'yes', selectedPmSide: 'no',
        selectedRelationshipState: 'verified_complementary',
        fees: { kalshiFee: 0.01, pmFee: 0.01 },
      },
    }]);

    const response = await executeFullScan(request());
    expect(response.status).toBe(200);
    const persisted = (mocks.persistAndConsumeBotScan.mock.calls.at(-1)?.[1] as {
      raw?: { allArbs?: unknown[] };
    }).raw?.allArbs?.[0] as Record<string, unknown>;
    expect(persisted.kalshiYesExecutableQuote).toMatchObject({
      status: 'unavailable', reason: 'stale_book', sourceStatus: 'stale',
      sourceObservedAt: '2026-08-30T17:30:00.000Z',
      sourceAttemptedAt: '2026-08-30T17:35:00.000Z',
      sourceFailureKind: 'stale_snapshot',
      sourceDetail: 'Kalshi depth is 300000ms old (maximum 30000ms)',
    });

    const candidate = parseBotScanCandidate(persisted);
    expect(candidate).not.toBeNull();
    const evaluation = evaluateBotTrade(candidate!, {
      enabled: true, mode: 'paper', selectionMethod: 'hybrid', minRoiPct: 2, minApyPct: 0,
      minDepthUsd: 0.5, minSharesPerLeg: 1, maxExpiryDays: 365, maxTradesPerDay: 10,
    });
    expect(evaluation.shouldTrade).toBe(false);
    expect(evaluation.reason).toContain('source status stale; source age at attempt 300000ms');
    expect(evaluation.reason).not.toContain('Kalshi 0.00');
    expect(evaluation.reason).not.toContain('Kalshi $0.00');
    vi.useRealTimers();
  });
});
