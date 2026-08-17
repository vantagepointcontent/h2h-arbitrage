import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchKalshiEventMarkets: vi.fn(),
  fetchPolymarketEvent: vi.fn(),
  fetchClobBooksDetailed: vi.fn(),
  getSavedMarketById: vi.fn(),
}));

vi.mock('@/lib/kalshi', () => ({
  extractKalshiEventTicker: () => 'KXTEST-26',
  extractKalshiMatchKey: () => null,
  filterKalshiMarketsToMatch: (markets: unknown[]) => markets,
  fetchKalshiEventMarkets: mocks.fetchKalshiEventMarkets,
}));

vi.mock('@/lib/polymarket', () => ({
  extractPolymarketSlug: () => 'pm-test',
  isPolymarketMarketUrl: () => false,
  fetchPolymarketEvent: mocks.fetchPolymarketEvent,
  fetchPolymarketMarketAsEvent: mocks.fetchPolymarketEvent,
}));

vi.mock('@/lib/polymarket-clob', () => ({
  fetchClobBooksDetailed: mocks.fetchClobBooksDetailed,
  getClobPricesFromBooks: (
    market: { neg_risk?: boolean },
    yesBook: { bids?: unknown[] } | null,
    noBook: unknown,
  ) => yesBook && (noBook || (market.neg_risk === true && (yesBook.bids?.length ?? 0) > 0)) ? {
      yesPrice: 0.42, noPrice: noBook ? 0.59 : 0.6, bestBid: 0.4, bestAsk: 0.42, lastTradePrice: 0.42,
      yesAskDepth: 42, noAskDepth: 59, yesBid: 0.4, noBid: 0.57,
      yesBidDepth: 100, noBidDepth: 100,
    } : null,
}));

vi.mock('@/lib/persistence', () => ({ getSavedMarketById: mocks.getSavedMarketById }));
vi.mock('@/lib/manual-matches', () => ({ getManualMatches: vi.fn(async () => []) }));
vi.mock('@/lib/decoupled-pairs', () => ({
  getDecoupledPairs: vi.fn(async () => []),
  applyDecoupledPairs: (outcomes: unknown[]) => outcomes,
}));
vi.mock('@/lib/settings', () => ({ getSetting: vi.fn(async () => null) }));
vi.mock('./market-classification', () => ({ resolveMarketDomain: () => 'other' }));
vi.mock('@/app/lib/page-shared', () => ({ computePriceResolved: () => false }));
vi.mock('@/lib/matcher', () => ({
  matchOutcomes: (kalshi: Array<{ title?: string }>, pm: Array<{ question?: string; conditionId?: string; outcomePrices?: string }>) => [
    ...kalshi.map((market, index) => ({
      artist: market.title ?? `Kalshi ${index}`,
      kalshi: { ticker: `K-${index}`, yesAsk: 0.4, noAsk: 0.6 },
      polymarket: null,
      arbitrage: { roiPct: 0 },
    })),
    ...pm.map((market, index) => ({
      artist: market.question ?? `Polymarket ${index}`,
      kalshi: null,
      polymarket: {
        conditionId: market.conditionId ?? `P-${index}`, marketId: market.conditionId ?? `P-${index}`,
        yesPrice: Number(JSON.parse(market.outcomePrices ?? '[0,0]')[0]),
        noPrice: Number(JSON.parse(market.outcomePrices ?? '[0,0]')[1]),
      },
      arbitrage: { roiPct: 0 },
    })),
  ],
  applyManualMatches: (outcomes: unknown[]) => outcomes,
  calculateAllArbitrages: (outcomes: unknown[]) => outcomes,
  attachOutcomeContingentApy: (outcomes: unknown[]) => outcomes,
  computeApy: () => 0,
  setSuspiciousRoiPct: vi.fn(),
}));

import { quickPricesScan } from './quick-prices';

