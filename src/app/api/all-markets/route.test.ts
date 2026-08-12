import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  extractKalshiEventTicker: vi.fn(() => 'KXH200MON-26AUG31'),
  extractKalshiMatchKey: vi.fn(() => null),
  extractKalshiSeriesFromUrl: vi.fn(() => null),
  filterKalshiMarketsToMatch: vi.fn((markets: unknown[]) => markets),
  fetchKalshiEventMarkets: vi.fn(),
  fetchKalshiSeriesMarkets: vi.fn(),
  fetchKalshiMultiSeriesMarkets: vi.fn(),
  extractPolymarketSlug: vi.fn(() => null),
  fetchPolymarketEvent: vi.fn(),
  fetchPolymarketMarketAsEvent: vi.fn(),
  isPolymarketMarketUrl: vi.fn(() => false),
}));

vi.mock('@/lib/kalshi', () => ({
  extractKalshiEventTicker: mocks.extractKalshiEventTicker,
  extractKalshiMatchKey: mocks.extractKalshiMatchKey,
  extractKalshiSeriesFromUrl: mocks.extractKalshiSeriesFromUrl,
  filterKalshiMarketsToMatch: mocks.filterKalshiMarketsToMatch,
  fetchKalshiEventMarkets: mocks.fetchKalshiEventMarkets,
  fetchKalshiSeriesMarkets: mocks.fetchKalshiSeriesMarkets,
  fetchKalshiMultiSeriesMarkets: mocks.fetchKalshiMultiSeriesMarkets,
}));

vi.mock('@/lib/polymarket', () => ({
  extractPolymarketSlug: mocks.extractPolymarketSlug,
  fetchPolymarketEvent: mocks.fetchPolymarketEvent,
  fetchPolymarketMarketAsEvent: mocks.fetchPolymarketMarketAsEvent,
  isPolymarketMarketUrl: mocks.isPolymarketMarketUrl,
}));

import { GET } from './route';

const kalshiUrl = 'https://kalshi.com/markets/kxh200mon/h200-monthly-price/kxh200mon-26aug31';

function request() {
  return new NextRequest(`http://localhost/api/all-markets?kalshiUrl=${encodeURIComponent(kalshiUrl)}`);
}

describe('GET /api/all-markets Kalshi outcome loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractKalshiEventTicker.mockReturnValue('KXH200MON-26AUG31');
    mocks.extractKalshiSeriesFromUrl.mockReturnValue(null);
    mocks.fetchKalshiEventMarkets.mockResolvedValue([]);
    mocks.fetchKalshiSeriesMarkets.mockResolvedValue([]);
  });

  it('distinguishes a Kalshi upstream failure from an empty event', async () => {
    mocks.fetchKalshiEventMarkets.mockRejectedValue(new Error('upstream unavailable'));

    const response = await GET(request());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'Unable to load Kalshi outcomes for this event.',
    });
  });

  it('returns a successful empty result when Kalshi loads with no outcomes', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kalshi: [],
      source: 'event-scoped',
    });
  });
});
