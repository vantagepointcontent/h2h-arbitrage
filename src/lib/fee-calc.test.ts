import { describe, it, expect } from 'vitest';
import { calculateArbitrageMax, calcKalshiFee, calcPolymarketFee, getPolymarketTheta } from './matcher';

describe('Kalshi/Polymarket fees', () => {
  it('Kalshi fee rounds up formula 0.07 * C * P * (1-P)', () => {
    const fee = calcKalshiFee(1000, 0.71);
    // 0.07 * 1000 * 0.71 * 0.29 = 14.413 → round up to 14.42
    expect(fee).toBe(14.42);
  });

  it('Polymarket Sports theta = 0.03', () => {
    expect(getPolymarketTheta('Sports')).toBe(0.03);
  });

  it('Polymarket Politics theta = 0.04', () => {
    expect(getPolymarketTheta('Politics')).toBe(0.04);
  });

  it('England example: fees turn apparent arb into a loss', () => {
    const kalshi = {
      ticker: 'KXENGLAND',
      yesBid: 0.70, yesAsk: 0.71,
      noBid: 0.29, noAsk: 0.30,
      lastPrice: 0.70,
      volume24h: '',
      yesBidDepth: '$100K',
      yesAskDepth: '$100K',
      noBidDepth: '$100K',
      noAskDepth: '$100K',
    };
    const pm = {
      marketId: 'pm-england',
      conditionId: 'c-england',
      yesPrice: 0.69, noPrice: 0.31,
      bestBid: 0.68, bestAsk: 0.69,
      lastTradePrice: 0.69,
      volume: '', liquidity: '', askDepth: 100000, noAskDepth: 100000,
    };

    const r = calculateArbitrageMax(kalshi, pm, 100000, 100000, 100000, 100000, 'Sports');

    expect(r.strategy).toBe('Buy YES PM + NO Kalshi');
    expect(r.fees).toBeDefined();
    if (r.fees) {
      // Kalshi NO at 0.30 fee on sell side
      expect(r.fees.kalshiFee).toBeGreaterThan(0);
      // PM YES at 0.69 with theta 0.03
      expect(r.fees.pmFee).toBeGreaterThan(0);
      // After fees the worst-case net profit is negative: this is NOT a real arb
      expect(r.fees.worstCaseNetProfit).toBeLessThan(0);
    }
  });

  it('gross ROI without fees is higher than net worst-case profit', () => {
    const kalshi = {
      ticker: 'KXTEST',
      yesBid: 0.40, yesAsk: 0.45,
      noBid: 0.55, noAsk: 0.60,
      lastPrice: 0.42,
      volume24h: '',
      yesBidDepth: '$10K', yesAskDepth: '$5K', noBidDepth: '', noAskDepth: '',
    };
    const pm = {
      marketId: 'pm-test',
      conditionId: 'c-test',
      yesPrice: 0.50, noPrice: 0.50,
      bestBid: 0.49, bestAsk: 0.51,
      lastTradePrice: 0.50,
      volume: '', liquidity: '', askDepth: 5000, noAskDepth: 5000,
    };

    const r = calculateArbitrageMax(kalshi, pm, 5000, 5000, 5000, 5000, 'Sports');

    if (r.fees) {
      expect(r.fees.kalshiFee).toBeGreaterThan(0);
      expect(r.fees.pmFee).toBeGreaterThan(0);
      expect(r.fees.worstCaseNetProfit).toBeLessThan(r.expectedProfit + r.fees.kalshiFee + r.fees.pmFee);
    }
  });
});
