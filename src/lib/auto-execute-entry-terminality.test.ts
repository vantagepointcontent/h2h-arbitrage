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

import { executeArb, type ExecutionRequest } from './auto-execute';
import type { VenueExecutionEvidence } from './execution-evidence';

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
  return {
    arbId: 'bug-153', marketTitle: 'Terminal entry regression', estimatedProfit: 0.25,
    maxSlippagePct: 2, timeoutMs: 1, dryRun: false,
    kalshiOrder: {
      platform: 'kalshi', marketId: 'KXBUG153', ticker: 'KXBUG153', side: 'buy', outcome: 'yes',
      size: 2.25, contracts: 5, price: 0.45, orderType: 'limit',
    },
    polymarketOrder: {
      platform: 'polymarket', marketId: 'pm-bug-153', conditionId: 'pm-token-bug-153', side: 'buy', outcome: 'yes',
      size: 2.5, contracts: 5, price: 0.5, orderType: 'limit',
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
  });

  afterEach(() => vi.restoreAllMocks());

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
});
