import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orderbookState } from './orderbook-state';

const mocks = vi.hoisted(() => ({
  seedKalshiBook: vi.fn(),
  seedPmBook: vi.fn(),
}));
vi.mock('./book-seed', () => mocks);

import { tickCheckLeg, type OrderRequest } from './auto-execute';

const tokenId = 'pm-live-token';
const order: OrderRequest = {
  platform: 'polymarket',
  marketId: tokenId,
  conditionId: tokenId,
  side: 'buy',
  outcome: 'no',
  size: 0.5,
  contracts: 1,
  minimumOrderSize: 1,
  tickSize: 0.01,
  price: 0.5,
  orderType: 'limit',
};

function setBook(price: number, quantity: number, observedAt = new Date().toISOString()) {
  orderbookState.removeBook(tokenId);
  orderbookState.setBook(tokenId, [], [{ price, quantity }], 0, {
    tickSizeCents: 1,
    minimumOrderQuantityMicros: 1_000_000,
    depthTimestamp: observedAt,
  });
}

describe('live post-leg-A exact-market revalidation', () => {
  beforeEach(() => {
    mocks.seedPmBook.mockReset().mockImplementation(async () => setBook(0.5, 1));
    mocks.seedKalshiBook.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => orderbookState.removeBook(tokenId));

  it('proceeds only when the refreshed exact token still has one-share depth at the submitted limit', async () => {
    await expect(tickCheckLeg('kalshi', order, 2, false)).resolves.toMatchObject({
      action: 'proceed',
      actualPrice: 0.5,
      priceMoved: false,
    });
    expect(mocks.seedPmBook).toHaveBeenCalledWith(tokenId, 'no');
  });

  it.each([
    ['second leg disappeared', () => setBook(0.5, 0), 'missing, stale, or lacks one-share executable depth'],
    ['second leg moved beyond the limit', () => setBook(0.51, 1), 'exceeds submitted limit'],
    ['second leg quote is stale', () => setBook(0.5, 1, '2026-01-01T00:00:00.000Z'), 'missing, stale, or lacks one-share executable depth'],
  ])('cancels when %s', async (_label, arrange, reason) => {
    mocks.seedPmBook.mockImplementation(async () => arrange());
    const result = await tickCheckLeg('kalshi', order, 2, false);
    expect(result).toMatchObject({ action: 'cancel', priceMoved: true });
    expect(result.reason).toContain(reason);
  });

  it('cancels on a rate-limit/network refresh failure', async () => {
    mocks.seedPmBook.mockRejectedValue(new Error('HTTP 429 rate limited'));
    const result = await tickCheckLeg('kalshi', order, 2, false);
    expect(result).toMatchObject({ action: 'cancel', priceMoved: true });
    expect(result.reason).toContain('HTTP 429');
  });
});