const pmMarket = {
  id: 'pm-1',
  conditionId: 'condition-1',
  question: 'PM outcome',
  slug: 'pm-outcome',
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.4","0.6"]',
  bestBid: null,
  bestAsk: null,
  active: true,
  closed: false,
  negRisk: true,
  clobTokenIds: '["yes-1","no-1"]',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.getSavedMarketById.mockResolvedValue({
    id: 'saved-1',
    eventTitle: 'Saved title',
    category: 'entertainment',
    expiryDate: '2026-12-31T00:00:00Z',
    kalshiUrl: 'https://kalshi.com/markets/test/test/kxtest-26',
    polymarketUrl: 'https://polymarket.com/event/pm-test',
  });
  mocks.fetchKalshiEventMarkets.mockResolvedValue([{ title: 'Kalshi outcome' }]);
  mocks.fetchPolymarketEvent.mockResolvedValue({
    id: 'event-1',
    title: 'PM title',
    endDate: '2026-12-31T00:00:00Z',
    active: true,
    closed: false,
    markets: [pmMarket],
  });
  mocks.fetchClobBooksDetailed.mockResolvedValue({
    books: new Map([
      ['yes-1', { asset_id: 'yes-1', bids: [], asks: [{ price: '0.42', size: '100' }] }],
      ['no-1', { asset_id: 'no-1', bids: [], asks: [{ price: '0.59', size: '100' }] }],
    ]),
    diagnostics: new Map([
      ['yes-1', { tokenId: 'yes-1', status: 'success', attemptCount: 1, queueWaitMs: 0, upstreamLatencyMs: 1, totalLatencyMs: 1, deadlineSource: 'per-token', observedAt: '2026-08-17T14:00:00.000Z' }],
      ['no-1', { tokenId: 'no-1', status: 'success', attemptCount: 1, queueWaitMs: 0, upstreamLatencyMs: 1, totalLatencyMs: 1, deadlineSource: 'per-token', observedAt: '2026-08-17T14:00:00.000Z' }],
    ]),
    metrics: { tokenCount: 2, successCount: 2, timeoutCount: 0, errorCount: 0, unavailableCount: 0, retryCount: 0, queueWaitMs: 0, upstreamLatencyMs: 2, durationMs: 1 },
  });
});

