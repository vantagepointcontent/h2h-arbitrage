import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchKalshiMarket: vi.fn(),
  fetchClobMarket: vi.fn(),
  getClobPrices: vi.fn(),
}));

vi.mock('./kalshi', () => ({ fetchKalshiMarket: mocks.fetchKalshiMarket }));
vi.mock('./polymarket-clob', () => ({
  fetchClobMarket: mocks.fetchClobMarket,
  getClobPrices: mocks.getClobPrices,
}));

import {
  fetchCurrentLegQuotes,
  getCurrentQuoteCacheSizeForTests,
  resetCurrentQuoteStateForTests,
} from './current-log-quotes.server';

const PM_MARKET_ID = `0x${'ab'.repeat(32)}`;

describe('fetchCurrentLegQuotes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
    vi.clearAllMocks();
    resetCurrentQuoteStateForTests();
  });

  afterEach(() => vi.useRealTimers());

  it('fetches the exact captured market and outcome executable asks', async () => {
    mocks.fetchKalshiMarket.mockResolvedValue({ ticker: 'KX-EXACT', status: 'active', yes_ask_dollars: '0.47', no_ask_dollars: '0.55' });
    mocks.fetchClobMarket.mockResolvedValue({ condition_id: PM_MARKET_ID, active: true, closed: false, tokens: [] });
    mocks.getClobPrices.mockResolvedValue({ yesPrice: 0.62, noPrice: 0.39, bestAsk: 0.62, bestBid: 0.61, lastTradePrice: 0.6 });

    const quotes = await fetchCurrentLegQuotes([
      { platform: 'kalshi', marketId: 'KX-EXACT', outcome: 'yes' },
      { platform: 'polymarket', marketId: PM_MARKET_ID, outcome: 'no' },
    ]);

    expect(mocks.fetchKalshiMarket).toHaveBeenCalledWith('KX-EXACT');
    expect(mocks.fetchClobMarket).toHaveBeenCalledWith(PM_MARKET_ID);
    expect(quotes.map((quote) => ({ ...quote, quotedAt: '<time>' }))).toEqual([
      { platform: 'kalshi', marketId: 'KX-EXACT', outcome: 'yes', status: 'available', priceNow: 0.47, source: 'Executable best ask', stale: false, quotedAt: '<time>' },
      { platform: 'polymarket', marketId: PM_MARKET_ID, outcome: 'no', status: 'available', priceNow: 0.39, source: 'Executable best ask', stale: false, quotedAt: '<time>' },
    ]);
  });

  it('reports closed and unavailable quotes without fabricating zero', async () => {
    mocks.fetchKalshiMarket.mockResolvedValue({ ticker: 'KX-CLOSED', status: 'closed' });
    mocks.fetchClobMarket.mockResolvedValue(null);

    const quotes = await fetchCurrentLegQuotes([
      { platform: 'kalshi', marketId: 'KX-CLOSED', outcome: 'no' },
      { platform: 'polymarket', marketId: '0xmissing', outcome: 'yes' },
    ]);

    expect(quotes[0]).toMatchObject({ status: 'closed', priceNow: null });
    expect(quotes[1]).toMatchObject({ status: 'unavailable', priceNow: null });
  });

  it('deduplicates identical in-flight/current quote requests briefly', async () => {
    mocks.fetchKalshiMarket.mockResolvedValue({ ticker: 'KX-CACHE', status: 'active', yes_ask_dollars: '0.51' });
    const legs = [{ platform: 'kalshi' as const, marketId: 'KX-CACHE', outcome: 'yes' as const }];

    await fetchCurrentLegQuotes(legs);
    await fetchCurrentLegQuotes(legs);

    expect(mocks.fetchKalshiMarket).toHaveBeenCalledTimes(1);
  });

  it('does not collide exact market identities that differ only by case', async () => {
    mocks.fetchKalshiMarket.mockImplementation(async (ticker: string) => ({ ticker, status: 'active', yes_ask_dollars: '0.51' }));

    await fetchCurrentLegQuotes([{ platform: 'kalshi', marketId: 'KX-Case', outcome: 'yes' }]);
    await fetchCurrentLegQuotes([{ platform: 'kalshi', marketId: 'kx-case', outcome: 'yes' }]);

    expect(mocks.fetchKalshiMarket).toHaveBeenNthCalledWith(1, 'KX-Case');
    expect(mocks.fetchKalshiMarket).toHaveBeenNthCalledWith(2, 'kx-case');
  });

  it('keeps the 20-second cache live through the exact boundary', async () => {
    mocks.fetchKalshiMarket.mockResolvedValue({ ticker: 'KX-TTL', status: 'active', yes_ask_dollars: '0.51' });
    const legs = [{ platform: 'kalshi' as const, marketId: 'KX-TTL', outcome: 'yes' as const }];

    await fetchCurrentLegQuotes(legs);
    await vi.advanceTimersByTimeAsync(20_000);
    await fetchCurrentLegQuotes(legs);
    expect(mocks.fetchKalshiMarket).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await fetchCurrentLegQuotes(legs);
    expect(mocks.fetchKalshiMarket).toHaveBeenCalledTimes(2);
  });

  it('uses an available quote as stale fallback through 120 seconds only', async () => {
    mocks.fetchKalshiMarket
      .mockResolvedValueOnce({ ticker: 'KX-STALE', status: 'active', yes_ask_dollars: '0.51' })
      .mockResolvedValue(null);
    const legs = [{ platform: 'kalshi' as const, marketId: 'KX-STALE', outcome: 'yes' as const }];

    await fetchCurrentLegQuotes(legs);
    await vi.advanceTimersByTimeAsync(20_001);
    await expect(fetchCurrentLegQuotes(legs)).resolves.toMatchObject([{ status: 'available', priceNow: 0.51, stale: true }]);

    await vi.advanceTimersByTimeAsync(99_999);
    await expect(fetchCurrentLegQuotes(legs)).resolves.toMatchObject([{ status: 'available', priceNow: 0.51, stale: true }]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(fetchCurrentLegQuotes(legs)).resolves.toMatchObject([{ status: 'unavailable', priceNow: null, stale: false }]);
  });

  it('deduplicates concurrent requests for the same exact two-leg key', async () => {
    let resolveKalshi!: (value: unknown) => void;
    let resolvePolymarket!: (value: unknown) => void;
    mocks.fetchKalshiMarket.mockReturnValue(new Promise((resolve) => { resolveKalshi = resolve; }));
    mocks.fetchClobMarket.mockReturnValue(new Promise((resolve) => { resolvePolymarket = resolve; }));
    mocks.getClobPrices.mockResolvedValue({ yesPrice: 0.6, noPrice: 0.4 });
    const legs = [
      { platform: 'kalshi' as const, marketId: 'KX-CONCURRENT', outcome: 'yes' as const },
      { platform: 'polymarket' as const, marketId: PM_MARKET_ID, outcome: 'no' as const },
    ];

    const first = fetchCurrentLegQuotes(legs);
    const second = fetchCurrentLegQuotes(legs);
    expect(mocks.fetchKalshiMarket).toHaveBeenCalledTimes(1);
    expect(mocks.fetchClobMarket).toHaveBeenCalledTimes(1);

    resolveKalshi({ ticker: 'KX-CONCURRENT', status: 'active', yes_ask_dollars: '0.52' });
    resolvePolymarket({ condition_id: PM_MARKET_ID, active: true, closed: false, tokens: [] });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('bounds and expires the cache under unique-key abuse', async () => {
    mocks.fetchKalshiMarket.mockImplementation(async (ticker: string) => ({ ticker, status: 'active', yes_ask_dollars: '0.51' }));
    mocks.fetchClobMarket.mockImplementation(async (conditionId: string) => ({ condition_id: conditionId, active: true, closed: false, tokens: [] }));
    mocks.getClobPrices.mockResolvedValue({ yesPrice: 0.49, noPrice: 0.51 });

    for (let index = 0; index < 300; index += 1) {
      await fetchCurrentLegQuotes([
        { platform: 'kalshi', marketId: `KX-ABUSE-${index}`, outcome: 'yes' },
        { platform: 'polymarket', marketId: `0x${index.toString(16).padStart(64, '0')}`, outcome: 'no' },
      ]);
    }

    expect(getCurrentQuoteCacheSizeForTests()).toBeLessThanOrEqual(256);
    await vi.advanceTimersByTimeAsync(120_001);
    await fetchCurrentLegQuotes([
      { platform: 'kalshi', marketId: 'KX-AFTER-TTL', outcome: 'yes' },
      { platform: 'polymarket', marketId: PM_MARKET_ID, outcome: 'no' },
    ]);
    expect(getCurrentQuoteCacheSizeForTests()).toBe(2);
  });
});
