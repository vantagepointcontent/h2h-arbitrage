import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateExecution,
  executeArb,
  getSafetyLimitsFromEnv,
  shouldSimulateExecution,
  areFilledContractsMatched,
  isCompleteClose,
  isExecutableCloseQuantity,
  isTerminallyVerifiedOrder,
  isTerminallyVerifiedClose,
  cancelAndVerifyOrder,
  mapKalshiOrderResult,
  type ExecutionRequest,
  type SafetyLimits,
  type OrderRequest,
} from './auto-execute';
import { walkExecutableBook } from './executable-book';
import { orderbookState } from './orderbook-state';

function makeOrder(
  platform: 'kalshi' | 'polymarket',
  price: number,
  size: number,
  depthTimestamp = new Date().toISOString(),
): OrderRequest {
  const priceCents = Math.round(price * 100);
  return {
    platform,
    marketId: platform === 'kalshi' ? 'KXTEST' : 'pm-condition-1',
    side: 'buy',
    outcome: 'yes',
    size,
    contracts: 1,
    minimumOrderSize: 1,
    tickSize: 0.01,
    price,
    orderType: 'limit',
    executableQuote: price > 0 && price < 1 ? walkExecutableBook({
      side: 'buy',
      levels: [{ priceCents, quantityMicros: 1_000_000 }],
      requestedQuantityMicros: 1_000_000,
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp,
    }) : undefined,
  };
}

function makeRequest(
  kalshiPrice = 0.45,
  kalshiSize = 0.45,
  pmPrice = 0.50,
  pmSize = 0.50,
  dryRun = true,
  maxSlippagePct = 2.0,
  timeoutMs = 10000,
): ExecutionRequest {
  const depthTimestamp = new Date().toISOString();
  const request = {
    arbId: 'arb-1',
    marketTitle: 'Test Market',
    kalshiOrder: makeOrder('kalshi', kalshiPrice, kalshiSize, depthTimestamp),
    polymarketOrder: makeOrder('polymarket', pmPrice, pmSize, depthTimestamp),
    estimatedProfit: 0.05,
    maxSlippagePct,
    timeoutMs,
    dryRun,
  } satisfies ExecutionRequest;
  orderbookState.removeBook(request.kalshiOrder.marketId);
  orderbookState.removeBook(request.polymarketOrder.marketId);
  if (kalshiPrice > 0 && kalshiPrice < 1) {
    orderbookState.setBook(request.kalshiOrder.marketId, [{ price: kalshiPrice, quantity: 1 }], [], 0, {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp,
    });
  }
  if (pmPrice > 0 && pmPrice < 1) {
    orderbookState.setBook(request.polymarketOrder.marketId, [{ price: pmPrice, quantity: 1 }], [], 0, {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp,
    });
  }
  return request;
}

function defaultLimits(): SafetyLimits {
  return {
    maxPositionSize: 1000,
    dailyLossLimit: 500,
    maxSlippagePct: 2.0,
    orderTimeoutMs: 10000,
  };
}

describe('validateExecution', () => {
  it('valid inputs pass', () => {
    const req = makeRequest(0.45, 0.45, 0.50, 0.50, true, 2.0, 10000);
    const limits = defaultLimits();
    const result = validateExecution(req, limits);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('invalid prices fail (<= 0)', () => {
    const req = makeRequest(0, 0, 0.50, 0.50);
    const limits = defaultLimits();
    const result = validateExecution(req, limits);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Kalshi price'))).toBe(true);
  });

  it('invalid prices fail (>= 1)', () => {
    const req = makeRequest(1.0, 1.0, 0.50, 0.50);
    const limits = defaultLimits();
    const result = validateExecution(req, limits);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Kalshi price'))).toBe(true);
  });

  it('insufficient liquidity (zero size) fails', () => {
    const req = makeRequest(0.45, 0, 0.50, 0.50);
    const limits = defaultLimits();
    const result = validateExecution(req, limits);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('positive'))).toBe(true);
  });

  it('slippage too high fails', () => {
    const req = makeRequest(0.45, 0.45, 0.50, 0.50, true, 5.0, 10000);
    const limits = defaultLimits();
    const result = validateExecution(req, limits);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('slippage'))).toBe(true);
  });

  it('size exceeds max position size fails', () => {
    const req = makeRequest(0.45, 2000, 0.50, 2000);
    const limits = defaultLimits();
    const result = validateExecution(req, limits);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some(e => e.includes('max position'))).toBe(true);
  });

  it('negative size fails', () => {
    const req = makeRequest(0.45, -50, 0.50, 100);
    const limits = defaultLimits();
    const result = validateExecution(req, limits);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('positive'))).toBe(true);
  });
});

