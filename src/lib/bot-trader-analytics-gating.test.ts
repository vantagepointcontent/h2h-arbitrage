import { describe, expect, it, vi } from 'vitest';
import type { ExecutionResult, OrderResult } from './auto-execute';
import { getBotPerformanceEvidence, liveEvidenceToBotPositionFill, persistBotPerformanceExecution } from './bot-trader';

function order(
  platform: 'kalshi' | 'polymarket',
  overrides: Partial<OrderResult> = {},
): OrderResult {
  return {
    platform,
    status: 'filled',
    filledContracts: 99,
    filledPrice: platform === 'kalshi' ? 0.41 : 0.51,
    orderId: `normalized-${platform}`,
    timestamp: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function liveResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    success: true,
    rollbackExecuted: false,
    unhedged: false,
    executionTimeMs: 10,
    actualProfit: 0.05,
    steps: [],
    kalshiResult: order('kalshi', {
      venueEvidence: {
        venue: 'kalshi',
        filledQuantity: 3,
        fillPrice: 0.37,
        chargedFeeCents: 2,
        executionId: 'kalshi-fill-123',
        venueTimestamp: '2026-08-12T10:00:00.000Z',
        fills: [
          { executionId: 'kalshi-fill-122', quantity: 1, price: 0.36, chargedFeeCents: 1, venueTimestamp: '2026-08-12T09:59:59.000Z' },
          { executionId: 'kalshi-fill-123', quantity: 2, price: 0.375, chargedFeeCents: 1, venueTimestamp: '2026-08-12T10:00:00.000Z' },
        ],
      },
    }),
    polymarketResult: order('polymarket', {
      venueEvidence: {
        venue: 'polymarket',
        filledQuantity: 3,
        fillPrice: 0.59,
        chargedFeeCents: 4,
        executionId: 'pm-fill-456',
        venueTimestamp: '2026-08-12T10:00:01.000Z',
        fills: [
          { executionId: 'pm-fill-455', quantity: 1, price: 0.58, chargedFeeCents: 1, venueTimestamp: '2026-08-12T10:00:00.500Z' },
          { executionId: 'pm-fill-456', quantity: 2, price: 0.595, chargedFeeCents: 3, venueTimestamp: '2026-08-12T10:00:01.000Z' },
        ],
      },
    }),
    ...overrides,
  };
}

