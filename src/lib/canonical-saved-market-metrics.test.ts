import { describe, expect, it } from 'vitest';
import { selectCanonicalSavedMarketMetrics, type CanonicalSavedMarketCandidate } from './canonical-saved-market-metrics';

const scannedAt = '2026-08-24T00:00:00.000Z';

function candidate(overrides: Partial<CanonicalSavedMarketCandidate> = {}): CanonicalSavedMarketCandidate {
  return {
    artist: 'Outcome A',
    roiPct: 2,
    expectedProfit: 0,
    strategy: 'Buy YES Kalshi + NO PM',
    arbType: 'direct',
    totalStake: 0,
    executionStatus: 'executable',
    expiryAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('BUG-183 canonical saved-market APY derivation', () => {
  it.each([
    ['short expiry', 2, '2026-09-03T00:00:00.000Z', 10],
    ['long expiry', 7.5, '2027-08-24T00:00:00.000Z', 365],
  ] as const)('annualizes canonical ROI for a %s without optional APY or profit fields', (_label, roiPct, expiryAt, days) => {
    const result = selectCanonicalSavedMarketMetrics([
      candidate({ roiPct, expiryAt }),
    ], scannedAt);
    const expectedApyPct = (Math.pow(1 + roiPct / 100, 365 / days) - 1) * 100;

    expect(result).toMatchObject({
      unavailableReason: null,
      roiPct,
      profit: null,
      strategy: 'Buy YES Kalshi + NO PM',
      daysToExpiry: days,
      expiryAt,
      observedAt: scannedAt,
    });
    expect(result.value).toBeCloseTo(expectedApyPct, 12);
  });

  it('derives from canonical ROI and timestamps instead of trusting mismatched optional APY/TTE fields', () => {
    const result = selectCanonicalSavedMarketMetrics([
      candidate({ apyPct: 999, daysToExpiry: 999 }),
    ], scannedAt);

    expect(result.value).toBeCloseTo((1.02 ** 36.5 - 1) * 100, 12);
    expect(result.daysToExpiry).toBe(10);
    expect(result.unavailableReason).toBeNull();
  });

  it('binds canonical APY provenance to the scan timestamp used for annualization', () => {
    const result = selectCanonicalSavedMarketMetrics([
      candidate({ outcomeApy: { observedAt: '2026-08-30T00:00:00.000Z' } }),
    ], scannedAt);

    expect(result.observedAt).toBe(scannedAt);
    expect(result.daysToExpiry).toBe(10);
  });

  it.each(['non_executable', 'unavailable'] as const)(
    'annualizes persisted ROI when the canonical candidate is currently %s', (executionStatus) => {
    const result = selectCanonicalSavedMarketMetrics([
      candidate({ executionStatus, expectedProfit: 0, totalStake: 0 }),
    ], scannedAt);

    expect(result).toMatchObject({
      unavailableReason: null,
      roiPct: 2,
      profit: null,
      observedAt: scannedAt,
      expiryAt: '2026-09-03T00:00:00.000Z',
    });
    expect(result.value).toBeCloseTo((1.02 ** 36.5 - 1) * 100, 12);
  });

  it.each([
    ['missing expiry', null, 'missing_expiry'],
    ['invalid expiry', 'not-a-date', 'invalid_expiry'],
    ['expired opportunity', '2026-08-23T00:00:00.000Z', 'non_positive_tte'],
  ] as const)('returns an actionable reason for %s', (_label, expiryAt, reason) => {
    const result = selectCanonicalSavedMarketMetrics([
      candidate({ expiryAt }),
    ], scannedAt);

    expect(result.value).toBeNull();
    expect(result.unavailableReason).toBe(reason);
  });

  it('does not fabricate APY for a row without a canonical arbitrage strategy', () => {
    const result = selectCanonicalSavedMarketMetrics([
      candidate({ strategy: 'No arb', arbType: null, executionStatus: undefined }),
    ], scannedAt);

    expect(result).toMatchObject({
      value: null,
      unavailableReason: 'no_canonical_arbitrage',
      roiPct: null,
      strategy: 'No arb',
    });
  });
});
