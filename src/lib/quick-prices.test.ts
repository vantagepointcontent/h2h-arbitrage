import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichQuickPmMarketsWithClobPrices } from './quick-prices';

function tokenBook(assetId: string, bid: string, ask: string) {
  return {
    asset_id: assetId,
    bids: [{ price: bid, size: '100' }],
    asks: [{ price: ask, size: '100' }],
    min_order_size: '5',
    tick_size: '0.01',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('enrichQuickPmMarketsWithClobPrices', () => {
  it('refreshes twenty neg-risk outcomes with one batched book request', async () => {
    const markets = Array.from({ length: 20 }, (_, index) => ({
      id: `pm-${index}`,
      conditionId: `condition-${index}`,
      question: `Outcome ${index}`,
      slug: `outcome-${index}`,
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.1","0.9"]',
      bestBid: 0.1,
      bestAsk: 0.11,
      lastTradePrice: 0.1,
      active: true,
      closed: false,
      negRisk: true,
      clobTokenIds: JSON.stringify([`yes-quick-${index}`, `no-quick-${index}`]),
    }));
    const responseBooks = markets.flatMap((_, index) => [
      tokenBook(`yes-quick-${index}`, '0.39', '0.40'),
      tokenBook(`no-quick-${index}`, '0.60', '0.61'),
    ]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responseBooks), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const enriched = await enrichQuickPmMarketsWithClobPrices(markets);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(enriched).toHaveLength(20);
    expect(enriched.every((market) => market.bestAsk === 0.4)).toBe(true);
    expect(enriched.every((market) => JSON.parse(market.outcomePrices)[1] === '0.610000')).toBe(true);
  });

  it('uses Gamma aggregate CLOB quotes for standard markets without a book request', async () => {
    const market = {
      id: 'pm-standard',
      conditionId: 'condition-standard',
      question: 'Standard market',
      slug: 'standard-market',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.1","0.9"]',
      bestBid: 0.43,
      bestAsk: 0.45,
      lastTradePrice: 0.44,
      active: true,
      closed: false,
      negRisk: false,
      clobTokenIds: '["yes-standard","no-standard"]',
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const [enriched] = await enrichQuickPmMarketsWithClobPrices([market]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(enriched.bestBid).toBe(0.43);
    expect(enriched.bestAsk).toBe(0.45);
    expect(enriched.outcomePrices).toBe('["0.450000","0.570000"]');
  });

  it('falls back to token books when standard aggregate quotes are malformed', async () => {
    const market = {
      id: 'pm-malformed-standard',
      conditionId: 'condition-malformed-standard',
      question: 'Malformed standard market',
      slug: 'malformed-standard-market',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.1","0.9"]',
      bestBid: Number.NaN,
      bestAsk: Number.POSITIVE_INFINITY,
      active: true,
      closed: false,
      negRisk: false,
      clobTokenIds: '["yes-malformed-standard","no-malformed-standard"]',
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      tokenBook('yes-malformed-standard', '0.44', '0.45'),
      tokenBook('no-malformed-standard', '0.54', '0.55'),
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const [enriched] = await enrichQuickPmMarketsWithClobPrices([market]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(enriched.clobEmpty).not.toBe(true);
    expect(enriched.bestAsk).toBe(0.45);
    expect(enriched.outcomePrices).toBe('["0.450000","0.550000"]');
  });

  it('fails closed when YES and NO share a malformed duplicate token id', async () => {
    const market = {
      id: 'pm-duplicate-token',
      conditionId: 'condition-duplicate-token',
      question: 'Duplicate token market',
      slug: 'duplicate-token-market',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.4","0.6"]',
      active: true,
      closed: false,
      negRisk: true,
      clobTokenIds: '["same-token-id","same-token-id"]',
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const [enriched] = await enrichQuickPmMarketsWithClobPrices([market]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(enriched.clobEmpty).toBe(true);
    expect(enriched.outcomePrices).toBe('[0,0]');
  });
});
