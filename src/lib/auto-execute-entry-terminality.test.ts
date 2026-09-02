import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  placeKalshiOrder: vi.fn(),
  getKalshiOrder: vi.fn(),
  cancelKalshiOrder: vi.fn(),
  placeKalshiSellOrder: vi.fn(),
  placePmOrder: vi.fn(),
  getPmOrder: vi.fn(),
  cancelPmOrder: vi.fn(),
  placePmSellOrder: vi.fn(),
  seedKalshiBook: vi.fn(),
  seedPmBook: vi.fn(),
}));

vi.mock('./kalshi-orders', () => ({
  placeKalshiOrder: mocks.placeKalshiOrder,
  getKalshiOrder: mocks.getKalshiOrder,
  cancelKalshiOrder: mocks.cancelKalshiOrder,
  placeKalshiSellOrder: mocks.placeKalshiSellOrder,
}));
vi.mock('./polymarket-orders', async (importOriginal) => {
  const original = await importOriginal<typeof import('./polymarket-orders')>();
  return {
    ...original,
    placePmOrder: mocks.placePmOrder,
    getPmOrder: mocks.getPmOrder,
    cancelPmOrder: mocks.cancelPmOrder,
    placePmSellOrder: mocks.placePmSellOrder,
  };
});
vi.mock('./book-seed', () => ({
  seedKalshiBook: mocks.seedKalshiBook,
  seedPmBook: mocks.seedPmBook,
}));

import { executeArb, type ExecutionRequest } from './auto-execute';
import type { VenueExecutionEvidence } from './execution-evidence';
import { walkExecutableBook } from './executable-book';
import { orderbookState } from './orderbook-state';

function evidence(
  venue: 'kalshi' | 'polymarket',
  quantity: number,
  price: number,
  fee: number,
  suffix: string,
): VenueExecutionEvidence {
  return {
    venue,
    filledQuantity: quantity,
    fillPrice: price,
    chargedFeeCents: fee,
    executionId: `${venue}-fill-${suffix}`,
    venueTimestamp: `2026-08-14T12:0${suffix}:00.000Z`,
  };
}

function kalshiOrder(status: string, quantity: number, fee: number, suffix: string) {
  return {
    orderId: 'k-entry', status, filledCount: quantity, remainingCount: 5 - quantity,
    evidence: { ...evidence('kalshi', quantity, 0.45, fee, suffix), orderId: 'k-entry' }, raw: {},
  };
}

function pmOrder(status: string, quantity: number, fee: number, suffix: string) {
  const venueEvidence = evidence('polymarket', quantity, 0.5, fee, suffix);
  return {
    orderId: 'p-entry', status, success: true, filledContracts: quantity, venueEvidence, raw: {},
  };
}

function request(): ExecutionRequest {
  const depthTimestamp = new Date().toISOString();
  const quote = (priceCents: number) => walkExecutableBook({
    side: 'buy',
    levels: [{ priceCents, quantityMicros: 1_000_000 }],
    requestedQuantityMicros: 1_000_000,
    tickSizeCents: 1,
    minimumOrderQuantityMicros: 1_000_000,
    depthTimestamp,
  });
  orderbookState.setBook('KXBUG153', [{ price: 0.45, quantity: 1 }], [], 0, {
    tickSizeCents: 1, minimumOrderQuantityMicros: 1_000_000, depthTimestamp,
  });
  orderbookState.setBook('pm-token-bug-153', [{ price: 0.5, quantity: 1 }], [], 0, {
    tickSizeCents: 1, minimumOrderQuantityMicros: 1_000_000, depthTimestamp,
  });
  return {
    arbId: 'bug-153', marketTitle: 'Terminal entry regression', estimatedProfit: 0.25,
    maxSlippagePct: 2, timeoutMs: 1, dryRun: false,
    kalshiOrder: {
      platform: 'kalshi', marketId: 'KXBUG153', ticker: 'KXBUG153', side: 'buy', outcome: 'yes',
      size: 0.45, contracts: 1, minimumOrderSize: 1, tickSize: 0.01,
      price: 0.45, orderType: 'limit', executableQuote: quote(45),
    },
    polymarketOrder: {
      platform: 'polymarket', marketId: 'pm-bug-153', conditionId: 'pm-token-bug-153', side: 'buy', outcome: 'yes',
      size: 0.5, contracts: 1, minimumOrderSize: 1, tickSize: 0.01,
      price: 0.5, orderType: 'limit', executableQuote: quote(50),
    },
  };
}

