import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchKalshiEventMarkets: vi.fn(),
  fetchPolymarketEvent: vi.fn(),
  fetchClobBooks: vi.fn(),
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
  fetchClobBooks: mocks.fetchClobBooks,
  getClobPricesFromBooks: () => null,
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
  matchOutcomes: (kalshi: Array<{ title?: string }>, pm: Array<{ question?: string }>) => [
    ...kalshi.map((market, index) => ({
      artist: market.title ?? `Kalshi ${index}`,
      kalshi: { ticker: `K-${index}`, yesAsk: 0.4, noAsk: 0.6 },
      polymarket: null,
      arbitrage: { roiPct: 0 },
    })),
    ...pm.map((market, index) => ({
      artist: market.question ?? `Polymarket ${index}`,
      kalshi: null,
      polymarket: { conditionId: `P-${index}`, marketId: `P-${index}`, yesPrice: 0, noPrice: 0 },
      arbitrage: { roiPct: 0 },
    })),
  ],
  applyManualMatches: (outcomes: unknown[]) => outcomes,
  calculateAllArbitrages: (outcomes: unknown[]) => outcomes,
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
  mocks.fetchClobBooks.mockResolvedValue(new Map());
});

describe('quickPricesScan bounded platform failures', () => {
  it('keeps Gamma and Kalshi outcomes when the CLOB batch exceeds its deadline', async () => {
    mocks.fetchClobBooks.mockImplementation(() => new Promise(() => {}));

    const pending = quickPricesScan('saved-1');
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await pending;

    expect(result.kalshiCount).toBe(1);
    expect(result.pmCount).toBe(1);
    expect(result.platformWarnings).toContain('Polymarket order books timed out; showing saved market structure without live Polymarket prices.');
    expect(result.outcomes.find((outcome) => outcome.polymarket)?.polymarket?.yesPrice).toBe(0);
  });

  it('keeps Polymarket outcomes when Kalshi times out', async () => {
    mocks.fetchKalshiEventMarkets.mockImplementation(() => new Promise(() => {}));

    const pending = quickPricesScan('saved-1');
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await pending;

    expect(result.kalshiCount).toBe(0);
    expect(result.pmCount).toBe(1);
    expect(result.platformWarnings).toContain('Kalshi timed out; showing available Polymarket data and saved market data.');
  });

  it('keeps Kalshi outcomes when a stale Polymarket identifier returns no event', async () => {
    mocks.fetchPolymarketEvent.mockResolvedValue(null);

    const result = await quickPricesScan('saved-1');

    expect(result.eventTitle).toBe('Saved title');
    expect(result.kalshiCount).toBe(1);
    expect(result.pmCount).toBe(0);
    expect(result.platformWarnings).toContain('Polymarket event is unavailable or no longer open; showing available Kalshi and saved market data.');
  });
});
