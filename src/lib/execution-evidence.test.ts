/**
 * DATA-007: Unit tests for the authoritative execution metadata contract.
 */

import { describe, it, expect } from 'vitest';
import {
  isAuthoritativeVenueEvidence,
  isAuthoritativeLiveEvidence,
  buildExecutionEvidence,
  orderResultToVenueEvidence,
  getAuthoritativeMatchedFill,
  isAnalyticsEligible,
  type VenueExecutionEvidence,
  type LiveExecutionEvidence,
  type PaperExecutionEvidence,
} from './execution-evidence';
import type { OrderResult, ExecutionResult } from './auto-execute';

function makeOrderResult(
  overrides?: Partial<OrderResult>,
): OrderResult {
  const result: OrderResult = {
    platform: 'kalshi',
    status: 'filled',
    filledSize: 45,
    filledContracts: 100,
    filledPrice: 0.45,
    chargedFeeCents: 50,
    executionId: 'fill-kalshi-001',
    venueTimestamp: '2026-08-12T10:00:00.000Z',
    orderId: 'ord-kalshi-001',
    timestamp: '2026-08-12T10:00:00.000Z',
    ...overrides,
  };
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, 'venueEvidence')) {
    result.venueEvidence = {
      venue: result.platform,
      filledQuantity: result.filledContracts as number,
      fillPrice: result.filledPrice as number,
      chargedFeeCents: result.chargedFeeCents as number,
      executionId: result.executionId as string,
      venueTimestamp: result.venueTimestamp as string,
    };
  }
  return result;
}

function makeExecutionResult(
  overrides?: Partial<ExecutionResult>,
): ExecutionResult {
  return {
    success: true,
    kalshiResult: makeOrderResult({ platform: 'kalshi' }),
    polymarketResult: makeOrderResult({
      platform: 'polymarket',
      orderId: 'ord-pm-001',
      filledPrice: 0.52,
      filledContracts: 100,
      executionId: 'trade-pm-001',
      venueTimestamp: '2026-08-12T10:00:01.000Z',
    }),
    rollbackExecuted: false,
    unhedged: false,
    executionTimeMs: 1234,
    actualProfit: 3.0,
    steps: [],
    ...overrides,
  };
}

// ── isAuthoritativeVenueEvidence ──────────────────────────────────────

