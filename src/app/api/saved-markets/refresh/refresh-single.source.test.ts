import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventMarkets: vi.fn(),
  seriesMarkets: vi.fn(),
  filter: vi.fn((markets: unknown[]) => markets),
}));

vi.mock('@/lib/kalshi', () => ({
  extractKalshiEventTicker: () => 'KXBUG858',
  extractKalshiSeriesFromUrl: () => null,
  extractKalshiMatchKey: () => 'TEST',
  filterKalshiMarketsToMatch: mocks.filter,
  fetchKalshiEventMarkets: mocks.eventMarkets,
  fetchKalshiSeriesMarkets: mocks.seriesMarkets,
  fetchKalshiMultiSeriesMarkets: vi.fn(),
}));
vi.mock('@/lib/polymarket', () => ({
  extractPolymarketSlug: () => 'bug858',
  fetchPolymarketEvent: vi.fn(async () => ({
    id: 'pm-event', title: 'BUG-858', active: true, markets: [],
  })),
  fetchPolymarketMarketAsEvent: vi.fn(),
  isPolymarketMarketUrl: () => false,
}));
vi.mock('@/lib/polymarket-clob', () => ({
  fetchClobMarkets: vi.fn(async () => new Map()),
  getClobAskDepths: vi.fn(),
  getClobPrices: vi.fn(),
}));
vi.mock('@/lib/matcher', () => ({
  matchOutcomes: () => [], calculateAllArbitrages: () => [], parseDepth: () => 0,
  attachOutcomeContingentApy: (outcomes: unknown[]) => outcomes,
  applyManualMatches: (outcomes: unknown[]) => outcomes,
}));
vi.mock('@/lib/decoupled-pairs', () => ({
  getDecoupledPairs: vi.fn(async () => []), applyDecoupledPairs: (outcomes: unknown[]) => outcomes,
}));
vi.mock('@/lib/scan-shared', () => ({
  withTimeout: (promise: Promise<unknown>) => promise,
  chooseBestPmStructure: (markets: unknown[]) => markets,
}));

import { refreshSingleMarket } from './refresh-single';

const savedMarket = {
  id: 'bug858', eventTitle: 'BUG-858', kalshiUrl: 'https://kalshi.com/markets/x/x/KXBUG858',
  polymarketUrl: 'https://polymarket.com/event/bug858', expiryDate: null,
} as never;

describe('saved refresh Kalshi source provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.filter.mockImplementation((markets: unknown[]) => markets);
    mocks.seriesMarkets.mockResolvedValue([]);
  });

  it.each([
    ['Kalshi API error: 429', 'kalshi_source_rate_limited'],
    ['Kalshi transport unavailable', 'kalshi_source_unavailable'],
  ])('fails closed with exact %s provenance', async (message, reasonCode) => {
    mocks.eventMarkets.mockRejectedValue(new Error(message));

    await expect(refreshSingleMarket(savedMarket, [])).rejects.toThrow(reasonCode);
    await expect(refreshSingleMarket(savedMarket, [])).rejects.not.toThrow(/Kalshi (?:\$)?0\.00/);
  });

  it('fails closed with exact timeout provenance', async () => {
    mocks.eventMarkets.mockRejectedValue(new Error('Kalshi event markets timed out'));

    await expect(refreshSingleMarket(savedMarket, [])).rejects.toThrow('kalshi_source_timeout');
  });

  it('distinguishes wrong ticker filtering from an authoritative empty book', async () => {
    mocks.eventMarkets.mockResolvedValue([{ ticker: 'KXOTHER' }]);
    mocks.filter.mockReturnValueOnce([]);

    await expect(refreshSingleMarket(savedMarket, [])).rejects.toThrow('kalshi_wrong_ticker');
  });
});
