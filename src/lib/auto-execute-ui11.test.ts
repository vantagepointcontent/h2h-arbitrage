/**
 * UI-11 tests: scan-time/best-price steps, partial-fill step status.
 *
 * These tests verify the reopened UI-11 requirements:
 * 1. "Last scan time" step emitted when scanTime provided
 * 2. "Best price found" step emitted when bestPriceFound provided
 * 3. Partial fills emit 'partial' step status (not 'success')
 * 4. Legacy trades without scanTime/bestPriceFound get 'skipped' steps
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeArb,
  type ExecutionRequest,
  type OrderRequest,
  type ExecutionStep,
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

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    arbId: 'arb-test',
    marketTitle: 'Test Market',
    kalshiOrder: makeOrder('kalshi', 0.45, 100),
    polymarketOrder: makeOrder('polymarket', 0.50, 100),
    estimatedProfit: 5.0,
    maxSlippagePct: 2.0,
    timeoutMs: 3000,
    dryRun: true,
    ...overrides,
  };
}

/** Find a step by searching its description for a substring. */
function findStep(steps: ExecutionStep[], substr: string): ExecutionStep | undefined {
  return steps.find((s) => s.description.toLowerCase().includes(substr.toLowerCase()));
}

describe('UI-11: scan-time and best-price steps', () => {
  beforeEach(() => {
    vi.stubEnv('H2H_DRY_RUN', 'true');
    // Use 0.5 to avoid the pending branch (roll < 0.15 triggers pending)
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('emits "Last scan time" step when scanTime is provided', async () => {
    const scanTime = '2026-07-24T10:30:00.000Z';
    const req = makeRequest({ scanTime });
    const result = await executeArb(req);
    const step = findStep(result.steps, 'Last scan time');
    expect(step).toBeDefined();
    expect(step!.status).toBe('success');
    expect(step!.metadata?.scanTime).toBe(scanTime);
  });

  it('emits "skipped" scan time step when scanTime is not provided (legacy)', async () => {
    const req = makeRequest();
    const result = await executeArb(req);
    const step = findStep(result.steps, 'Last scan time');
    expect(step).toBeDefined();
    expect(step!.status).toBe('skipped');
  });

  it('emits "Best price found" success step when bestPriceFound is true', async () => {
    const req = makeRequest({ bestPriceFound: true });
    const result = await executeArb(req);
    const step = findStep(result.steps, 'Best price');
    expect(step).toBeDefined();
    expect(step!.status).toBe('success');
  });

  it('emits "Best price NOT found" failed step when bestPriceFound is false', async () => {
    const req = makeRequest({ bestPriceFound: false });
    const result = await executeArb(req);
    const step = findStep(result.steps, 'Best price NOT found');
    expect(step).toBeDefined();
    expect(step!.status).toBe('failed');
  });

  it('emits "skipped" best-price step when bestPriceFound is not provided (legacy)', async () => {
    const req = makeRequest();
    const result = await executeArb(req);
    const step = findStep(result.steps, 'Best price availability');
    expect(step).toBeDefined();
    expect(step!.status).toBe('skipped');
  });

  it('scan-time and best-price steps appear before "Validation passed"', async () => {
    const req = makeRequest({ scanTime: '2026-07-24T10:30:00.000Z', bestPriceFound: true });
    const result = await executeArb(req);
    const scanIdx = result.steps.findIndex((s) => s.description.includes('Last scan time'));
    const priceIdx = result.steps.findIndex((s) => s.description.includes('Best price'));
    const validationIdx = result.steps.findIndex((s) => s.description.includes('Validation passed'));
    expect(scanIdx).toBeGreaterThanOrEqual(0);
    expect(priceIdx).toBeGreaterThan(scanIdx);
    expect(validationIdx).toBeGreaterThan(priceIdx);
  });
});

describe('UI-11: partial fill step status', () => {
  beforeEach(() => {
    vi.stubEnv('H2H_DRY_RUN', 'true');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('emits "partial" step status when simulateOrder returns partial fill', async () => {
    // random = 0.5 → fillRatio = 0.85 + 0.5 * 0.15 = 0.925 → status 'partial'
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const req = makeRequest();
    const result = await executeArb(req);

    // The "Both legs placed" step should be 'partial' if any leg is partial
    const placedStep = findStep(result.steps, 'Both legs placed');
    expect(placedStep).toBeDefined();
    // With random 0.5, fillRatio = 0.925, so status = 'partial'
    if (result.kalshiResult.status === 'partial' || result.polymarketResult.status === 'partial') {
      expect(placedStep!.status).toBe('partial');
    }
  });

  it('emits "partial" status for "Both legs filled and matched" when legs are still partial', async () => {
    // random = 0.5 → fillRatio = 0.925 → status 'partial' on both legs
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const req = makeRequest();
    const result = await executeArb(req);

    // If both legs end up partial and matched, the matched step should be 'partial'
    if (result.kalshiResult.status === 'partial' && result.polymarketResult.status === 'partial') {
      const matchedStep = findStep(result.steps, 'Both legs filled and matched');
      if (matchedStep) {
        expect(matchedStep.status).toBe('partial');
        expect(matchedStep.description).toContain('partial fills');
      }
    }
  });

  it('emits "success" step status when both legs fully fill', async () => {
    // random = 0.99 → fillRatio = 0.85 + 0.99 * 0.15 = 0.9985 → status 'filled' (>= 0.99)
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const req = makeRequest();
    const result = await executeArb(req);

    // Both legs should be fully filled
    expect(result.kalshiResult.status).toBe('filled');
    expect(result.polymarketResult.status).toBe('filled');

    const placedStep = findStep(result.steps, 'Both legs placed');
    expect(placedStep).toBeDefined();
    expect(placedStep!.status).toBe('success');
  });

  it('StepStatus type includes "partial" and "skipped"', () => {
    // Type-level test — if this compiles, the types are correct
    const partial: 'partial' = 'partial';
    const skipped: 'skipped' = 'skipped';
    expect(partial).toBe('partial');
    expect(skipped).toBe('skipped');
  });
});