describe('isAuthoritativeVenueEvidence', () => {
  it('accepts fully-populated valid evidence', () => {
    const ev: VenueExecutionEvidence = {
      venue: 'kalshi',
      filledQuantity: 100,
      fillPrice: 0.45,
      executionId: 'ord-123',
      venueTimestamp: '2026-08-12T10:00:00.000Z',
      chargedFeeCents: 50,
    };
    expect(isAuthoritativeVenueEvidence(ev)).toBe(true);
  });

  it('rejects evidence without chargedFeeCents', () => {
    const ev = {
      venue: 'polymarket',
      filledQuantity: 200,
      fillPrice: 0.52,
      executionId: 'ord-456',
      venueTimestamp: '2026-08-12T10:00:00.000Z',
    };
    expect(isAuthoritativeVenueEvidence(ev)).toBe(false);
  });

  it('rejects null', () => {
    expect(isAuthoritativeVenueEvidence(null)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isAuthoritativeVenueEvidence('string')).toBe(false);
    expect(isAuthoritativeVenueEvidence(42)).toBe(false);
  });

  it('rejects invalid venue', () => {
    expect(isAuthoritativeVenueEvidence({ venue: 'unknown' })).toBe(false);
    expect(isAuthoritativeVenueEvidence({ venue: '' })).toBe(false);
  });

  it('rejects negative filledQuantity', () => {
    const ev = {
      venue: 'kalshi',
      filledQuantity: -1,
      fillPrice: 0.45,
      executionId: 'ord-123',
      venueTimestamp: '2026-08-12T10:00:00.000Z',
    };
    expect(isAuthoritativeVenueEvidence(ev)).toBe(false);
  });

  it('rejects NaN filledQuantity', () => {
    const ev = {
      venue: 'kalshi',
      filledQuantity: Number.NaN,
      fillPrice: 0.45,
      executionId: 'ord-123',
      venueTimestamp: '2026-08-12T10:00:00.000Z',
    };
    expect(isAuthoritativeVenueEvidence(ev)).toBe(false);
  });

  it('rejects fillPrice at boundaries (0 and 1)', () => {
    const evBase = {
      venue: 'kalshi',
      filledQuantity: 100,
      executionId: 'ord-123',
      venueTimestamp: '2026-08-12T10:00:00.000Z',
    };
    expect(isAuthoritativeVenueEvidence({ ...evBase, fillPrice: 0 })).toBe(false);
    expect(isAuthoritativeVenueEvidence({ ...evBase, fillPrice: 1 })).toBe(false);
    expect(isAuthoritativeVenueEvidence({ ...evBase, fillPrice: -0.01 })).toBe(false);
    expect(isAuthoritativeVenueEvidence({ ...evBase, fillPrice: 1.01 })).toBe(false);
  });

  it('rejects empty executionId', () => {
    const ev = {
      venue: 'kalshi',
      filledQuantity: 100,
      fillPrice: 0.45,
      executionId: '',
      venueTimestamp: '2026-08-12T10:00:00.000Z',
    };
    expect(isAuthoritativeVenueEvidence(ev)).toBe(false);
  });

  it('rejects whitespace-only executionId', () => {
    const ev = {
      venue: 'kalshi',
      filledQuantity: 100,
      fillPrice: 0.45,
      executionId: '   ',
      venueTimestamp: '2026-08-12T10:00:00.000Z',
    };
    expect(isAuthoritativeVenueEvidence(ev)).toBe(false);
  });

  it('rejects malformed venueTimestamp', () => {
    const ev = {
      venue: 'kalshi',
      filledQuantity: 100,
      fillPrice: 0.45,
      executionId: 'ord-123',
      venueTimestamp: 'not-a-date',
    };
    expect(isAuthoritativeVenueEvidence(ev)).toBe(false);
  });

  it('rejects non-integer or negative chargedFeeCents', () => {
    const evBase = {
      venue: 'kalshi',
      filledQuantity: 100,
      fillPrice: 0.45,
      executionId: 'ord-123',
      venueTimestamp: '2026-08-12T10:00:00.000Z',
    };
    expect(isAuthoritativeVenueEvidence({ ...evBase, chargedFeeCents: 1.5 })).toBe(false);
    expect(isAuthoritativeVenueEvidence({ ...evBase, chargedFeeCents: -1 })).toBe(false);
    expect(isAuthoritativeVenueEvidence({ ...evBase, chargedFeeCents: Number.NaN })).toBe(false);
  });
});

// ── isAuthoritativeLiveEvidence ───────────────────────────────────────