describe('quickPricesScan bounded platform failures', () => {
  it('reports per-stage latency and outcome counts for refresh diagnostics', async () => {
    const result = await quickPricesScan('saved-1');

    expect(result.refreshMetrics).toEqual({
      latencyMs: {
        savedMarket: expect.any(Number),
        kalshi: expect.any(Number),
        polymarket: expect.any(Number),
        linkedEvents: expect.any(Number),
        clob: expect.any(Number),
        matching: expect.any(Number),
        total: expect.any(Number),
      },
      counts: {
        kalshiRaw: 1,
        kalshiFiltered: 1,
        polymarketRaw: 1,
        polymarketFiltered: 1,
        matched: 0,
      },
      clob: {
        tokenCount: 2, successCount: 2, timeoutCount: 0, errorCount: 0,
        unavailableCount: 0, retryCount: 0, queueWaitMs: 0, upstreamLatencyMs: 2, durationMs: 1,
      },
    });
    expect(Object.values(result.refreshMetrics.latencyMs).every((value) => value >= 0)).toBe(true);
  });

  it('scopes a token timeout without discarding successful sibling outcomes', async () => {
    mocks.getSavedMarketById.mockResolvedValue({
      id: 'saved-1', eventTitle: 'Saved title', category: 'entertainment', expiryDate: '2026-12-31T00:00:00Z',
      kalshiUrl: 'https://kalshi.com/markets/test/test/kxtest-26', polymarketUrl: 'https://polymarket.com/event/pm-test',
      lastScanResult: {
        scannedAt: '2026-08-17T13:55:00.000Z',
        allArbs: [{ pmConditionId: 'condition-1', pmYesPrice: 0.31, pmNoPrice: 0.7, pmBestAsk: 0.31, pmBestBid: 0.3 }],
      },
    });
    mocks.fetchPolymarketEvent.mockResolvedValue({
      id: 'event-1', title: 'PM title', endDate: '2026-12-31T00:00:00Z', active: true, closed: false,
      markets: [pmMarket, { ...pmMarket, id: 'pm-2', conditionId: 'condition-2', question: 'PM outcome 2', clobTokenIds: '["yes-2","no-2"]' }],
    });
    mocks.fetchClobBooksDetailed.mockResolvedValue({
      books: new Map([
        ['yes-1', { asset_id: 'yes-1', bids: [{ price: '0.40', size: '100' }], asks: [{ price: '0.42', size: '100' }] }],
        ['no-1', null],
        ['yes-2', { asset_id: 'yes-2', bids: [], asks: [{ price: '0.35', size: '100' }] }],
        ['no-2', { asset_id: 'no-2', bids: [], asks: [{ price: '0.66', size: '100' }] }],
      ]),
      diagnostics: new Map([
        ['yes-1', { tokenId: 'yes-1', status: 'success', attemptCount: 1, queueWaitMs: 0, upstreamLatencyMs: 10, totalLatencyMs: 10, deadlineSource: 'per-token', observedAt: '2026-08-17T14:00:00.000Z' }],
        ['no-1', { tokenId: 'no-1', status: 'timeout', attemptCount: 2, queueWaitMs: 0, upstreamLatencyMs: 200, totalLatencyMs: 250, deadlineSource: 'per-token', reason: 'request timed out' }],
        ['yes-2', { tokenId: 'yes-2', status: 'success', attemptCount: 1, queueWaitMs: 0, upstreamLatencyMs: 10, totalLatencyMs: 10, deadlineSource: 'per-token', observedAt: '2026-08-17T14:00:00.000Z' }],
        ['no-2', { tokenId: 'no-2', status: 'success', attemptCount: 1, queueWaitMs: 0, upstreamLatencyMs: 10, totalLatencyMs: 10, deadlineSource: 'per-token', observedAt: '2026-08-17T14:00:00.000Z' }],
      ]),
      metrics: { tokenCount: 4, successCount: 3, timeoutCount: 1, errorCount: 0, unavailableCount: 0, retryCount: 1, queueWaitMs: 0, upstreamLatencyMs: 230, durationMs: 250 },
    });

    const result = await quickPricesScan('saved-1');

    expect(result.kalshiCount).toBe(1);
    expect(result.pmCount).toBe(2);
    expect(result.platformWarnings[0]).toContain('1 of 2 Polymarket outcomes refreshed');
    expect(result.platformWarnings[0]).toContain('PM outcome');
    expect(result.pmRefresh.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conditionId: 'condition-1', status: 'timed_out', servedFromSnapshot: true,
        source: 'saved-market-snapshot', observedAt: '2026-08-17T13:55:00.000Z',
      }),
      expect.objectContaining({ conditionId: 'condition-2', status: 'refreshed' }),
    ]));
    expect(result.outcomes.find((outcome) => outcome.polymarket?.conditionId === 'condition-1')).toMatchObject({
      polymarketStale: true,
      polymarket: { yesPrice: 0.31, noPrice: 0.7 },
      arbitrage: { expectedProfit: 0, roiPct: 0 },
    });
    expect(result.refreshStatus).toBe('partial');
    expect(result.platformDiagnostics.polymarket.status).toBe('partial');
    expect(result._pmFetchedAt).toBe('2026-08-17T13:55:00.000Z');
    expect(result._priceDataObservedAt).toBe('2026-08-17T13:55:00.000Z');
    expect(result.refreshMetrics.clob).toMatchObject({ tokenCount: 4, successCount: 3, timeoutCount: 1, retryCount: 1 });
  });

  it('keeps Polymarket outcomes when Kalshi times out', async () => {
    mocks.fetchKalshiEventMarkets.mockImplementation(() => new Promise(() => {}));

    const pending = quickPricesScan('saved-1');
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await pending;

    expect(result.kalshiCount).toBe(0);
    expect(result.pmCount).toBe(1);
    expect(result.platformWarnings).toContain('Kalshi timed out; showing available Polymarket data and saved market data.');
    expect(result.refreshStatus).toBe('partial');
    expect(result.platformDiagnostics.kalshi.status).toBe('failed');
    expect(result.platformDiagnostics.polymarket.status).toBe('fresh');
  });

  it('keeps Kalshi outcomes when a stale Polymarket identifier returns no event', async () => {
    mocks.fetchPolymarketEvent.mockResolvedValue(null);

    const result = await quickPricesScan('saved-1');

    expect(result.eventTitle).toBe('Saved title');
    expect(result.kalshiCount).toBe(1);
    expect(result.pmCount).toBe(0);
    expect(result.platformWarnings).toContain('Polymarket event is unavailable or no longer open; showing available Kalshi and saved market data.');
    expect(result.platformDiagnostics.polymarket.status).toBe('empty');
  });

  it('distinguishes a genuine linked-event zero from an upstream Kalshi failure', async () => {
    mocks.fetchKalshiEventMarkets.mockResolvedValue([]);

    const result = await quickPricesScan('saved-1');

    expect(result.platformDiagnostics.kalshi).toEqual({
      status: 'empty', count: 0, reason: 'Kalshi linked event returned zero open markets.',
    });
    expect(result.platformWarnings).toContain('Kalshi linked event returned zero open markets.');
  });

  it('reports actionable reasons for both linked-platform request failures', async () => {
    mocks.fetchKalshiEventMarkets.mockRejectedValue(new Error('Kalshi API 503'));
    mocks.fetchPolymarketEvent.mockRejectedValue(new Error('Gamma API 502'));

    const result = await quickPricesScan('saved-1');

    expect(result.refreshStatus).toBe('failed');
    expect(result.retryable).toBe(true);
    expect(result.platformDiagnostics.kalshi).toMatchObject({ status: 'failed', count: 0 });
    expect(result.platformDiagnostics.kalshi.reason).toContain('Kalshi API 503');
    expect(result.platformDiagnostics.polymarket).toMatchObject({ status: 'failed', count: 0 });
    expect(result.platformDiagnostics.polymarket.reason).toContain('Gamma API 502');
  });
});
