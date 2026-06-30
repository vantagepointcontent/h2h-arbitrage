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

    // PM YES (0.69) + Kalshi NO (0.30) = 0.99 < 1 → gross spread 0.01
    // But after fees (Kalshi NO sell + PM YES buy), worst-case net is negative
    // → should be rejected as "No arb"
    expect(r.strategy).toBe('No arb');
    expect(r.expectedProfit).toBe(0);
    expect(r.roiPct).toBe(0);
    expect(r.kalshiStake).toBe(0);
    expect(r.pmStake).toBe(0);
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

    // Kalshi YES (0.45) + PM NO (0.50) = 0.95 < 1 → gross spread 0.05
    // After fees this should still be positive (clear arb)
    expect(r.strategy).not.toBe('No arb');
    expect(r.expectedProfit).toBeGreaterThan(0);
    expect(r.roiPct).toBeGreaterThan(0);
    if (r.fees) {
      expect(r.fees.kalshiFee).toBeGreaterThan(0);
      expect(r.fees.pmFee).toBeGreaterThan(0);
      expect(r.fees.worstCaseNetProfit).toBeGreaterThan(0);
    }
  });

  it('TX-18: break-even (0.06 + 0.94 = 1.00) should NOT be flagged as arb', () => {
    const kalshi = {
      ticker: 'KXTX18',
      yesBid: 0.05, yesAsk: 0.06,
      noBid: 0.93, noAsk: 0.94,
      lastPrice: 0.06,
      volume24h: '',
      yesBidDepth: '$10K', yesAskDepth: '$10K',
      noBidDepth: '$10K', noAskDepth: '$10K',
    };
    const pm = {
      marketId: 'pm-tx18',
      conditionId: 'c-tx18',
      yesPrice: 0.06, noPrice: 0.94,
      bestBid: 0.05, bestAsk: 0.06,
      lastTradePrice: 0.06,
      volume: '', liquidity: '', askDepth: 10000, noAskDepth: 10000,
    };

    const r = calculateArbitrageMax(kalshi, pm, 10000, 10000, 10000, 10000, 'Politics');

    // Kalshi YES (0.06) + PM NO (0.94) = 1.00 → exact break-even
    // Even without fees this is zero profit. With fees it's a loss.
    // Must NOT be flagged as arbitrage.
    expect(r.strategy).toBe('No arb');
    expect(r.expectedProfit).toBe(0);
    expect(r.roiPct).toBe(0);
    expect(r.kalshiStake).toBe(0);
    expect(r.pmStake).toBe(0);
  });

  it('tiny spread (0.001) after fees should still be No arb', () => {
    const kalshi = {
      ticker: 'KXTINY',
      yesBid: 0.49, yesAsk: 0.50,
      noBid: 0.49, noAsk: 0.50,
      lastPrice: 0.50,
      volume24h: '',
      yesBidDepth: '$10K', yesAskDepth: '$10K',
      noBidDepth: '$10K', noAskDepth: '$10K',
    };
    const pm = {
      marketId: 'pm-tiny',
      conditionId: 'c-tiny',
      yesPrice: 0.50, noPrice: 0.499,
      bestBid: 0.49, bestAsk: 0.50,
      lastTradePrice: 0.50,
      volume: '', liquidity: '', askDepth: 10000, noAskDepth: 10000,
    };

    const r = calculateArbitrageMax(kalshi, pm, 10000, 10000, 10000, 10000, 'Sports');

    // Kalshi YES (0.50) + PM NO (0.499) = 0.999 → gross spread 0.001
    // After fees this is negative → No arb
    expect(r.strategy).toBe('No arb');
    expect(r.expectedProfit).toBe(0);
  });
});
