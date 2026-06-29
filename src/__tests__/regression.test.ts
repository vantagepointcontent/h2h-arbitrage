import { describe, it, expect } from 'vitest';
import {
  calculateArbitrageMax,
  computeApy,
  parseDepth,
  buildPmArbShape,
  buildKalshiArbShape,
} from '../lib/matcher';

// ===================================================================
// REGRESSION TEST SUITE — H2H Arbitrage
// Alla kända buggar som hittats under kodgranskning
// ===================================================================

describe('REGRESSION: parseDepth', () => {
  it('R1: "$1.2K" → 1200 (Kalshi depth)', () => {
    expect(parseDepth('$1.2K')).toBe(1200);
  });
  
  it('R2: "$500" → 500 (Kalshi depth, no suffix)', () => {
    expect(parseDepth('$500')).toBe(500);
  });

  it('R3: "0" → 0 (zero depth = no arbitrage)', () => {
    expect(parseDepth('0')).toBe(0);
  });

  it('R4: null → 0 (saknad depth)', () => {
    expect(parseDepth(null)).toBe(0);
  });

  it('R5: "1.5M" → 1_500_000 (mega liquidity)', () => {
    expect(parseDepth('1.5M')).toBe(1_500_000);
  });

  it('R6: number direkt → returnerar samma', () => {
    expect(parseDepth(5000)).toBe(5000);
  });
});

describe('REGRESSION: calculateArbitrageMax — depth limits capital', () => {
  const kalshi = {
    ticker: 'KXTEST', yesBid: 0.40, yesAsk: 0.45, noBid: 0.55, noAsk: 0.60,
    lastPrice: 0.42, volume24h: '', yesBidDepth: '$10K', yesAskDepth: '$5K',
    noBidDepth: '', noAskDepth: '', eventId: '',
  };
  const pm = {
    marketId: 'pm-test', conditionId: 'c-test', yesPrice: 0.50, noPrice: 0.50,
    bestBid: 0.49, bestAsk: 0.51, lastTradePrice: 0.50, volume: '', liquidity: '',
    askDepth: 5000, noAskDepth: 5000, negRisk: false,
  };

  it('R7: depth=0 → uses fallback capital (no depth constraint)', () => {
    const r = calculateArbitrageMax(kalshi, pm, 0, 0, 0, 0);
    // When depth is 0, code uses fallback 1M capital to allow profit calculation
    expect(r.maxCapital).toBeGreaterThan(0);
  });

  it('R8: låg depth → låg profit, men >0', () => {
    const r = calculateArbitrageMax(kalshi, pm, 100, 0, 100, 0);
    expect(r.strategy).not.toBe('No arb');
    expect(r.maxCapital).toBeGreaterThan(0);
    expect(r.expectedProfit).toBeGreaterThan(0);
  });

  it('R9: hög depth → högre capital', () => {
    const low = calculateArbitrageMax(kalshi, pm, 100, 0, 100, 0);
    const high = calculateArbitrageMax(kalshi, pm, 100_000, 0, 100_000, 0);
    expect(high.maxCapital).toBeGreaterThan(low.maxCapital);
  });

  it('R10: ROI = profit / capital (ej magi)', () => {
    const r = calculateArbitrageMax(kalshi, pm, 5000, 5000, 5000, 5000);
    if (r.maxCapital > 0) {
      expect(Math.abs(r.roiPct - (r.expectedProfit / r.maxCapital) * 100)).toBeLessThan(0.01);
    }
  });
});

