import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllKalshiMarkets, fetchKalshiEventMarkets } from './kalshi';

describe('fetchAllKalshiMarkets offset fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns partial results when a later page is rate limited', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        markets: [{ ticker: 'KX-PARTIAL', title: 'Partial', status: 'open' }],
      }), { status: 200 })))
      .mockImplementation(() => Promise.resolve(new Response('{}', { status: 429 })));
    vi.stubGlobal('fetch', fetchMock);
    const onPartial = vi.fn();

    const markets = await fetchAllKalshiMarkets({
      maxPages: 3,
      since: '2026-01-02T00:00:00.000Z',
      onPartial,
    });

    expect(markets.map((market) => market.ticker)).toEqual(['KX-PARTIAL']);
    expect(onPartial).toHaveBeenCalledWith('Kalshi API error: 429');
  });

  it('stops when an offset page adds no new tickers', async () => {
    const page = {
      markets: [
        { ticker: 'KX-ONE', title: 'One', status: 'open' },
        { ticker: 'KX-TWO', title: 'Two', status: 'open' },
      ],
    };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ));
    vi.stubGlobal('fetch', fetchMock);

    const markets = await fetchAllKalshiMarkets({ maxPages: 3, since: '2026-01-01T00:00:00.000Z' });

    expect(markets.map((market) => market.ticker)).toEqual(['KX-ONE', 'KX-TWO']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('offset=0');
  });

  it('attaches the HTTP receipt time and does not redate a cached Kalshi depth response', async () => {
    vi.setSystemTime(new Date('2026-08-30T17:30:00.000Z'));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      markets: [{ ticker: 'KX-OBSERVATION-UNIQUE', event_ticker: 'KX-OBSERVATION', status: 'open' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchKalshiEventMarkets('KX-OBSERVATION-UNIQUE');
    vi.setSystemTime(new Date('2026-08-30T17:30:20.000Z'));
    const cached = await fetchKalshiEventMarkets('KX-OBSERVATION-UNIQUE');

    expect(first[0]?.quoteObservedAt).toBe('2026-08-30T17:30:00.000Z');
    expect(cached[0]?.quoteObservedAt).toBe('2026-08-30T17:30:00.000Z');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