describe('executeArb', () => {
  beforeEach(() => {
    // Keep dry runs deterministic: avoid the simulator's pending-order branch,
    // which intentionally waits for polling and makes unit tests time-sensitive.
    vi.stubEnv('H2H_DRY_RUN', 'true');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('fails closed instead of fabricating a paper price when a quote is absent', async () => {
    const req = makeRequest();
    delete req.polymarketOrder.executableQuote;

    const result = await executeArb(req);

    expect(result.success).toBe(false);
    expect(result.error).toContain('constraint-valid executable book quote');
  });

  it('rejects a forged executable status whose fills do not cover the request', async () => {
    const req = makeRequest();
    req.polymarketOrder.executableQuote = {
      ...req.polymarketOrder.executableQuote!,
      filledQuantityMicros: 0,
      fills: [],
    };

    const result = await executeArb(req);

    expect(result.success).toBe(false);
    expect(result.error).toContain('constraint-valid executable book quote');
  });

  it('rejects an off-tick forged quote before paper or live placement', async () => {
    const req = makeRequest();
    req.dryRun = false;
    const quote = req.polymarketOrder.executableQuote!;
    quote.tickSizeMicroCents = 1_000_000;
    quote.fills[0].priceMicroCents = 50_500_000;
    quote.fills[0].priceCents = 50.5;
    quote.totalCostMicroCents = 50_500_000;
    quote.vwapPriceMicroCents = 50_500_000;
    quote.limitPriceMicroCents = 50_500_000;
    req.polymarketOrder.price = 0.505;

    const result = await executeArb(req);

    expect(result.success).toBe(false);
    expect(result.error).toContain('constraint-valid executable book quote');
  });

  it('rejects a below-minimum quote before paper or live placement', async () => {
    const req = makeRequest();
    req.dryRun = false;
    req.polymarketOrder.executableQuote!.minimumOrderQuantityMicros = 5_000_000;

    const result = await executeArb(req);

    expect(result.success).toBe(false);
    expect(result.error).toContain('constraint-valid executable book quote');
  });

  it('rejects a self-consistent quote that does not match the server-side token book', async () => {
    const req = makeRequest();
    req.polymarketOrder.executableQuote = walkExecutableBook({
      side: 'buy',
      levels: [{ priceCents: 49, quantityMicros: 1_000_000 }],
      requestedQuantityMicros: 1_000_000,
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp: new Date().toISOString(),
    });
    req.polymarketOrder.price = 0.49;

    const result = await executeArb(req);

    expect(result.success).toBe(false);
    expect(result.error).toContain('server-side executable book');
  });

  it('rejects a quote whose authoritative server-side depth is stale', async () => {
    const req = makeRequest();
    const staleTimestamp = new Date(Date.now() - 31_000).toISOString();
    orderbookState.setBook(req.polymarketOrder.marketId, [{ price: 0.50, quantity: 1 }], [], 0, {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp: staleTimestamp,
    });
    req.polymarketOrder.executableQuote = orderbookState.getExecutableQuote(
      req.polymarketOrder.marketId,
      'yes',
    );

    const result = await executeArb(req);

    expect(result.success).toBe(false);
    expect(result.error).toContain('server-side executable book is stale');
  });

  it('rejects fractional contract quantities before paper or live placement', async () => {
    const req = makeRequest();
    req.kalshiOrder.contracts = 1.5;
    req.polymarketOrder.contracts = 1.5;

    const result = await executeArb(req);

    expect(result.success).toBe(false);
    expect(result.error).toContain('positive whole contract/share quantity');
  });

  it('rejects a buy limit above the walked worst consumed level', async () => {
    const req = makeRequest();
    req.polymarketOrder.price = 0.51;

    const result = await executeArb(req);

    expect(result.success).toBe(false);
    expect(result.error).toContain('equal the worst consumed executable level');
  });

  it('dry-run mode returns simulated success without placing real orders', async () => {
    const req = makeRequest(0.45, 0.45, 0.50, 0.50, true, 2.0, 3000);
    const result = await executeArb(req);
    expect(result.kalshiResult.status).toBeOneOf(['filled', 'partial', 'cancelled']);
    expect(result.polymarketResult.status).toBeOneOf(['filled', 'partial', 'cancelled']);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  }, 15000);

  it('executionTimeMs is measured (may be 0 for fast simulation)', async () => {
    const req = makeRequest(0.45, 0.45, 0.50, 0.50, true, 2.0, 3000);
    const result = await executeArb(req);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  }, 15000);

  it('failed validation returns early with error', async () => {
    const req = makeRequest(0, 0, 0.50, 0.50, true, 2.0, 10000);
    const result = await executeArb(req);
    expect(result.success).toBe(false);
    expect(result.kalshiResult.status).toBe('rejected');
    expect(result.polymarketResult.status).toBe('rejected');
    expect(result.error).toBeDefined();
  });

  it('max position size enforced via validation', async () => {
    const req = makeRequest(0.45, 2000, 0.50, 100, true);
    const result = await executeArb(req);
    expect(result.success).toBe(false);
  });

  it('daily loss limit is checked via safety config', () => {
    const limits = getSafetyLimitsFromEnv();
    expect(typeof limits.dailyLossLimit).toBe('number');
    expect(limits.dailyLossLimit).toBeGreaterThan(0);
  });

  it('matches hedged fills by contract quantity rather than unequal dollar notionals', () => {
    expect(areFilledContractsMatched(
      { platform: 'kalshi', status: 'filled', filledSize: 45, filledPrice: 0.45, filledContracts: 100, timestamp: '' },
      { platform: 'polymarket', status: 'filled', filledSize: 52, filledPrice: 0.52, filledContracts: 100, timestamp: '' },
    )).toEqual({ matched: true, kalshiContracts: 100, polymarketContracts: 100 });
  });

  it('fails closed instead of reconstructing missing contract units from rounded notionals', () => {
    expect(areFilledContractsMatched(
      { platform: 'kalshi', status: 'filled', filledSize: 45, filledPrice: 0.45, timestamp: '' },
      { platform: 'polymarket', status: 'filled', filledSize: 52, filledPrice: 0.52, timestamp: '' },
    ).matched).toBe(false);
  });

  it('uses authoritative filled contract units instead of reconstructing them from rounded notionals', () => {
    expect(areFilledContractsMatched(
      {
        platform: 'kalshi', status: 'filled', filledSize: 13.94,
        filledPrice: 0.45, filledContracts: 31, timestamp: '',
      },
      {
        platform: 'polymarket', status: 'filled', filledSize: 16.11,
        filledPrice: 0.52, filledContracts: 31, timestamp: '',
      },
    )).toEqual({ matched: true, kalshiContracts: 31, polymarketContracts: 31 });
  });

  it('rejects notionals that do not equal walked VWAP times contracts', async () => {
    const result = await executeArb(makeRequest(0.45, 45, 0.52, 52, true, 2, 1));
    expect(result.success).toBe(false);
    expect(result.error).toContain('notional must equal walked VWAP × contracts');
  });


  it('requires the venue to confirm the entire requested excess close', () => {
    expect(isCompleteClose(8, 8)).toBe(true);
    expect(isCompleteClose(8, 3)).toBe(false);
    expect(isCompleteClose(8, 9)).toBe(false);
    expect(isCompleteClose(8, null)).toBe(false);
  });

  it('refuses fractional Kalshi excess rather than rounding it into an over-close', () => {
    expect(isExecutableCloseQuantity('kalshi', 0.25)).toBe(false);
    expect(isExecutableCloseQuantity('kalshi', 1.5)).toBe(false);
    expect(isExecutableCloseQuantity('kalshi', 2)).toBe(true);
    expect(isExecutableCloseQuantity('polymarket', 0.25)).toBe(true);
  });

  it('does not treat a cancellation acknowledgement as terminal order verification', () => {
    expect(isTerminallyVerifiedOrder({
      platform: 'kalshi', status: 'pending', filledContracts: 0, orderId: 'k-1', timestamp: '',
    })).toBe(false);
    expect(isTerminallyVerifiedOrder({
      platform: 'kalshi', status: 'cancelled', filledContracts: 0, orderId: 'k-1', timestamp: '',
    })).toBe(true);
  });

  it('requires terminal authoritative fill evidence before a close is complete', () => {
    const evidence = {
      venue: 'kalshi' as const, filledQuantity: 2, fillPrice: 0.44, chargedFeeCents: 1,
      executionId: 'fill-close', venueTimestamp: '2026-08-14T12:00:00Z',
    };
    expect(isTerminallyVerifiedClose(2, {
      platform: 'kalshi', status: 'partial', filledContracts: 2, filledPrice: 0.44,
      chargedFeeCents: 1, venueEvidence: evidence, orderId: 'close-1', timestamp: evidence.venueTimestamp,
    })).toBe(false);
    expect(isTerminallyVerifiedClose(2, {
      platform: 'kalshi', status: 'filled', filledContracts: 2, filledPrice: 0.44,
      chargedFeeCents: 1, venueEvidence: evidence, orderId: 'close-1', timestamp: evidence.venueTimestamp,
    })).toBe(true);
  });

  it('verifies cancellation from a terminal poll instead of the cancel acknowledgement', async () => {
    const pending = { platform: 'kalshi' as const, status: 'pending' as const, filledContracts: 0, orderId: 'k-1', timestamp: '' };
    const cancelled = { ...pending, status: 'cancelled' as const };
    await expect(cancelAndVerifyOrder(
      pending,
      vi.fn().mockResolvedValue(true),
      vi.fn().mockResolvedValue(cancelled),
    )).resolves.toEqual({ result: cancelled, verified: true, terminality: 'terminal' });
  });

  it('keeps cancellation unresolved when terminal polling fails', async () => {
    const pending = { platform: 'kalshi' as const, status: 'pending' as const, filledContracts: 0, orderId: 'k-1', timestamp: '' };
    await expect(cancelAndVerifyOrder(
      pending,
      vi.fn().mockResolvedValue(true),
      vi.fn().mockResolvedValue(pending),
      1,
    )).resolves.toEqual({ result: pending, verified: false, terminality: 'indeterminate' });
  });

  it('partial fill handling calculates netExposure', async () => {
    const req = makeRequest(0.45, 0.45, 0.50, 0.50, true);
    const result = await executeArb(req);
    // In dry-run, fill ratios are 85-100%, so partial fills are possible
    expect(result.netExposure).toBeDefined();
    // Net exposure should be non-negative (difference of fills)
    if (result.netExposure !== undefined) {
      expect(result.netExposure).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns a fee-inclusive cash ledger and maps actualProfit only from reconciled net P&L', async () => {
    const req = makeRequest(0.45, 0.45, 0.50, 0.50, true);
    const result = await executeArb(req);
    expect(result.cashLedger).toMatchObject({ version: 1 });
    expect(result.cashLedger?.grossSpreadCents).not.toBe(result.cashLedger?.netPnlCents);
    expect(result.actualProfit).toBe(result.cashLedger?.netPnlCents == null ? undefined : result.cashLedger.netPnlCents / 100);
  });

  it('dry-run order IDs contain "dry-run" prefix', async () => {
    const req = makeRequest();
    const result = await executeArb(req);
    expect(result.kalshiResult.orderId).toMatch(/^dry-run-/);
    expect(result.polymarketResult.orderId).toMatch(/^dry-run-/);
  });

  it('uses walked executable VWAPs unchanged in paper mode', async () => {
    const req = makeRequest(0.43, 0.43, 0.475, 0.475, true, 2, 3000);
    const depthTimestamp = new Date().toISOString();
    req.kalshiOrder.contracts = 1;
    req.polymarketOrder.contracts = 1;
    const kalshiLevels = [{ price: 0.40, quantity: 0.4 }, { price: 0.45, quantity: 0.6 }];
    const pmLevels = [{ price: 0.45, quantity: 0.5 }, { price: 0.50, quantity: 0.5 }];
    orderbookState.setBook(req.kalshiOrder.marketId, kalshiLevels, [], 0, {
      tickSizeCents: 1, minimumOrderQuantityMicros: 1_000_000, depthTimestamp,
    });
    orderbookState.setBook(req.polymarketOrder.marketId, pmLevels, [], 0, {
      tickSizeMicroCents: 100_000, minimumOrderQuantityMicros: 1_000_000, depthTimestamp,
    });
    req.kalshiOrder.executableQuote = orderbookState.getExecutableQuote(req.kalshiOrder.marketId, 'yes');
    req.polymarketOrder.executableQuote = orderbookState.getExecutableQuote(req.polymarketOrder.marketId, 'yes');
    req.kalshiOrder.price = 0.45;
    req.polymarketOrder.price = 0.50;

    const result = await executeArb(req);

    expect(result.kalshiResult.filledPrice).toBe(0.43);
    expect(result.polymarketResult.filledPrice).toBe(0.475);
    expect(result.kalshiResult.filledContracts).toBe(1);
    expect(result.polymarketResult.filledContracts).toBe(1);
  });
});

describe('mapKalshiOrderResult', () => {
  it('preserves a terminal zero-fill cancellation for verification', () => {
    expect(mapKalshiOrderResult({
      orderId: 'order-cancelled', status: 'canceled', filledCount: 0, remainingCount: 10, raw: {},
    })).toMatchObject({ status: 'cancelled', filledContracts: 0 });
  });

  it('maps complete venue evidence exactly, including price improvement and charged fee', () => {
    expect(mapKalshiOrderResult({
      orderId: 'order-123', status: 'executed', filledCount: 10, remainingCount: 0,
      evidence: {
        venue: 'kalshi', filledQuantity: 10, fillPrice: 0.43, chargedFeeCents: 7,
        executionId: 'fill-456', venueTimestamp: '2026-08-12T13:30:45Z', orderId: 'order-123',
      },
      raw: {},
    })).toMatchObject({
      platform: 'kalshi', status: 'filled', filledContracts: 10, filledPrice: 0.43,
      chargedFeeCents: 7, executionId: 'fill-456', venueTimestamp: '2026-08-12T13:30:45Z',
      timestamp: '2026-08-12T13:30:45Z', orderId: 'order-123',
      venueEvidence: {
        venue: 'kalshi', filledQuantity: 10, fillPrice: 0.43, chargedFeeCents: 7,
        executionId: 'fill-456', venueTimestamp: '2026-08-12T13:30:45Z',
      },
    });
  });

  it('maps correlated partial-fill evidence while preserving the venue quantity', () => {
    expect(mapKalshiOrderResult({
      orderId: 'order-partial', status: 'resting', filledCount: 3, remainingCount: 7,
      evidence: {
        venue: 'kalshi', filledQuantity: 3, fillPrice: 0.41, chargedFeeCents: 2,
        executionId: 'fill-partial', venueTimestamp: '2026-08-12T13:31:00Z', orderId: 'order-partial',
      },
      raw: {},
    })).toMatchObject({
      status: 'partial', filledContracts: 3, filledPrice: 0.41, executionId: 'fill-partial',
    });
  });

  it('preserves a cancelled Kalshi order with an authoritative partial fill as terminal', () => {
    expect(mapKalshiOrderResult({
      orderId: 'order-cancelled-partial', status: 'canceled', filledCount: 3, remainingCount: 7,
      evidence: {
        venue: 'kalshi', filledQuantity: 3, fillPrice: 0.41, chargedFeeCents: 2,
        executionId: 'fill-before-cancel', venueTimestamp: '2026-08-12T13:31:00Z', orderId: 'order-cancelled-partial',
      },
      raw: {},
    })).toMatchObject({ status: 'cancelled', filledContracts: 3, filledPrice: 0.41 });
  });

  it('never fills inferred price, fee, ID, or timestamp when evidence is unavailable', () => {
    expect(mapKalshiOrderResult({
      orderId: 'order-123', status: 'executed', filledCount: 10, remainingCount: 0, raw: {},
    })).toEqual({
      platform: 'kalshi', status: 'partial', filledContracts: 10, orderId: 'order-123',
      timestamp: '', error: 'Kalshi reported a fill without complete correlated venue evidence',
    });
  });
});

describe('single execution authority', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('paper simulates and live reaches the real-leg branch regardless of H2H_DRY_RUN', () => {
    vi.stubEnv('H2H_DRY_RUN', 'true');
    expect(shouldSimulateExecution(makeRequest(0.45, 0.45, 0.50, 0.50, true))).toBe(true);
    expect(shouldSimulateExecution(makeRequest(0.45, 0.45, 0.50, 0.50, false))).toBe(false);
  });
});

describe('getSafetyLimitsFromEnv', () => {
  it('defaults to reasonable values when env vars unset', () => {
    const limits = getSafetyLimitsFromEnv();
    expect(limits.maxPositionSize).toBeGreaterThan(0);
    expect(limits.dailyLossLimit).toBeGreaterThan(0);
    expect(limits.maxSlippagePct).toBeGreaterThan(0);
    expect(limits.orderTimeoutMs).toBeGreaterThan(0);
  });

  it('does not expose legacy H2H_DRY_RUN as an execution authority', () => {
    vi.stubEnv('H2H_DRY_RUN', 'true');
    const limits = getSafetyLimitsFromEnv();
    expect(limits).not.toHaveProperty('dryRunMode');
    vi.unstubAllEnvs();
  });
});