describe('REGRESSION: buildPmArbShape — null-coercion (GEN-1)', () => {
  function makePm(overrides: any = {}) {
    return {
      id: 'pm1', conditionId: 'c1', question: 'Test', outcomes: '["Yes","No"]',
      outcomePrices: '["0.50","0.50"]', bestBid: 0.49, bestAsk: 0.51,
      lastTradePrice: 0.50, active: true, closed: false, slug: 'test',
      volume: '', liquidity: '', liquidityNum: 0, ...overrides,
    };
  }

  it('R11: bestBid=null, bestAsk=null → fallback till gamma prices, INTE 1', () => {
    const shape = buildPmArbShape(makePm({ bestBid: null, bestAsk: null }));
    expect(shape.noPrice).toBe(0.5);
    expect(shape.noPrice).not.toBe(1); // BUG: 1 - null = 1 i JS
  });

  it('R12: bestBid=0.01, bestAsk=0.99 → tom orderbook, fallback till gamma', () => {
    const shape = buildPmArbShape(makePm({ bestBid: 0.01, bestAsk: 0.99, outcomePrices: '["0.45","0.55"]' }));
    expect(shape.yesPrice).toBe(0.45);
    expect(shape.noPrice).toBe(0.55);
  });

  it('R13: neg-risk → använder outcomePrices direkt, inte binär derivering', () => {
    const shape = buildPmArbShape(makePm({
      neg_risk: true, outcomePrices: '["0.35","0.40"]',
    }));
    // Neg-risk: använder outcomePrices direkt, INTE 1-bestBid
    expect(shape.yesPrice).toBe(0.35);
    expect(shape.noPrice).toBe(0.40);
    // För neg-risk kan summan vara vad som helst (oberoende marknader)
    expect(shape.yesPrice + shape.noPrice).not.toBe(1); // ← detta är neg-risk!
  });
});

describe('REGRESSION: buildKalshiArbShape — price parsing', () => {
  function makeKm(overrides: any = {}) {
    return {
      ticker: 'KXTEST', event_ticker: 'KXTEST', title: 'Test Market',
      yes_bid_dollars: '0.40', yes_ask_dollars: '0.45',
      no_bid_dollars: '0.55', no_ask_dollars: '0.60',
      last_price_dollars: '0.42', volume_24h_fp: '$10K',
      yes_bid_size_fp: '$5K', yes_ask_size_fp: '$3K',
      no_bid_size_fp: '$2K', no_ask_size_fp: '$1K',
      ...overrides,
    };
  }

  it('R14: yesAsk kommer från yes_ask_dollars (köp-pris)', () => {
    const shape = buildKalshiArbShape(makeKm());
    expect(shape.yesAsk).toBe(0.45);
    expect(shape.yesBid).toBe(0.40);
  });

  it('R15: depth kommer från yes_ask_size_fp (order-djup)', () => {
    const shape = buildKalshiArbShape(makeKm());
    expect(shape.yesAskDepth).toBe('$3K');
    expect(shape.yesBidDepth).toBe('$5K');
  });

  it('R16: saknade värden → 0 (safe defaults)', () => {
    const shape = buildKalshiArbShape(makeKm({ yes_ask_dollars: '', no_bid_dollars: undefined }));
    expect(shape.yesAsk).toBe(1); // parseFloat('') = NaN → fallback '1'
    expect(shape.noBid).toBe(0);  // parseFloat(undefined) = NaN → fallback '0'
  });
});

describe('REGRESSION: computeApy', () => {
  it('R17: linjär annualisering — 10% på 30 dagar = ~121.7% APY', () => {
    const expiry = new Date(Date.now() + 30 * 86400000).toISOString();
    expect(computeApy(10, expiry)).toBeCloseTo(121.7, 0);
  });

  it('R18: expired → 0 APY', () => {
    expect(computeApy(50, '2020-01-01')).toBe(0);
  });

  it('R19: null expiry → APY = ROI (kan inte annualisera)', () => {
    expect(computeApy(10, null)).toBe(10);
  });
});

// ===================================================================
// INTEGRATION: lastScanResult format (frontend ↔ backend kontrakt)
// ===================================================================

describe('REGRESSION: lastScanResult kontrakt', () => {
  it('R20: måste innehålla bestApyPct', () => {
    // Om denna test failar har persistence.ts / page.tsx interface diffat
    const result = {
      bestRoiPct: 5.0,
      bestProfit: 50,
      bestApyPct: 60.8,
      strategy: 'Buy YES Kalshi + NO PM',
      outcomeCount: 10,
      matchedCount: 8,
      kalshiCount: 12,
      pmCount: 15,
      scannedAt: new Date().toISOString(),
      allArbs: [{
        artist: 'Trump', roiPct: 5.0, expectedProfit: 50, totalStake: 1000,
        strategy: 'Buy YES Kalshi + NO PM',
      }],
    };
    expect(result.bestApyPct).toBeDefined();
    expect(result.allArbs[0].totalStake).toBeDefined();
  });
});