describe('BotTrader performance evidence gate', () => {
  it('consumes every authoritative live fill value without order-request or normalized-result fallbacks', () => {
    const evidence = getBotPerformanceEvidence(liveResult(), false);
    expect(evidence).toEqual({
      kind: 'live',
      kalshi: {
        venue: 'kalshi',
        filledQuantity: 3,
        fillPrice: 0.37,
        chargedFeeCents: 2,
        executionId: 'kalshi-fill-123',
        venueTimestamp: '2026-08-12T10:00:00.000Z',
        fills: [
          { executionId: 'kalshi-fill-122', quantity: 1, price: 0.36, chargedFeeCents: 1, venueTimestamp: '2026-08-12T09:59:59.000Z' },
          { executionId: 'kalshi-fill-123', quantity: 2, price: 0.375, chargedFeeCents: 1, venueTimestamp: '2026-08-12T10:00:00.000Z' },
        ],
      },
      polymarket: {
        venue: 'polymarket',
        filledQuantity: 3,
        fillPrice: 0.59,
        chargedFeeCents: 4,
        executionId: 'pm-fill-456',
        venueTimestamp: '2026-08-12T10:00:01.000Z',
        fills: [
          { executionId: 'pm-fill-455', quantity: 1, price: 0.58, chargedFeeCents: 1, venueTimestamp: '2026-08-12T10:00:00.500Z' },
          { executionId: 'pm-fill-456', quantity: 2, price: 0.595, chargedFeeCents: 3, venueTimestamp: '2026-08-12T10:00:01.000Z' },
        ],
      },
      actualProfit: 0.05,
      contractsMatched: true,
    });
    expect(liveEvidenceToBotPositionFill(evidence as Extract<NonNullable<typeof evidence>, { kind: 'live' }>)).toEqual({
      kalshiContracts: 3,
      pmContracts: 3,
      kalshiPrice: 0.37,
      pmPrice: 0.59,
      kalshiFills: [{ priceCents: 36, size: 1 }, { priceCents: 37.5, size: 2 }],
      pmFills: [{ priceCents: 58, size: 1 }, { priceCents: 59.5, size: 2 }],
      kalshiChargedFeeCents: 2,
      pmChargedFeeCents: 4,
    });
  });

  it('admits a verified matched partial fill using only the venue quantities', () => {
    const result = liveResult({
      kalshiResult: order('kalshi', { ...liveResult().kalshiResult, status: 'partial' }),
      polymarketResult: order('polymarket', { ...liveResult().polymarketResult, status: 'partial' }),
    });
    expect(getBotPerformanceEvidence(result, false)).toMatchObject({
      kind: 'live',
      kalshi: { filledQuantity: 3, executionId: 'kalshi-fill-123' },
      polymarket: { filledQuantity: 3, executionId: 'pm-fill-456' },
    });
  });

  it.each([
    ['failed result', { success: false }],
    ['rollback result', { rollbackExecuted: true }],
    ['unhedged result', { unhedged: true }],
    ['rejected leg', { kalshiResult: order('kalshi', { ...liveResult().kalshiResult, status: 'rejected' }) }],
    ['missing evidence', { polymarketResult: order('polymarket', { venueEvidence: undefined }) }],
    ['malformed fee', { polymarketResult: order('polymarket', { venueEvidence: { ...liveResult().polymarketResult.venueEvidence!, chargedFeeCents: 1.5 } }) }],
    ['wrong venue', { polymarketResult: order('polymarket', { venueEvidence: { ...liveResult().polymarketResult.venueEvidence!, venue: 'kalshi' } }) }],
    ['missing identifier', { polymarketResult: order('polymarket', { venueEvidence: { ...liveResult().polymarketResult.venueEvidence!, executionId: '' } }) }],
    ['local timestamp shape', { polymarketResult: order('polymarket', { venueEvidence: { ...liveResult().polymarketResult.venueEvidence!, venueTimestamp: '2026-08-12T10:00:01' } }) }],
    ['mismatched quantity', { polymarketResult: order('polymarket', { venueEvidence: { ...liveResult().polymarketResult.venueEvidence!, filledQuantity: 2 } }) }],
    ['missing actual profit', { actualProfit: undefined }],
  ])('excludes %s completely', (_name, overrides) => {
    expect(getBotPerformanceEvidence(liveResult(overrides as Partial<ExecutionResult>), false)).toBeNull();
  });

  it('preserves successful paper analytics while keeping paper evidence explicitly non-live', () => {
    const result = liveResult({
      kalshiResult: order('kalshi', {
        filledContracts: 1,
        filledPrice: 0.45,
        orderId: 'paper-kalshi',
        timestamp: '2026-08-12T11:00:00.000Z',
        venueEvidence: undefined,
      }),
      polymarketResult: order('polymarket', {
        filledContracts: 1,
        filledPrice: 0.52,
        orderId: 'paper-pm',
        timestamp: '2026-08-12T11:00:01.000Z',
        venueEvidence: undefined,
      }),
    });

    expect(getBotPerformanceEvidence(result, true)).toMatchObject({
      kind: 'paper',
      kalshi: { filledQuantity: 1, fillPrice: 0.45, executionId: 'paper-kalshi' },
      polymarket: { filledQuantity: 1, fillPrice: 0.52, executionId: 'paper-pm' },
    });
    expect(getBotPerformanceEvidence(result, true)?.kind).not.toBe('live');
  });

  it('excludes failed paper simulations from performance', () => {
    expect(getBotPerformanceEvidence(liveResult({ success: false }), true)).toBeNull();
  });

  it('does not call persistence for unverified live results', async () => {
    const persist = vi.fn(async () => 1);
    const evidence = getBotPerformanceEvidence(liveResult({
      polymarketResult: order('polymarket', { venueEvidence: undefined }),
    }), false);
    await expect(persistBotPerformanceExecution({
      timestamp: 'local', arbId: 'a', marketTitle: 'm', dryRun: false,
      success: true, estimatedProfit: 99, source: 'bot',
    }, evidence, persist)).resolves.toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it('persists verified live and explicit paper records without changing their mode', async () => {
    const persisted: boolean[] = [];
    const persist = vi.fn(async (record: { dryRun: boolean }) => {
      persisted.push(record.dryRun);
      return 42;
    });
    const liveEvidence = getBotPerformanceEvidence(liveResult(), false);
    const paperEvidence = getBotPerformanceEvidence(liveResult(), true);
    const baseRecord = {
      timestamp: '2026-08-12T10:00:01.000Z', arbId: 'a', marketTitle: 'm',
      success: true, estimatedProfit: 1, source: 'bot' as const,
    };
    await expect(persistBotPerformanceExecution({ ...baseRecord, dryRun: false }, liveEvidence, persist)).resolves.toBe(42);
    await expect(persistBotPerformanceExecution({ ...baseRecord, dryRun: true }, paperEvidence, persist)).resolves.toBe(42);
    expect(persisted).toEqual([false, true]);
  });
});
