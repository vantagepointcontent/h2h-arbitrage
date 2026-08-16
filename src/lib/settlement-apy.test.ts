import { describe, expect, it } from 'vitest';
import {
  calculateOutcomeContingentApy,
  kalshiSettlementTiming,
  polymarketSettlementTiming,
} from './settlement-apy';

const observedAt = '2026-08-14T11:02:35.000Z';
const kalshi = kalshiSettlementTiming({
  expected_expiration_time: '2027-01-04T15:00:00Z',
  expiration_time: '2027-11-03T15:00:00Z',
  latest_expiration_time: '2027-11-03T15:00:00Z',
  can_close_early: true,
  early_close_condition: 'Closes after the winning senator is sworn in.',
});
const polymarket = polymarketSettlementTiming('2026-11-03T00:00:00Z');

describe('outcome-contingent settlement APY', () => {
  it('keeps ROI identical while annualizing K-wins and PM-wins at their actual winning-leg dates', () => {
    const result = calculateOutcomeContingentApy({
      roiPct: 0.16026,
      observedAt,
      arbType: 'direct',
      strategy: 'Buy YES Kalshi + NO PM',
      kalshi,
      polymarket,
      rulesAligned: true,
    });

    expect(result.scenarioA).toMatchObject({ winner: 'kalshi', settlementAt: '2027-01-04T15:00:00.000Z', unavailableReason: null });
    expect(result.scenarioB).toMatchObject({ winner: 'polymarket', settlementAt: '2026-11-03T00:00:00.000Z', unavailableReason: null });
    expect(result.scenarioA.roiPct).toBe(result.scenarioB.roiPct);
    expect(result.scenarioA.apyPct).not.toBe(result.scenarioB.apyPct);
    expect(result.apyPct).toBeNull();
    expect(result.unavailableReason).toBe('outcome_contingent');
    expect(result.scenarioA.timingSource).toBe('kalshi.market.expected_expiration_time');
    expect(result.scenarioB.timingSource).toBe('polymarket.event.endDate');
  });

  it.each([
    ['Same-platform YES+NO Kalshi: Maine', 'kalshi'],
    ['Same-platform YES+NO Polymarket: Maine', 'polymarket'],
  ] as const)('uses one venue timing for both scenarios of %s', (strategy, winner) => {
    const result = calculateOutcomeContingentApy({ roiPct: 2, observedAt, arbType: 'internal', strategy, kalshi, polymarket, rulesAligned: true });
    expect(result.scenarioA.winner).toBe(winner);
    expect(result.scenarioB.winner).toBe(winner);
    expect(result.scenarioA.apyPct).toBe(result.scenarioB.apyPct);
    expect(result.apyPct).toBe(result.scenarioA.apyPct);
    expect(result.unavailableReason).toBeNull();
  });

  it('preserves negative ROI above -100% in each venue scenario', () => {
    const result = calculateOutcomeContingentApy({ roiPct: -1, observedAt, arbType: 'direct', strategy: 'Buy YES Kalshi + NO PM', kalshi, polymarket, rulesAligned: true });
    expect(result.scenarioA.apyPct).toBeLessThan(0);
    expect(result.scenarioB.apyPct).toBeLessThan(0);
    expect(result.apyPct).toBeNull();
    expect(result.unavailableReason).toBe('outcome_contingent');
  });

  it('uses a verified early expected expiration without discarding the later contractual limit', () => {
    expect(kalshi).toMatchObject({
      expectedAt: '2027-01-04T15:00:00.000Z',
      contractualAt: '2027-11-03T15:00:00.000Z',
      earlyDetermination: { eligible: true, condition: 'Closes after the winning senator is sworn in.' },
    });
    const result = calculateOutcomeContingentApy({ roiPct: 1, observedAt, arbType: 'internal', strategy: 'Same-platform YES+NO Kalshi: Maine', kalshi, polymarket, rulesAligned: true });
    expect(result.scenarioA.settlementAt).toBe(kalshi.expectedAt);
  });

  it('fails closed when an earlier expected date contradicts explicit no-early-close metadata', () => {
    const noEarly = { ...kalshi, earlyDetermination: { eligible: false, condition: null, source: null } };
    const result = calculateOutcomeContingentApy({ roiPct: 1, observedAt, arbType: 'direct', strategy: 'Buy YES Kalshi + NO PM', kalshi: noEarly, polymarket, rulesAligned: true });
    expect(result.scenarioA.apyPct).toBeNull();
    expect(result.scenarioA.unavailableReason).toBe('conflicting_settlement_dates');
  });

  it.each([
    { timing: polymarketSettlementTiming(undefined, undefined), reason: 'missing_settlement_date' },
    { timing: polymarketSettlementTiming('not-a-date', undefined), reason: 'invalid_expected_settlement' },
    { timing: polymarketSettlementTiming('2027-02-01T00:00:00Z', '2027-01-01T00:00:00Z'), reason: 'conflicting_settlement_dates' },
  ])('fails closed for $reason', ({ timing, reason }) => {
    const result = calculateOutcomeContingentApy({ roiPct: 1, observedAt, arbType: 'direct', strategy: 'Buy YES Kalshi + NO PM', kalshi, polymarket: timing, rulesAligned: true });
    expect(result.scenarioB.apyPct).toBeNull();
    expect(result.scenarioB.unavailableReason).toBe(reason);
    expect(result.apyPct).toBeNull();
  });

  it('does not gate venue timing analytics on resolution-rule alignment', () => {
    const result = calculateOutcomeContingentApy({ roiPct: 1, observedAt, arbType: 'direct', strategy: 'Buy YES Kalshi + NO PM', kalshi, polymarket, rulesAligned: false });
    expect(result.scenarioA.unavailableReason).toBeNull();
    expect(result.scenarioB.unavailableReason).toBeNull();
    expect(result.apyPct).toBeNull();
  });

  it('does not gate venue timing analytics when resolution-rule alignment is unknown', () => {
    const result = calculateOutcomeContingentApy({ roiPct: 1, observedAt, arbType: 'direct', strategy: 'Buy YES Kalshi + NO PM', kalshi, polymarket });
    expect(result.scenarioA.unavailableReason).toBeNull();
    expect(result.scenarioB.unavailableReason).toBeNull();
    expect(result.apyPct).toBeNull();
  });

  it('fails both scenarios closed when the scan timestamp is malformed', () => {
    const result = calculateOutcomeContingentApy({ roiPct: 1, observedAt: 'bad', arbType: 'direct', strategy: 'Buy YES Kalshi + NO PM', kalshi, polymarket, rulesAligned: true });
    expect(result.scenarioA.unavailableReason).toBe('invalid_observed_at');
    expect(result.scenarioB.unavailableReason).toBe('invalid_observed_at');
  });

  it('fuzzes ROI and timing inputs without producing non-finite APY values', () => {
    let seed = 0x5eed1234;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let index = 0; index < 500; index += 1) {
      const roi = random() * 400 - 200;
      const days = random() * 1500 - 100;
      const timestamp = new Date(Date.parse(observedAt) + days * 86_400_000).toISOString();
      const timing = polymarketSettlementTiming(timestamp);
      const result = calculateOutcomeContingentApy({ roiPct: roi, observedAt, arbType: 'internal', strategy: 'Buy both sides on Polymarket', kalshi: null, polymarket: timing, rulesAligned: true });
      for (const scenario of [result.scenarioA, result.scenarioB]) {
        if (scenario.apyPct != null) {
          expect(Number.isFinite(scenario.apyPct)).toBe(true);

        }
      }
    }
  });
});