describe('isAuthoritativeLiveEvidence', () => {
  it('accepts valid live evidence with matched contracts', () => {
    const ev: LiveExecutionEvidence = {
      kind: 'live',
      kalshi: {
        venue: 'kalshi',
        filledQuantity: 100,
        fillPrice: 0.45,
        executionId: 'ord-k-001',
        venueTimestamp: '2026-08-12T10:00:00.000Z',
        chargedFeeCents: 50,
      },
      polymarket: {
        venue: 'polymarket',
        filledQuantity: 100,
        fillPrice: 0.52,
        executionId: 'ord-pm-001',
        venueTimestamp: '2026-08-12T10:00:01.000Z',
        chargedFeeCents: 40,
      },
      actualProfit: 3.0,
      contractsMatched: true,
    };
    expect(isAuthoritativeLiveEvidence(ev)).toBe(true);
  });

  it('rejects non-live kind', () => {
    const ev: PaperExecutionEvidence = {
      kind: 'paper',
      kalshi: { venue: 'kalshi', filledQuantity: 100, fillPrice: 0.45, executionId: 'a', venueTimestamp: '2026-08-12T10:00:00.000Z' },
      polymarket: { venue: 'polymarket', filledQuantity: 100, fillPrice: 0.52, executionId: 'b', venueTimestamp: '2026-08-12T10:00:00.000Z' },
      actualProfit: 3,
      contractsMatched: true,
    };
    expect(isAuthoritativeLiveEvidence(ev)).toBe(false);
  });

  it('rejects when contractsMatched is false', () => {
    const ev = {
      kind: 'live' as const,
      kalshi: {
        venue: 'kalshi' as const,
        filledQuantity: 100,
        fillPrice: 0.45,
        executionId: 'ord-k-001',
        venueTimestamp: '2026-08-12T10:00:00.000Z',
      },
      polymarket: {
        venue: 'polymarket' as const,
        filledQuantity: 90,
        fillPrice: 0.52,
        executionId: 'ord-pm-001',
        venueTimestamp: '2026-08-12T10:00:01.000Z',
      },
      actualProfit: 2.7,
      contractsMatched: false,
    };
    expect(isAuthoritativeLiveEvidence(ev)).toBe(false);
  });

  it('rejects when both venues are the same', () => {
    const ev = {
      kind: 'live' as const,
      kalshi: {
        venue: 'kalshi' as const,
        filledQuantity: 100,
        fillPrice: 0.45,
        executionId: 'ord-k-001',
        venueTimestamp: '2026-08-12T10:00:00.000Z',
      },
      polymarket: {
        venue: 'kalshi' as const,
        filledQuantity: 100,
        fillPrice: 0.52,
        executionId: 'ord-pm-001',
        venueTimestamp: '2026-08-12T10:00:01.000Z',
      },
      actualProfit: 3.0,
      contractsMatched: true,
    };
    expect(isAuthoritativeLiveEvidence(ev)).toBe(false);
  });

  it('rejects NaN actualProfit', () => {
    const ev = {
      kind: 'live' as const,
      kalshi: {
        venue: 'kalshi' as const,
        filledQuantity: 100,
        fillPrice: 0.45,
        executionId: 'ord-k-001',
        venueTimestamp: '2026-08-12T10:00:00.000Z',
      },
      polymarket: {
        venue: 'polymarket' as const,
        filledQuantity: 100,
        fillPrice: 0.52,
        executionId: 'ord-pm-001',
        venueTimestamp: '2026-08-12T10:00:01.000Z',
      },
      actualProfit: Number.NaN,
      contractsMatched: true,
    };
    expect(isAuthoritativeLiveEvidence(ev)).toBe(false);
  });

  it('rejects invalid kalshi evidence', () => {
    const ev = {
      kind: 'live' as const,
      kalshi: { venue: 'kalshi' },
      polymarket: {
        venue: 'polymarket' as const,
        filledQuantity: 100,
        fillPrice: 0.52,
        executionId: 'ord-pm-001',
        venueTimestamp: '2026-08-12T10:00:01.000Z',
      },
      actualProfit: 3.0,
      contractsMatched: true,
    };
    expect(isAuthoritativeLiveEvidence(ev)).toBe(false);
  });

  it('rejects invalid polymarket evidence', () => {
    const ev = {
      kind: 'live' as const,
      kalshi: {
        venue: 'kalshi' as const,
        filledQuantity: 100,
        fillPrice: 0.45,
        executionId: 'ord-k-001',
        venueTimestamp: '2026-08-12T10:00:00.000Z',
      },
      polymarket: { venue: 'polymarket' },
      actualProfit: 3.0,
      contractsMatched: true,
    };
    expect(isAuthoritativeLiveEvidence(ev)).toBe(false);
  });
});

