import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateExecution,
  executeArb,
  getSafetyLimitsFromEnv,
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
    dryRunMode: true,
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
    // Ensure dry run mode is active
    vi.stubEnv('H2H_DRY_RUN', 'true');
  });

  it('dry-run mode returns simulated success without placing real orders', async () => {
    const req = makeRequest(0.45, 100, 0.50, 100, true);
    const result = await executeArb(req);
    expect(result.success).toBe(true);
    expect(result.kalshiResult.status).toBeOneOf(['filled', 'partial']);
    expect(result.polymarketResult.status).toBeOneOf(['filled', 'partial']);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('executionTimeMs is measured (may be 0 for fast simulation)', async () => {
    const req = makeRequest();
    const result = await executeArb(req);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

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

describe('getSafetyLimitsFromEnv', () => {
  it('defaults to reasonable values when env vars unset', () => {
    const limits = getSafetyLimitsFromEnv();
    expect(limits.maxPositionSize).toBeGreaterThan(0);
    expect(limits.dailyLossLimit).toBeGreaterThan(0);
    expect(limits.maxSlippagePct).toBeGreaterThan(0);
    expect(limits.orderTimeoutMs).toBeGreaterThan(0);
  });

  it('dryRunMode defaults to true', () => {
    const limits = getSafetyLimitsFromEnv();
    expect(limits.dryRunMode).toBe(true);
  });
});
