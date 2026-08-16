import { describe, expect, it } from 'vitest';
import { attachOutcomeContingentApy, buildKalshiArbShape, buildPmArbShape, type UnifiedOutcome } from './matcher';

const noFees = undefined;
function arb(overrides: Partial<UnifiedOutcome['arbitrage']> = {}): UnifiedOutcome['arbitrage'] {
  return {
    strategy: 'Buy YES Kalshi + NO PM', arbType: 'direct', kalshiStake: 67, pmStake: 31,
    expectedProfit: 0.16, roiPct: 0.16026, maxCapital: 100, buyPlatform: 'kalshi', buyPrice: 0.67,
    sellPlatform: 'polymarket', sellPrice: 0.31, fees: noFees, ...overrides,
  };
}

describe('matcher settlement timing integration', () => {
  it('produces the same canonical APY for aligned and unaligned rules with identical ROI/TTE', () => {
    const observedAt = '2026-08-14T11:02:35.000Z';
    const expiryAt = '2026-10-24T11:02:35.000Z';
    const base = { artist: 'Maine', kalshi: null, polymarket: null, arbitrage: arb(), source: 'auto' as const };
    const [aligned, unaligned] = attachOutcomeContingentApy([
      { ...base, resolutionRulesAligned: true },
      { ...base, artist: 'Maine unaligned', resolutionRulesAligned: false },
    ], observedAt, expiryAt);

    expect(aligned.arbitrage.apyPct).toBeCloseTo((1.0016026 ** (365 / 71) - 1) * 100, 10);
    expect(unaligned.arbitrage.apyPct).toBe(aligned.arbitrage.apyPct);
    expect(unaligned.arbitrage.daysToExpiry).toBe(71);
    expect(unaligned.arbitrage.apyUnavailableReason).toBeNull();
  });

  it('preserves venue timing and binds scenario APY to the selected legs', () => {
    const kalshi = buildKalshiArbShape({
      ticker: 'SENATEME-26-D', event_ticker: 'SENATEME-26',
      expected_expiration_time: '2027-01-04T15:00:00Z', expiration_time: '2027-11-03T15:00:00Z',
      can_close_early: true, early_close_condition: 'Accelerated determination is allowed.',
    });
    const polymarket = buildPmArbShape({
      id: 'pm-1', conditionId: 'condition-1', question: 'Maine?', slug: 'maine', outcomes: '["Yes","No"]',
      outcomePrices: '["0.70","0.30"]', active: true, closed: false,
    }, '2026-11-03T00:00:00Z');
    const [outcome] = attachOutcomeContingentApy([{
      artist: 'Maine', kalshi, polymarket, arbitrage: arb(), source: 'auto', resolutionRulesAligned: true,
    }], '2026-08-14T11:02:35.000Z');

    expect(outcome.kalshi?.settlementTiming?.contractualAt).toBe('2027-11-03T15:00:00.000Z');
    expect(outcome.kalshi?.settlementTiming?.earlyDetermination).toEqual({
      eligible: true,
      condition: 'Accelerated determination is allowed.',
      source: 'kalshi.market.early_close_condition',
    });
    expect(outcome.polymarket?.settlementTiming?.expectedSource).toBe('polymarket.event.endDate');
    expect(outcome.arbitrage.outcomeApy?.scenarioA.apyPct).not.toBe(outcome.arbitrage.outcomeApy?.scenarioB.apyPct);
    expect(outcome.arbitrage.apyPct).toBeNull();
  });

  it('uses the cross strategy selected PM condition instead of the display row PM leg', () => {
    const kTiming = buildKalshiArbShape({ ticker: 'K-A', event_ticker: 'K', expected_expiration_time: '2027-01-01T00:00:00Z' });
    const pmA = buildPmArbShape({ id: 'a', conditionId: 'pm-a', question: 'A', slug: 'a', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', active: true, closed: false }, '2026-10-01T00:00:00Z');
    const pmB = buildPmArbShape({ id: 'b', conditionId: 'pm-b', question: 'B', slug: 'b', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', active: true, closed: false }, '2026-12-01T00:00:00Z');
    const outcomes: UnifiedOutcome[] = [
      { artist: 'A', kalshi: kTiming, polymarket: pmA, arbitrage: arb({ arbType: 'cross', pmConditionId: 'pm-b' }), source: 'auto', resolutionRulesAligned: true },
      { artist: 'B', kalshi: kTiming, polymarket: pmB, arbitrage: arb({ strategy: 'No arb', arbType: null, roiPct: 0 }), source: 'auto' },
    ];
    const [cross] = attachOutcomeContingentApy(outcomes, '2026-08-14T11:02:35.000Z');
    expect(cross.arbitrage.outcomeApy?.scenarioB.settlementAt).toBe('2026-12-01T00:00:00.000Z');
  });
});
