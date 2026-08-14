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
    expect(enriched.every((market) => market.askDepth === 40)).toBe(true);
    expect(enriched.every((market) => market.noAskDepth === 61)).toBe(true);
    expect(enriched.every((market) => market.yesBid === 0.39 && market.noBid === 0.6)).toBe(true);
    expect(enriched.every((market) => market.yesBidDepth === 100 && market.noBidDepth === 100)).toBe(true);
  });

  it('uses Gamma aggregate quotes and refreshes standard-market depth from token books', async () => {
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
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      tokenBook('yes-standard', '0.43', '0.45'),
      tokenBook('no-standard', '0.55', '0.57'),
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const [enriched] = await enrichQuickPmMarketsWithClobPrices([market]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(enriched.bestBid).toBe(0.43);
    expect(enriched.bestAsk).toBe(0.45);
    expect(enriched.outcomePrices).toBe('["0.450000","0.570000"]');
    expect(enriched.askDepth).toBe(45);
    expect(enriched.noAskDepth).toBeCloseTo(57, 8);
    expect(enriched).toMatchObject({ yesBid: 0.43, noBid: 0.55, yesBidDepth: 100, noBidDepth: 100 });
  });

  it('pairs standard-market executable prices with the same token-book depth level', async () => {
    const market = {
      id: 'pm-standard-lagged', conditionId: 'condition-standard-lagged', question: 'Lagged standard market', slug: 'lagged-standard',
      outcomes: '["Yes","No"]', outcomePrices: '["0.42","0.58"]', bestBid: 0.4, bestAsk: 0.42,
      lastTradePrice: 0.41, active: true, closed: false, negRisk: false,
      clobTokenIds: '["yes-lagged","no-lagged"]',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      tokenBook('yes-lagged', '0.48', '0.50'),
      tokenBook('no-lagged', '0.49', '0.51'),
    ]), { status: 200, headers: { 'content-type': 'application/json' } })));

    const [enriched] = await enrichQuickPmMarketsWithClobPrices([market]);

    expect(enriched.bestAsk).toBe(0.5);
    expect(enriched.askDepth).toBe(50);
    expect(enriched.outcomePrices).toBe('["0.500000","0.510000"]');
  });

  it('fails the venue refresh when the CLOB books request fails', async () => {
    const market = {
      id: 'pm-books-fail', conditionId: 'condition-books-fail', question: 'Books fail', slug: 'books-fail',
      outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', bestBid: 0.39, bestAsk: 0.4,
      active: true, closed: false, negRisk: false, clobTokenIds: '["yes-books-fail","no-books-fail"]',
    };
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enrichQuickPmMarketsWithClobPrices([market])).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the linked event when only an unrelated outcome book is unavailable', async () => {
    const markets = [0, 1].map((index) => ({
      id: `pm-partial-${index}`, conditionId: `condition-partial-${index}`, question: `Partial ${index}`, slug: `partial-${index}`,
      outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', bestBid: 0.39, bestAsk: 0.4,
      active: true, closed: false, negRisk: false,
      clobTokenIds: JSON.stringify([`yes-partial-${index}`, `no-partial-${index}`]),
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      tokenBook('yes-partial-0', '0.39', '0.4'), tokenBook('no-partial-0', '0.59', '0.6'),
    ]), { status: 200, headers: { 'content-type': 'application/json' } })));

    const enriched = await enrichQuickPmMarketsWithClobPrices(markets);

    expect(enriched[0].bestAsk).toBe(0.4);
    expect(enriched[1].askDepth).toBe(0);
    expect(enriched[1].noAskDepth).toBe(0);
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