// ── orderResultToVenueEvidence ────────────────────────────────────────

describe('orderResultToVenueEvidence', () => {
  it('converts a complete OrderResult to venue evidence', () => {
    const result = makeOrderResult();
    const ev = orderResultToVenueEvidence(result);
    expect(ev).not.toBeNull();
    expect(ev!.venue).toBe('kalshi');
    expect(ev!.filledQuantity).toBe(100);
    expect(ev!.fillPrice).toBe(0.45);
    expect(ev!.executionId).toBe('fill-kalshi-001');
  });

  it('returns null when filledContracts is missing', () => {
    const result = makeOrderResult({ filledContracts: undefined });
    expect(orderResultToVenueEvidence(result)).toBeNull();
  });

  it('returns null when filledContracts is negative', () => {
    const result = makeOrderResult({ filledContracts: -1 });
    expect(orderResultToVenueEvidence(result)).toBeNull();
  });

  it('returns null when filledPrice is missing', () => {
    const result = makeOrderResult({ filledPrice: undefined });
    expect(orderResultToVenueEvidence(result)).toBeNull();
  });

  it('returns null when filledPrice is out of range', () => {
    expect(orderResultToVenueEvidence(makeOrderResult({ filledPrice: 0 }))).toBeNull();
    expect(orderResultToVenueEvidence(makeOrderResult({ filledPrice: 1 }))).toBeNull();
    expect(orderResultToVenueEvidence(makeOrderResult({ filledPrice: -0.01 }))).toBeNull();
  });

  it('rejects a requested-order copy without correlated venue evidence', () => {
    const result = makeOrderResult({ venueEvidence: undefined });
    expect(orderResultToVenueEvidence(result)).toBeNull();
  });

  it('rejects evidence whose venue does not match the adapter', () => {
    const result = makeOrderResult({
      venueEvidence: {
        venue: 'polymarket',
        filledQuantity: 100,
        fillPrice: 0.45,
        chargedFeeCents: 50,
        executionId: 'trade-unrelated',
        venueTimestamp: '2026-08-12T10:00:00.000Z',
      },
    });
    expect(orderResultToVenueEvidence(result)).toBeNull();
  });

  it('rejects a malformed venue timestamp even when the local timestamp is valid', () => {
    const result = makeOrderResult();
    result.venueEvidence = { ...result.venueEvidence!, venueTimestamp: 'bad-date' };
    expect(orderResultToVenueEvidence(result)).toBeNull();
  });
});

// ── buildExecutionEvidence ──────────────────────────────────────────

describe('buildExecutionEvidence', () => {
  it('builds paper evidence from dry-run result', () => {
    const result = makeExecutionResult();
    const ev = buildExecutionEvidence(result, true);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('paper');
    expect((ev as PaperExecutionEvidence).actualProfit).toBe(3.0);
    expect((ev as PaperExecutionEvidence).contractsMatched).toBe(true);
  });

  it('builds live evidence from non-dry-run result', () => {
    const result = makeExecutionResult();
    const ev = buildExecutionEvidence(result, false);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('live');
    expect((ev as LiveExecutionEvidence).kalshi.executionId).toBe('fill-kalshi-001');
  });

  it('returns null for live when correlated evidence is missing', () => {
    const result = makeExecutionResult({
      kalshiResult: makeOrderResult({ venueEvidence: undefined }),
    });
    expect(buildExecutionEvidence(result, false)).toBeNull();
  });

  it('returns null when filledContracts are mismatched', () => {
    const result = makeExecutionResult({
      kalshiResult: makeOrderResult({ filledContracts: 100 }),
      polymarketResult: makeOrderResult({
        platform: 'polymarket',
        orderId: 'ord-pm-001',
        filledContracts: 90,
      }),
    });
    expect(buildExecutionEvidence(result, false)).toBeNull();
  });

  it('returns null when either leg has no filledContracts', () => {
    const result = makeExecutionResult({
      kalshiResult: makeOrderResult({ filledContracts: undefined }),
    });
    expect(buildExecutionEvidence(result, false)).toBeNull();
  });
});

