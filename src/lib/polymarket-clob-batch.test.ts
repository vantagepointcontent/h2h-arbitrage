import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchClobBook,
  fetchClobBooks,
  fetchClobBooksDetailed,
  getClobPricesFromBooks,
  validateOneShareBookOrder,
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
  vi.useRealTimers();
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

describe('fetchClobBooksDetailed', () => {
  it('keeps exact-token successes when a sibling token is unavailable', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const tokenId = new URL(url).searchParams.get('token_id');
      return tokenId === 'fresh-token-detail'
        ? new Response(JSON.stringify(book(tokenId, ['0.40'], ['0.42'])), { status: 200 })
        : new Response('missing', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchClobBooksDetailed(
      ['fresh-token-detail', 'missing-token-detail'],
      { bypassCache: true, concurrency: 2, maxAttempts: 2, requestTimeoutMs: 100 },
    );

    expect(result.books.get('fresh-token-detail')?.asks[0]?.price).toBe('0.42');
    expect(result.books.get('missing-token-detail')).toBeNull();
    expect(result.diagnostics.get('fresh-token-detail')).toMatchObject({ status: 'success', attemptCount: 1 });
    expect(result.diagnostics.get('missing-token-detail')).toMatchObject({
      status: 'unavailable', attemptCount: 1, upstreamStatus: 404,
    });
    expect(result.metrics).toMatchObject({
      tokenCount: 2, successCount: 1, unavailableCount: 1, retryCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries only a transiently failed exact token and records attempts', async () => {
    const calls = new Map<string, number>();
    const fetchMock = vi.fn(async (url: string) => {
      const tokenId = new URL(url).searchParams.get('token_id')!;
      const count = (calls.get(tokenId) ?? 0) + 1;
      calls.set(tokenId, count);
      if (tokenId === 'retry-token-detail' && count === 1) return new Response('slow down', { status: 429 });
      return new Response(JSON.stringify(book(tokenId, ['0.40'], ['0.42'])), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchClobBooksDetailed(
      ['stable-token-detail', 'retry-token-detail', 'stable-token-detail', 'retry-token-detail'],
      { bypassCache: true, concurrency: 2, maxAttempts: 2, requestTimeoutMs: 100, retryBackoffMs: 0 },
    );

    expect(calls.get('stable-token-detail')).toBe(1);
    expect(calls.get('retry-token-detail')).toBe(2);
    expect(result.diagnostics.get('retry-token-detail')).toMatchObject({ status: 'success', attemptCount: 2 });
    expect(result.metrics).toMatchObject({ tokenCount: 2, successCount: 2, retryCount: 1, errorCount: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('classifies an exhausted exact-token timeout with its deadline source', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchClobBooksDetailed(
      ['timeout-token-detail'],
      { bypassCache: true, maxAttempts: 2, requestTimeoutMs: 100, retryBackoffMs: 0 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.diagnostics.get('timeout-token-detail')).toMatchObject({
      status: 'timeout', attemptCount: 2, deadlineSource: 'per-token',
      reason: 'The operation timed out',
    });
    expect(result.metrics).toMatchObject({ timeoutCount: 1, retryCount: 1, successCount: 0 });
  });

  it('cancels an in-flight exact-token request at the CLOB timeout boundary', async () => {
    let deliveredSignal: AbortSignal | null = null;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      deliveredSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        deliveredSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation timed out', 'TimeoutError'));
        }, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchClobBooksDetailed(
      ['cancelled-token-detail'],
      { bypassCache: true, maxAttempts: 1, requestTimeoutMs: 100, totalDeadlineMs: 100 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deliveredSignal).not.toBeNull();
    expect(deliveredSignal!.aborted).toBe(true);
    expect(result.diagnostics.get('cancelled-token-detail')).toMatchObject({
      status: 'timeout', attemptCount: 1, deadlineSource: 'per-token',
    });
    expect(result.metrics).toMatchObject({ tokenCount: 1, timeoutCount: 1, retryCount: 0 });
  });

  it('does not start a retry whose backoff would exceed the absolute refresh budget', async () => {
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchClobBooksDetailed(
      ['budget-token-detail'],
      { bypassCache: true, maxAttempts: 2, requestTimeoutMs: 100, totalDeadlineMs: 100, retryBackoffMs: 100 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.get('budget-token-detail')).toMatchObject({
      status: 'timeout', attemptCount: 1, deadlineSource: 'refresh-budget',
      reason: 'refresh budget 100ms exhausted',
    });
  });

  it('bounds shared semaphore queueing and removes the timed-out waiter', async () => {
    vi.useFakeTimers();
    const holderResolvers: Array<(response: Response) => void> = [];
    const fetchedTokens: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      const tokenId = new URL(url).searchParams.get('token_id')!;
      fetchedTokens.push(tokenId);
      if (tokenId.startsWith('holder-token-')) {
        return new Promise<Response>((resolve) => holderResolvers.push(resolve));
      }
      return Promise.resolve(new Response(
        JSON.stringify(book(tokenId, ['0.40'], ['0.42'])),
        { status: 200 },
      ));
    });
    vi.stubGlobal('fetch', fetchMock);

    const holders = Array.from({ length: 10 }, (_, index) =>
      fetchClobBook(`holder-token-${index}`, { bypassCache: true }));
    await vi.waitFor(() => expect(holderResolvers).toHaveLength(10));

    const startedAt = performance.now();
    const queuedResultPromise = fetchClobBooksDetailed(
      ['queued-deadline-token'],
      { bypassCache: true, maxAttempts: 2, requestTimeoutMs: 100, totalDeadlineMs: 100, retryBackoffMs: 0 },
    );
    await vi.advanceTimersByTimeAsync(100);
    const queuedResult = await queuedResultPromise;

    expect(performance.now() - startedAt).toBeLessThanOrEqual(100);
    expect(fetchedTokens).not.toContain('queued-deadline-token');
    expect(queuedResult.diagnostics.get('queued-deadline-token')).toMatchObject({
      status: 'timeout', attemptCount: 0, deadlineSource: 'refresh-budget',
      reason: 'refresh budget 100ms exhausted',
    });

    holderResolvers.forEach((resolve, index) => resolve(new Response(
      JSON.stringify(book(`holder-token-${index}`, ['0.40'], ['0.42'])),
      { status: 200 },
    )));
    await Promise.all(holders);

    const recovery = await fetchClobBooksDetailed(
      ['post-timeout-recovery-token'],
      { bypassCache: true, maxAttempts: 1, requestTimeoutMs: 100, totalDeadlineMs: 100 },
    );
    expect(fetchedTokens).toContain('post-timeout-recovery-token');
    expect(recovery.diagnostics.get('post-timeout-recovery-token')).toMatchObject({
      status: 'success', attemptCount: 1,
    });
  });
});

describe('validateOneShareBookOrder', () => {
  it('validates minimum, tick, and unsorted top-level depth for one share', () => {
    const validBook: ClobBook = {
      asset_id: 'expected-token',
      bids: [],
      asks: [{ price: '0.60', size: '10' }, { price: '0.40', size: '1' }],
      min_order_size: '0.5',
      tick_size: '0.01',
      timestamp: String(Date.now()),
    };
    expect(validateOneShareBookOrder(validBook, 'expected-token', 0.4)).toMatchObject({
      valid: true, minimumOrderSize: 0.5, tickSize: 0.01, bestAsk: 0.4, bestAskShares: 1,
    });
    expect(validateOneShareBookOrder({ ...validBook, min_order_size: '5' }, 'expected-token', 0.4).blocker)
      .toBe('Polymarket minimum order is 5 shares; requested 1 share');
    expect(validateOneShareBookOrder({ ...validBook, asks: [{ price: '0.40', size: '0.9' }] }, 'expected-token', 0.4).blocker)
      .toBe('Polymarket top-of-book depth 0.9 cannot fill requested 1 share');
    expect(validateOneShareBookOrder(validBook, 'expected-token', 0.405).blocker)
      .toBe('Polymarket limit price 0.405 is not aligned to tick size 0.01');
    expect(validateOneShareBookOrder(validBook, 'expected-token', 0.99).blocker)
      .toBe('Polymarket limit price 0.99 does not match authoritative best ask 0.4');
  });

  it('fails closed on mismatched token identity and malformed levels', () => {
    const validBook: ClobBook = {
      asset_id: 'expected-token', bids: [], asks: [{ price: '0.40', size: '1' }],
      min_order_size: '1', tick_size: '0.01', timestamp: String(Date.now()),
    };
    expect(validateOneShareBookOrder({ ...validBook, asset_id: 'wrong-token' }, 'expected-token', 0.4))
      .toMatchObject({ valid: false, blocker: 'Polymarket order book token does not match requested token' });
    expect(validateOneShareBookOrder({ ...validBook, asset_id: undefined }, 'expected-token', 0.4))
      .toMatchObject({ valid: false, blocker: 'Polymarket order book token is unavailable' });
    expect(validateOneShareBookOrder({ ...validBook, asks: {} as ClobBook['asks'] }, 'expected-token', 0.4))
      .toMatchObject({ valid: false, blocker: 'Polymarket order book asks are malformed' });
    expect(validateOneShareBookOrder({ ...validBook, bids: {} as ClobBook['bids'] }, 'expected-token', 0.4))
      .toMatchObject({ valid: false, blocker: 'Polymarket order book bids are malformed' });
    expect(validateOneShareBookOrder({ ...validBook, asks: [{ price: '0.40', size: 1 as unknown as string }] }, 'expected-token', 0.4))
      .toMatchObject({ valid: false, blocker: 'Polymarket order book asks are malformed' });
  });

  it('accepts only fresh Unix epoch milliseconds encoded as a decimal string', () => {
    const validBook: ClobBook = {
      asset_id: 'expected-token', bids: [], asks: [{ price: '0.40', size: '1' }],
      min_order_size: '1', tick_size: '0.01', timestamp: String(Date.now()),
    };
    expect(validateOneShareBookOrder({ ...validBook, timestamp: undefined }, 'expected-token', 0.4).blocker)
      .toBe('Polymarket order book timestamp is unavailable');
    expect(validateOneShareBookOrder({ ...validBook, timestamp: '2026-08-14T13:00:00.000Z' }, 'expected-token', 0.4).blocker)
      .toBe('Polymarket order book timestamp is malformed');
    expect(validateOneShareBookOrder({ ...validBook, timestamp: String(Math.floor(Date.now() / 1000)) }, 'expected-token', 0.4).blocker)
      .toBe('Polymarket order book timestamp is malformed');
    expect(validateOneShareBookOrder({ ...validBook, timestamp: Date.now() as unknown as string }, 'expected-token', 0.4).blocker)
      .toBe('Polymarket order book timestamp is malformed');
    expect(validateOneShareBookOrder({ ...validBook, timestamp: '0' }, 'expected-token', 0.4).blocker)
      .toBe('Polymarket order book is stale');
    expect(validateOneShareBookOrder({ ...validBook, timestamp: String(Date.now() + 60_000) }, 'expected-token', 0.4).blocker)
      .toBe('Polymarket order book timestamp is in the future');
  });
});

describe('fetchClobBook cache policy', () => {
  it('bypasses a cached book for authoritative pre-placement reads', async () => {
    const first = {
      asset_id: 'fresh-token', bids: [], asks: [{ price: '0.40', size: '1' }],
      min_order_size: '1', tick_size: '0.01',
    };
    const changed = { ...first, asks: [{ price: '0.50', size: '1' }], min_order_size: '5' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => first })
      .mockResolvedValueOnce({ ok: true, json: async () => changed });
    vi.stubGlobal('fetch', fetchMock);

    expect((await fetchClobBook('fresh-token'))?.min_order_size).toBe('1');
    expect((await fetchClobBook('fresh-token', { bypassCache: true }))?.min_order_size).toBe('5');
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      yesAskDepth: 42,
      noAskDepth: 59,
      yesBid: 0.4,
      noBid: 0.57,
      yesBidDepth: 100,
      noBidDepth: 100,
      yesMinOrderSize: 5,
      noMinOrderSize: 5,
      yesTickSize: 0.01,
      noTickSize: 0.01,
    });
  });

  it('keeps shuffled explicit token asks and sub-share top depth with constraints', () => {
    const clob: ClobMarket = {
      condition_id: 'condition', neg_risk: true,
      tokens: [{ token_id: 'yes', outcome: 'Yes' }, { token_id: 'no', outcome: 'No' }],
    };
    const yesBook: ClobBook = {
      asset_id: 'yes', bids: [{ price: '0.20', size: '9' }],
      asks: [{ price: '0.45', size: '10' }, { price: '0.40', size: '0.75' }, { price: '0.40', size: '0.20' }],
      min_order_size: '5', tick_size: '0.01',
    };
    const noBook: ClobBook = {
      asset_id: 'no', bids: [], asks: [{ price: '0.65', size: '9' }, { price: '0.55', size: '3' }],
      min_order_size: '5', tick_size: '0.01',
    };

    const prices = getClobPricesFromBooks(clob, yesBook, noBook);
    expect(prices).toMatchObject({
      yesPrice: 0.4, noPrice: 0.55,
      yesMinOrderSize: 5, noMinOrderSize: 5,
      yesTickSize: 0.01, noTickSize: 0.01,
    });
    expect(prices?.yesAskDepth).toBeCloseTo(0.38, 12);
    expect(prices?.noAskDepth).toBeCloseTo(1.65, 12);
  });
});
