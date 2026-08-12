import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllPolymarketMarkets } from './polymarket';

describe('fetchAllPolymarketMarkets offset pagination', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('prefetches bounded offset pages and stops after an empty window', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      conditionId: `condition-${index}`,
      question: `Market ${index}`,
      slug: `market-${index}`,
    }));
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const offset = Number(new URL(url).searchParams.get('offset') || 0);
      const body = offset === 0 ? firstPage : [];
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const markets = await fetchAllPolymarketMarkets();

    expect(markets).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('offset=100'))).toBe(true);
  });
});
