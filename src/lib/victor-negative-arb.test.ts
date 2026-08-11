
import { describe, it, expect } from 'vitest';
import { calculateArbitrageMax, computeArbitrageFees, getPolymarketTheta, calcKalshiFee } from './matcher';

describe('UI-03 negative arb verification (Victor scenario)', () => {
  it('Victor-like kNo=0.48 + pYes=0.55 returns negative net ROI', () => {
    // Make Strategy 1 invalid by setting kYes = 0 (not tradeable) so only
    // "Buy YES PM + NO Kalshi" (Strategy 2) is evaluated.
    const kShape = { ticker: 'KX-TEST', yesBid: 0.00, yesAsk: 0.00, noBid: 0.47, noAsk: 0.48, lastPrice: 0.50 };
    const pmShape = { marketId: 'm1', conditionId: 'abc', yesPrice: 0.55, noPrice: 0.45, bestBid: 0.54, bestAsk: 0.56, lastTradePrice: 0.55 };
    const capital = 1000;
    const res = calculateArbitrageMax(kShape, pmShape, 0, capital * 2, capital * 2, 0, 'sports', capital);

    expect(res.strategy).toBe('Buy YES PM + NO Kalshi');
    expect(res.roiPct).toBeLessThan(0);
    expect(res.expectedProfit).toBeLessThan(0);
    expect(res.kalshiStake).toBeCloseTo(480, 2);
    expect(res.pmStake).toBeCloseTo(560, 2); // matcher uses PM bestAsk (0.56), not yesPrice
    if (res.fees) {
      expect(res.fees.kalshiFee).toBeCloseTo(17.48, 2);
      expect(res.fees.pmFee).toBeCloseTo(7.39, 2); // theta=0.03, 1000 contracts @ 0.56
      expect(res.fees.worstCaseNetProfit).toBeCloseTo(-64.87, 2);
    }
  });

  it('combined cost is what matters, not individual prices', () => {
    // Both legs below $1.00, but sum > $1.00 after fees → net loss
    const fees = computeArbitrageFees(
      'Buy YES PM + NO Kalshi',
      1000,
      480,
      550,
      0.52,
      0.48,
      0.55,
      0.45,
      'sports',
    );
    expect(fees.grossProfit).toBe(-30);
    expect(fees.worstCaseNetProfit).toBeCloseTo(-54.91, 2);
  });

  it('theta for sports is 0.03 and politics is 0.04', () => {
    expect(getPolymarketTheta('Sports')).toBe(0.03);
    expect(getPolymarketTheta('Politics')).toBe(0.04);
  });

  it('Kalshi ceil rounding is not overcharging at small sizes', () => {
    // 1 contract at 0.50 => raw fee 0.0175 => ceil -> 0.02
    expect(calcKalshiFee(1, 0.50)).toBe(0.02);
    // 1000 contracts at 0.50 => raw fee 17.50 => ceil -> 17.50
    expect(calcKalshiFee(1000, 0.50)).toBe(17.50);
  });
});