function arrangeInitialMatchedPartial() {
  mocks.placeKalshiOrder.mockResolvedValue(kalshiOrder('resting', 2, 1, '1'));
  mocks.placePmOrder.mockResolvedValue(pmOrder('live', 2, 1, '1'));
  mocks.cancelKalshiOrder.mockResolvedValue(true);
  mocks.cancelPmOrder.mockResolvedValue(true);
}

describe('BUG-153 live entry terminality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    arrangeInitialMatchedPartial();
    mocks.seedKalshiBook.mockResolvedValue(undefined);
    mocks.seedPmBook.mockImplementation(async (tokenId: string) => {
      const observedAt = new Date().toISOString();
      orderbookState.setBook(tokenId, [{ price: 0.5, quantity: 1 }], [], 0, {
        tickSizeCents: 1, minimumOrderQuantityMicros: 1_000_000, depthTimestamp: observedAt,
      });
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('rejects fractional entry quantities before either venue adapter is called', async () => {
    const req = request();
    req.kalshiOrder.contracts = 1.5;
    req.polymarketOrder.contracts = 1.5;

    const result = await executeArb(req);

    expect(result.success).toBe(false);
    expect(result.error).toContain('positive whole contract/share quantity');
    expect(mocks.placeKalshiOrder).not.toHaveBeenCalled();
    expect(mocks.placePmOrder).not.toHaveBeenCalled();
  });

  it('places the exact authoritative mill-tick quote instead of an advisory rounded price', async () => {
    const req = request();
    const depthTimestamp = new Date().toISOString();
    const exactQuote = walkExecutableBook({
      side: 'buy',
      levels: [{ priceMicroCents: 42_500_000, quantityMicros: 1_000_000 }],
      requestedQuantityMicros: 1_000_000,
      tickSizeMicroCents: 100_000,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp,
    });
    req.kalshiOrder = {
      ...req.kalshiOrder,
      size: 0.425,
      price: 0.425,
      tickSize: 0.001,
      priceMicroCents: 43_000_000,
      tickSizeMicroCents: 1_000_000,
      executableQuote: exactQuote,
    };
    orderbookState.setBook('KXBUG153', [{ price: 0.425, quantity: 1 }], [], 0, {
      tickSizeMicroCents: 100_000, minimumOrderQuantityMicros: 1_000_000, depthTimestamp,
    });
    mocks.placeKalshiOrder.mockResolvedValue({
      orderId: 'k-entry', status: 'executed', filledCount: 1, remainingCount: 0,
      evidence: {
        ...evidence('kalshi', 1, 0.425, 1, '1'),
        orderId: 'k-entry',
      },
      raw: {},
    });
    mocks.placePmOrder.mockResolvedValue(pmOrder('matched', 1, 1, '1'));

    await executeArb(req);

    expect(mocks.placeKalshiOrder).toHaveBeenCalledWith(expect.objectContaining({
      ticker: 'KXBUG153', side: 'yes', count: 1,
      priceMicroCents: 42_500_000,
      tickSizeMicroCents: 100_000,
    }));
  });

  it('records terminal provenance when initially live entries fully fill on the ordinary poll path', async () => {
    mocks.placeKalshiOrder.mockResolvedValue({
      orderId: 'k-entry', status: 'resting', filledCount: 0, remainingCount: 5, raw: {},
    });
    mocks.placePmOrder.mockResolvedValue({
      orderId: 'p-entry', status: 'live', success: true, raw: { size_matched: '0' },
    });
    mocks.getKalshiOrder.mockResolvedValue(kalshiOrder('executed', 5, 2, '2'));
    mocks.getPmOrder.mockResolvedValue(pmOrder('matched', 5, 2, '2'));
    const req = request();
    req.timeoutMs = 5_000;

    const result = await executeArb(req);

    expect(result.kalshiResult.status).toBe('filled');
    expect(result.polymarketResult.status).toBe('filled');
    expect(result.cashLedger).toMatchObject({
      status: 'reconciled',
      matchedContracts: 5,
      entryPrincipalCents: 475,
      expectedSettlementCents: 500,
      totalEntryFeesCents: 4,
      netPnlCents: 21,
      entryOrders: [
        { venue: 'kalshi', terminality: 'terminal', source: 'latest-order-response' },
        { venue: 'polymarket', terminality: 'terminal', source: 'latest-order-response' },
      ],
    });
    expect(result.success).toBe(true);
    expect(mocks.cancelKalshiOrder).not.toHaveBeenCalled();
    expect(mocks.cancelPmOrder).not.toHaveBeenCalled();
  }, 10_000);

  it('revalidates the pending leg before the first poll can report it filled', async () => {
    mocks.placeKalshiOrder.mockResolvedValue(kalshiOrder('executed', 1, 1, '1'));
    mocks.placePmOrder.mockResolvedValue({
      orderId: 'p-entry', status: 'live', success: true, raw: { size_matched: '0' },
    });
    mocks.getPmOrder.mockResolvedValue(pmOrder('matched', 1, 1, '2'));
    const req = request();
    req.timeoutMs = 5_000;

    const result = await executeArb(req);

    expect(result.tickCheck).toMatchObject({ triggered: true, legChecked: 'polymarket' });
    expect(mocks.seedPmBook).toHaveBeenCalledWith('pm-token-bug-153', 'yes');
    expect(mocks.seedPmBook.mock.invocationCallOrder[0]).toBeLessThan(mocks.getPmOrder.mock.invocationCallOrder[0]);
  }, 10_000);

  it('cancels and re-polls matched live partials, recaptures equal late fills, and reconciles only terminal evidence', async () => {
    mocks.getKalshiOrder.mockResolvedValue(kalshiOrder('canceled', 3, 2, '2'));
    mocks.getPmOrder.mockResolvedValue(pmOrder('canceled', 3, 2, '2'));

    const result = await executeArb(request());

    expect(mocks.cancelKalshiOrder).toHaveBeenCalledWith('k-entry');
    expect(mocks.cancelPmOrder).toHaveBeenCalledWith('p-entry');
    expect(mocks.getKalshiOrder).toHaveBeenCalledWith('k-entry');
    expect(mocks.getPmOrder).toHaveBeenCalledWith('p-entry');
    expect(result.kalshiResult).toMatchObject({ status: 'cancelled', filledContracts: 3, chargedFeeCents: 2 });
    expect(result.polymarketResult).toMatchObject({ status: 'cancelled', filledContracts: 3, chargedFeeCents: 2 });
    expect(result.cashLedger).toMatchObject({
      status: 'reconciled', matchedContracts: 3, entryPrincipalCents: 285,
      expectedSettlementCents: 300, totalEntryFeesCents: 4, netPnlCents: 11,
      entryOrders: [
        { venue: 'kalshi', terminality: 'terminal', source: 'post-cancel-poll' },
        { venue: 'polymarket', terminality: 'terminal', source: 'post-cancel-poll' },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.unhedged).toBe(false);
  });

  it('fails closed immediately when either matched partial cancellation fails', async () => {
    mocks.cancelPmOrder.mockResolvedValue(false);
    mocks.getKalshiOrder.mockResolvedValue(kalshiOrder('canceled', 2, 1, '2'));

    const result = await executeArb(request());

    expect(result.success).toBe(false);
    expect(result.unhedged).toBe(true);
    expect(result.cashLedger?.status).toBe('reconciliation-required');
    expect(result.cashLedger?.issues).toContain('entry-order-not-terminal:polymarket:live');
    expect(result.alerts).toContainEqual(expect.objectContaining({ level: 'error' }));
  });

  it('fails closed when post-cancel status remains indeterminate', async () => {
    mocks.getKalshiOrder.mockResolvedValue(null);
    mocks.getPmOrder.mockResolvedValue(pmOrder('canceled', 2, 1, '2'));

    const result = await executeArb(request());

    expect(result.success).toBe(false);
    expect(result.unhedged).toBe(true);
    expect(result.cashLedger?.status).toBe('reconciliation-required');
    expect(result.cashLedger?.issues).toContain('entry-order-not-terminal:kalshi:indeterminate');
  });

  it.each([
    ['one leg', 3, 2],
    ['both legs to different totals', 4, 3],
  ])('recaptures late fills on %s and closes only the final post-cancel excess', async (_label, kalshiQuantity, pmQuantity) => {
    mocks.getKalshiOrder.mockResolvedValue(kalshiOrder('canceled', kalshiQuantity, 2, '2'));
    mocks.getPmOrder.mockResolvedValue(pmOrder('canceled', pmQuantity, 2, '2'));
    mocks.placeKalshiSellOrder.mockResolvedValue(kalshiOrder('executed', kalshiQuantity - pmQuantity, 1, '3'));

    const result = await executeArb(request());

    expect(mocks.placeKalshiSellOrder).toHaveBeenCalledWith(expect.objectContaining({ count: kalshiQuantity - pmQuantity }));
    expect(result.rollbackExecuted).toBe(true);
    expect(result.cashLedger?.matchedContracts).toBe(pmQuantity);
    expect(result.cashLedger?.status).toBe('reconciled');
    expect(result.success).toBe(false);
  });

  it('fails closed when an ordinary terminal poll regresses cumulative fills', async () => {
    mocks.placeKalshiOrder.mockResolvedValue(kalshiOrder('resting', 2, 1, '1'));
    mocks.placePmOrder.mockResolvedValue(pmOrder('live', 2, 1, '1'));
    mocks.getKalshiOrder.mockResolvedValue(kalshiOrder('executed', 1, 1, '2'));
    mocks.getPmOrder.mockResolvedValue(pmOrder('matched', 1, 1, '2'));
    const req = request();
    req.timeoutMs = 5_000;

    const result = await executeArb(req);

    expect(result.success).toBe(false);
    expect(result.unhedged).toBe(true);
    expect(result.cashLedger?.status).toBe('reconciliation-required');
    expect(result.cashLedger?.issues).toContain('entry-order-not-terminal:kalshi:indeterminate');
    expect(result.cashLedger?.issues).toContain('entry-order-not-terminal:polymarket:indeterminate');
    expect(result.alerts).toContainEqual(expect.objectContaining({
      level: 'error',
      message: expect.stringContaining('regressed cumulative fill'),
    }));
  }, 10_000);

  it('keeps regression indeterminate after later polls recover and forbids an excess close', async () => {
    mocks.placeKalshiOrder.mockResolvedValue(kalshiOrder('resting', 2, 1, '1'));
    mocks.placePmOrder.mockResolvedValue(pmOrder('live', 2, 1, '1'));
    mocks.getKalshiOrder
      .mockResolvedValueOnce(kalshiOrder('resting', 1, 1, '2'))
      .mockResolvedValueOnce(kalshiOrder('executed', 3, 1, '3'));
    mocks.getPmOrder
      .mockResolvedValueOnce(pmOrder('live', 1, 1, '2'))
      .mockResolvedValueOnce(pmOrder('matched', 2, 1, '3'));
    mocks.placeKalshiSellOrder.mockResolvedValue(kalshiOrder('executed', 1, 1, '4'));
    const req = request();
    req.timeoutMs = 7_000;

    const result = await executeArb(req);

    expect(mocks.placeKalshiSellOrder).not.toHaveBeenCalled();
    expect(mocks.placePmSellOrder).not.toHaveBeenCalled();
    expect(result.cashLedger?.entryOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ venue: 'kalshi', terminality: 'indeterminate' }),
      expect.objectContaining({ venue: 'polymarket', terminality: 'indeterminate' }),
    ]));
    expect(result.cashLedger?.status).toBe('reconciliation-required');
    expect(result.success).toBe(false);
    expect(result.unhedged).toBe(true);
  }, 12_000);

  it('does not close the other leg when a regressed entry later reports a failed status', async () => {
    mocks.placeKalshiOrder.mockResolvedValue(kalshiOrder('resting', 2, 1, '1'));
    mocks.placePmOrder.mockResolvedValue(pmOrder('live', 2, 1, '1'));
    mocks.getKalshiOrder.mockResolvedValue(kalshiOrder('canceled', 1, 1, '2'));
    mocks.getPmOrder.mockResolvedValue(pmOrder('matched', 2, 1, '2'));
    mocks.placePmSellOrder.mockResolvedValue(pmOrder('matched', 2, 1, '3'));
    const req = request();
    req.timeoutMs = 5_000;

    const result = await executeArb(req);

    expect(mocks.placeKalshiSellOrder).not.toHaveBeenCalled();
    expect(mocks.placePmSellOrder).not.toHaveBeenCalled();
    expect(result.cashLedger?.entryOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ venue: 'kalshi', terminality: 'indeterminate' }),
    ]));
    expect(result.cashLedger?.status).toBe('reconciliation-required');
    expect(result.success).toBe(false);
    expect(result.unhedged).toBe(true);
  }, 10_000);

  it('fails closed when the post-cancel poll regresses a cumulative fill', async () => {
    mocks.getKalshiOrder.mockResolvedValue(kalshiOrder('canceled', 1, 1, '2'));
    mocks.getPmOrder.mockResolvedValue(pmOrder('canceled', 2, 1, '2'));
    mocks.placePmSellOrder.mockResolvedValue(pmOrder('matched', 1, 1, '3'));

    const result = await executeArb(request());

    expect(mocks.placeKalshiSellOrder).not.toHaveBeenCalled();
    expect(mocks.placePmSellOrder).not.toHaveBeenCalled();
    expect(result.cashLedger?.entryOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ venue: 'kalshi', terminality: 'indeterminate' }),
      expect.objectContaining({ venue: 'polymarket', terminality: 'terminal' }),
    ]));
    expect(result.cashLedger?.matchedContracts).toBe(2);
    expect(result.alerts).toContainEqual(expect.objectContaining({
      level: 'error',
      message: expect.stringContaining('regressed cumulative fill'),
    }));
    expect(result.cashLedger?.status).toBe('reconciliation-required');
    expect(result.success).toBe(false);
    expect(result.unhedged).toBe(true);
  });

  it('keeps a transient post-cancel regression indeterminate after a later terminal recovery', async () => {
    mocks.getKalshiOrder
      .mockResolvedValueOnce(kalshiOrder('resting', 1, 1, '2'))
      .mockResolvedValueOnce(kalshiOrder('canceled', 3, 1, '3'));
    mocks.getPmOrder.mockResolvedValue(pmOrder('canceled', 2, 1, '2'));
    mocks.placeKalshiSellOrder.mockResolvedValue(kalshiOrder('executed', 1, 1, '4'));

    const result = await executeArb(request());

    expect(mocks.placeKalshiSellOrder).not.toHaveBeenCalled();
    expect(mocks.placePmSellOrder).not.toHaveBeenCalled();
    expect(result.cashLedger?.entryOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ venue: 'kalshi', terminality: 'indeterminate' }),
    ]));
    expect(result.cashLedger?.status).toBe('reconciliation-required');
    expect(result.success).toBe(false);
    expect(result.unhedged).toBe(true);
  });

  it('preserves the maximum intermediate post-cancel fill after a later regression', async () => {
    mocks.getKalshiOrder
      .mockResolvedValueOnce(kalshiOrder('resting', 4, 1, '2'))
      .mockResolvedValueOnce(kalshiOrder('canceled', 3, 1, '3'));
    mocks.getPmOrder.mockResolvedValue(pmOrder('canceled', 2, 1, '2'));
    mocks.placeKalshiSellOrder.mockResolvedValue(kalshiOrder('executed', 1, 1, '4'));

    const result = await executeArb(request());

    expect(mocks.placeKalshiSellOrder).not.toHaveBeenCalled();
    expect(mocks.placePmSellOrder).not.toHaveBeenCalled();
    expect(result.cashLedger?.entryPrincipalCents).toBe(280);
    expect(result.cashLedger?.entryOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ venue: 'kalshi', terminality: 'indeterminate' }),
    ]));
    expect(result.cashLedger?.status).toBe('reconciliation-required');
    expect(result.success).toBe(false);
    expect(result.unhedged).toBe(true);
  });
});