// ── getAuthoritativeMatchedFill ─────────────────────────────────────

describe('getAuthoritativeMatchedFill', () => {
  it('returns matched fills when quantities and prices are valid', () => {
    const fill = getAuthoritativeMatchedFill({
      kalshiResult: { filledContracts: 100, filledPrice: 0.45 },
      polymarketResult: { filledContracts: 100, filledPrice: 0.52 },
    });
    expect(fill).toEqual({
      kalshiContracts: 100,
      pmContracts: 100,
      kalshiPrice: 0.45,
      pmPrice: 0.52,
    });
  });

  it('returns null when quantities mismatch', () => {
    expect(getAuthoritativeMatchedFill({
      kalshiResult: { filledContracts: 100, filledPrice: 0.45 },
      polymarketResult: { filledContracts: 90, filledPrice: 0.52 },
    })).toBeNull();
  });

  it('returns null when either quantity is zero', () => {
    expect(getAuthoritativeMatchedFill({
      kalshiResult: { filledContracts: 0, filledPrice: 0.45 },
      polymarketResult: { filledContracts: 0, filledPrice: 0.52 },
    })).toBeNull();
  });

  it('returns null when either quantity is missing', () => {
    expect(getAuthoritativeMatchedFill({
      kalshiResult: { filledContracts: undefined as unknown as number, filledPrice: 0.45 },
      polymarketResult: { filledContracts: 100, filledPrice: 0.52 },
    })).toBeNull();
  });

  it('returns null when prices are out of range', () => {
    expect(getAuthoritativeMatchedFill({
      kalshiResult: { filledContracts: 100, filledPrice: 0 },
      polymarketResult: { filledContracts: 100, filledPrice: 0.52 },
    })).toBeNull();
    expect(getAuthoritativeMatchedFill({
      kalshiResult: { filledContracts: 100, filledPrice: 0.45 },
      polymarketResult: { filledContracts: 100, filledPrice: 1 },
    })).toBeNull();
  });

  it('returns null when prices are missing', () => {
    expect(getAuthoritativeMatchedFill({
      kalshiResult: { filledContracts: 100, filledPrice: undefined as unknown as number },
      polymarketResult: { filledContracts: 100, filledPrice: 0.52 },
    })).toBeNull();
  });
});

// ── isAnalyticsEligible ─────────────────────────────────────────────

describe('isAnalyticsEligible', () => {
  it('returns true for successful live execution with authoritative evidence', () => {
    const result = makeExecutionResult();
    const evidence = buildExecutionEvidence(result, false);
    expect(isAnalyticsEligible(result, evidence)).toBe(true);
  });

  it('returns false for paper executions', () => {
    const result = makeExecutionResult();
    const evidence = buildExecutionEvidence(result, true);
    expect(isAnalyticsEligible(result, evidence)).toBe(false);
  });

  it('returns false when evidence is null', () => {
    const result = makeExecutionResult();
    expect(isAnalyticsEligible(result, null)).toBe(false);
  });

  it('returns false when result has rollbackExecuted', () => {
    const result = makeExecutionResult({ rollbackExecuted: true });
    const evidence = buildExecutionEvidence(result, false);
    expect(isAnalyticsEligible(result, evidence)).toBe(false);
  });

  it('returns false when result is unhedged', () => {
    const result = makeExecutionResult({ unhedged: true });
    const evidence = buildExecutionEvidence(result, false);
    expect(isAnalyticsEligible(result, evidence)).toBe(false);
  });

  it('returns false when result.success is false', () => {
    const result = makeExecutionResult({ success: false });
    const evidence = buildExecutionEvidence(result, false);
    expect(isAnalyticsEligible(result, evidence)).toBe(false);
  });
});
