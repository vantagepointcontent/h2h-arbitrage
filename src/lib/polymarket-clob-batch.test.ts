import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchClobBooks,
  getClobPricesFromBooks,
  type ClobBook,
  type ClobMarket,
} from './polymarket-clob';

function book(assetId: string, bids: string[], asks: string[]): ClobBook & { asset_id: string } {
  return {
    asset_id: assetId,
    bids: bids.map((price) => ({ price, size: '100' })),
    asks: asks.map((price) => ({ price, size: '100' })),
    min_order_size: '5',
    tick_size: '0.01',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchClobBooks', () => {
  it('fetches many token books in one POST and maps them by asset id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      book('yes-batch-token', ['0.40'], ['0.42']),
      book('no-batch-token', ['0.57'], ['0.59']),
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const books = await fetchClobBooks(['yes-batch-token', 'no-batch-token']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://clob.polymarket.com/books',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify([
          { token_id: 'yes-batch-token', side: 'BUY' },
          { token_id: 'no-batch-token', side: 'BUY' },
        ]),
      }),
    );
    expect(books.get('yes-batch-token')?.asks[0]?.price).toBe('0.42');
    expect(books.get('no-batch-token')?.asks[0]?.price).toBe('0.59');
  });

  it('rejects malformed batch books instead of exposing them to price parsing', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { asset_id: 'malformed-batch-token', bids: null, asks: 'not-an-array' },
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const books = await fetchClobBooks(['malformed-batch-token']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(books.get('malformed-batch-token')).toBeNull();
  });

  it('fails closed when a batch response repeats an asset id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      book('duplicate-batch-token', ['0.40'], ['0.42']),
      book('duplicate-batch-token', ['0.80'], ['0.82']),
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const books = await fetchClobBooks(['duplicate-batch-token']);

    expect(books.get('duplicate-batch-token')).toBeNull();
  });

  it('fails closed when malformed and valid entries share an asset id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { asset_id: 'mixed-duplicate-token', bids: null, asks: null },
      book('mixed-duplicate-token', ['0.40'], ['0.42']),
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const books = await fetchClobBooks(['mixed-duplicate-token']);

    expect(books.get('mixed-duplicate-token')).toBeNull();
  });
});

describe('getClobPricesFromBooks', () => {
  it('uses independent token-book asks for neg-risk YES and NO prices', () => {
    const clob: ClobMarket = {
      condition_id: 'neg-risk-batch-condition',
      neg_risk: true,
      tokens: [
        { token_id: 'yes-batch-token-2', outcome: 'Yes' },
        { token_id: 'no-batch-token-2', outcome: 'No' },
      ],
    };

    const prices = getClobPricesFromBooks(
      clob,
      book('yes-batch-token-2', ['0.40'], ['0.42']),
      book('no-batch-token-2', ['0.57'], ['0.59']),
    );

    expect(prices).toEqual({
      yesPrice: 0.42,
      noPrice: 0.59,
      bestBid: 0.4,
      bestAsk: 0.42,
      lastTradePrice: 0.42,
    });
  });
});
