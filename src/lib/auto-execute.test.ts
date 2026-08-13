import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateExecution,
  executeArb,
  getSafetyLimitsFromEnv,
  shouldSimulateExecution,
  areFilledContractsMatched,
  isCompleteClose,
  mapKalshiOrderResult,
  type ExecutionRequest,
  type SafetyLimits,
  type OrderRequest,
} from './auto-execute';

function makeOrder(platform: 'kalshi' | 'polymarket', price: number, size: number): OrderRequest {
  return {
    platform,
    marketId: platform === 'kalshi' ? 'KXTEST' : 'pm-condition-1',
    side: 'buy',
    outcome: 'yes',
    size,
    price,
    orderType: 'limit',
  };
}

function makeRequest(
  kalshiPrice = 0.45,
  kalshiSize = 100,
  pmPrice = 0.50,
  pmSize = 100,
  dryRun = true,
  maxSlippagePct = 2.0,
  timeoutMs = 10000,
): ExecutionRequest {
  return {
    arbId: 'arb-1',
    marketTitle: 'Test Market',
    kalshiOrder: makeOrder('kalshi', kalshiPrice, kalshiSize),
    polymarketOrder: makeOrder('polymarket', pmPrice, pmSize),
    estimatedProfit: 0.05,
    maxSlippagePct,
    timeoutMs,
    dryRun,
  };
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
    const req = makeRequest(0.45, 100, 0.50, 100, true, 2.0, 10000);
    const limits = defaultLimits();
    const result = validateExecution(req, limits);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('invalid prices fail (<= 0)', () => {
    const req = makeRequest(0, 100, 0.50, 100);
    const limits = defaultLimits();
    const result = validateExecution(req, limits);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Kalshi price'))).toBe(true);
  });

  it('invalid prices fail (>= 1)', () => {
    const req = makeRequest(1.0, 100, 0.50, 100);
    const limits = defaultLimits();
    const result = validateExecution(req, limits);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Kalshi price'))).toBe(true);
  });

  it('insufficient liquidity (zero size) fails', () => {
    const req = makeRequest(0.45, 0, 0.50, 100);
    const limits = defaultLimits();
    const result = validateExecution(req, limits);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('positive'))).toBe(true);
  });

  it('slippage too high fails', () => {
    const req = makeRequest(0.45, 100, 0.50, 100, true, 5.0, 10000);
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

  it('dry-run mode returns simulated success without placing real orders', async () => {
    const req = makeRequest(0.45, 100, 0.50, 100, true, 2.0, 3000);
    const result = await executeArb(req);
    expect(result.kalshiResult.status).toBeOneOf(['filled', 'partial', 'cancelled']);
    expect(result.polymarketResult.status).toBeOneOf(['filled', 'partial', 'cancelled']);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  }, 15000);

  it('executionTimeMs is measured (may be 0 for fast simulation)', async () => {
    const req = makeRequest(0.45, 100, 0.50, 100, true, 2.0, 3000);
    const result = await executeArb(req);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  }, 15000);

  it('failed validation returns early with error', async () => {
    const req = makeRequest(0, 100, 0.50, 100, true, 2.0, 10000);
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

  it('retains the matched residual contracts after successfully closing an unequal-fill excess', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    random
      .mockReturnValueOnce(0.5) // Kalshi order fills
      .mockReturnValueOnce(0.5) // Kalshi slippage = 0
      .mockReturnValueOnce(0.9) // Kalshi gets the larger partial fill
      .mockReturnValueOnce(0.5) // Kalshi order id
      .mockReturnValueOnce(0.5) // PM order fills
      .mockReturnValueOnce(0.5) // PM slippage = 0
      .mockReturnValueOnce(0.5); // PM gets the smaller partial fill; later calls default to successful 0.5

    const result = await executeArb(makeRequest(0.45, 45, 0.52, 52, true, 2, 1));

    expect(result.rollbackExecuted).toBe(true);
    expect(result.unhedged).toBe(false);
    expect(result.kalshiResult.filledContracts).toBe(92);
    expect(result.polymarketResult.filledContracts).toBe(92);
  });

  it('requires the venue to confirm the entire requested excess close', () => {
    expect(isCompleteClose(8, 8)).toBe(true);
    expect(isCompleteClose(8, 3)).toBe(false);
    expect(isCompleteClose(8, null)).toBe(false);
  });

  it('partial fill handling calculates netExposure', async () => {
    const req = makeRequest(0.45, 100, 0.50, 100, true);
    const result = await executeArb(req);
    // In dry-run, fill ratios are 85-100%, so partial fills are possible
    expect(result.netExposure).toBeDefined();
    // Net exposure should be non-negative (difference of fills)
    if (result.netExposure !== undefined) {
      expect(result.netExposure).toBeGreaterThanOrEqual(0);
    }
  });

  it('actualProfit is computed from filled amounts', async () => {
    const req = makeRequest(0.45, 100, 0.50, 100, true);
    const result = await executeArb(req);
    expect(result.actualProfit).toBeDefined();
  });

  it('dry-run order IDs contain "dry-run" prefix', async () => {
    const req = makeRequest();
    const result = await executeArb(req);
    expect(result.kalshiResult.orderId).toMatch(/^dry-run-/);
    expect(result.polymarketResult.orderId).toMatch(/^dry-run-/);
  });
});

describe('mapKalshiOrderResult', () => {
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
    expect(shouldSimulateExecution(makeRequest(0.45, 100, 0.50, 100, true))).toBe(true);
    expect(shouldSimulateExecution(makeRequest(0.45, 100, 0.50, 100, false))).toBe(false);
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
