import { describe, expect, it } from 'vitest';
import { parseArbLegs } from './ArbLegBreakdown';

const fees = { kalshiFee: 1.25, pmFee: 0.75, worstCaseNetProfit: 4 };

describe('arb leg fee transparency', () => {
  it.each([
    ['Buy YES Kalshi + NO PM', false],
    ['Buy YES PM + NO Kalshi', false],
    ['Buy YES both sides: Kalshi A + PM B', true],
    ['Same-platform YES+YES Kalshi: A + B', false],
  ] as const)('retains per-venue fees and fee-aware net profit for %s', (strategy, isCross) => {
    const result = parseArbLegs(strategy, 'Outcome', 0.45, 0.55, 0.48, 0.52, 50, 50, fees, 3.5);
    expect(result.isCross).toBe(isCross);
    expect(result.legs).toHaveLength(2);
    expect(result.feeBreakdown).toEqual({ kalshiFee: 1.25, pmFee: 0.75, worstCaseNetProfit: 4 });
    expect(result.fees).toBe(2);
    expect(result.netProfit).toBe(3.5);
  });
});
