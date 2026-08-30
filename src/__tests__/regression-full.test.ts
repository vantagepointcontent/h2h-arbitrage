import { describe, it, expect } from 'vitest';
import {
  calculateArbitrageMax,
  computeApy,
  parseDepth,
  buildPmArbShape,
  buildKalshiArbShape,
} from '../lib/matcher';
import type { PMMarket } from '../lib/polymarket';
import type { KalshiMarket } from '../lib/kalshi';

// ==================== R1-R6: parseDepth ====================
describe('REGRESSION: parseDepth', () => {
  it('R1: "$1.2K" → 1200', () => expect(parseDepth('$1.2K')).toBe(1200));
  it('R2: "$500" → 500', () => expect(parseDepth('$500')).toBe(500));
  it('R3: "0" → 0', () => expect(parseDepth('0')).toBe(0));
  it('R4: null → 0', () => expect(parseDepth(null)).toBe(0));
  it('R5: "invalid" → 0', () => expect(parseDepth('invalid')).toBe(0));
  it('R6: "(empty)" → 0', () => expect(parseDepth('')).toBe(0));
});

// ==================== R7-R10: calculateArbitrageMax ====================
function makePmShape(overrides?: any): any {
  const pm: PMMarket = {
    id: 'pm-test-001',
    conditionId: 'cond-test-001',
    question: 'Test market',
    slug: 'test-market',
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.52","0.48"]',
    bestAsk: 0.52,
    bestBid: 0.50,
    lastTradePrice: 0.52,
    active: true,
    closed: false,
    liquidityNum: 1000,
    yesMinOrderSize: 1,
    noMinOrderSize: 1,
    yesTickSize: 0.01,
    noTickSize: 0.01,
    feesEnabled: true,
    feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.25 },
    ...overrides,
  };
  return buildPmArbShape(pm);
}

function makeKalshiShape(overrides?: any): any {
  const km: KalshiMarket = {
    ticker: 'KX-TEST-001',
    event_ticker: 'KX-TEST',
    yes_ask_dollars: '0.56',
    no_ask_dollars: '0.46',
    yes_bid_dollars: '0.54',
    no_bid_dollars: '0.44',
    last_price_dollars: '0.55',
    yes_ask_size_fp: '$1,000',
    no_ask_size_fp: '$800',
    ...overrides,
  };
  return buildKalshiArbShape(km);
}

describe('REGRESSION: calculateArbitrageMax', () => {
  it('R7: depth=0 is unexecutable rather than fallback capital', () => {
    const arb = calculateArbitrageMax(
      makeKalshiShape({ no_ask_dollars: '0.40', no_bid_dollars: '0.38' }),
      makePmShape(),
      0, 0, 0, 0, 'Sports',
    );
    expect(arb.maxCapital).toBe(0);
    expect(arb.depthVerified).toBe(false);
  });

  it('R8: hög depth → maxCapital &gt; 0', () => {
    const arb = calculateArbitrageMax(
      makeKalshiShape({ no_ask_dollars: '0.40', no_bid_dollars: '0.38' }),
      makePmShape(),
      1000, 800, 500, 400, 'Sports',
    );
    expect(arb.maxCapital).toBeGreaterThan(0);
  });

  it('R9: ROI = (profit/stake)*100', () => {
    const arb = calculateArbitrageMax(makeKalshiShape(), makePmShape(), 1000, 800, 500, 400, 'Sports');
    const totalStake = arb.kalshiStake + arb.pmStake;
    if (totalStake > 0) {
      const expectedRoi = (arb.expectedProfit / totalStake) * 100;
      expect(Math.abs(arb.roiPct - expectedRoi)).toBeLessThan(0.1);
    }
  });

  it('R10: kalshiYes &lt; pmNo → Buy YES Kalshi + NO PM', () => {
    // Sätt upp så att Buy YES Kalshi + NO PM är klart bäst
    const kalshi = makeKalshiShape({ yes_ask_dollars: '0.45', no_ask_dollars: '0.55' });
    const pm = makePmShape({ bestAsk: 0.60, outcomePrices: '["0.60","0.40"]', bestBid: 0.58 });
    const arb = calculateArbitrageMax(kalshi, pm, 1000, 1000, 1000, 1000, 'Sports');
    expect(arb.strategy).toContain('Buy YES Kalshi');
    expect(arb.strategy).toContain('NO PM');
  });
});

// ==================== R11-R13: buildPmArbShape ====================
describe('REGRESSION: buildPmArbShape', () => {
  it('R11: bestAsk=null, bestBid=null → använder gamma prices', () => {
    const pm: PMMarket = {
      id: 'pm-test',
      conditionId: 'cond-test',
      question: 'Test',
      slug: 'test',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.35","0.65"]',
      active: true,
      closed: false,
    };
    const shape = buildPmArbShape(pm);
    expect(shape.yesPrice).toBe(0.35);
    expect(shape.noPrice).toBe(0.65);
  });

  it('R12: bestAsk=0.40 → yesPrice=0.40', () => {
    const pm: PMMarket = {
      id: 'pm-test',
      conditionId: 'cond-test',
      question: 'Test',
      slug: 'test',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.35","0.65"]',
      bestAsk: 0.40,
      bestBid: 0.38,
      active: true,
      closed: false,
    };
    const shape = buildPmArbShape(pm);
    expect(shape.yesPrice).toBe(0.40);
  });

  it('R13: neg-risk → använder outcomePrices direkt', () => {
    const pm: PMMarket = {
      id: 'pm-test',
      conditionId: 'cond-test',
      question: 'Test',
      slug: 'test',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.35","0.40"]',
      neg_risk: true,
      active: true,
      closed: false,
    };
    const shape = buildPmArbShape(pm);
    expect(shape.yesPrice).toBe(0.35);
    expect(shape.noPrice).toBe(0.40);
  });
});

// ==================== R14-R16: buildKalshiArbShape ====================
describe('REGRESSION: buildKalshiArbShape', () => {
  it('R14: yes_ask_dollars=0.55 → yesAsk=0.55', () => {
    const km: KalshiMarket = {
      ticker: 'KX-TEST-001',
      event_ticker: 'KX-TEST',
      yes_ask_dollars: '0.55',
      no_ask_dollars: '0.45',
      yes_ask_size_fp: '$1K',
      no_ask_size_fp: '$800',
    };
    const shape = buildKalshiArbShape(km);
    expect(shape.yesAsk).toBe(0.55);
  });

  it('R15: contract depth is converted to selected-ask USD notional', () => {
    const km: KalshiMarket = {
      ticker: 'KX-TEST-001',
      event_ticker: 'KX-TEST',
      yes_ask_dollars: '0.20',
      yes_ask_size_fp: '1200',
      yes_bid_dollars: '0.50',
      yes_bid_size_fp: '500',
      no_ask_dollars: '0.50',
    };
    const shape = buildKalshiArbShape(km);
    expect(shape.yesAskDepth).toBe('240.000000');
    expect(shape.noAskDepth).toBe('250.000000');
  });

  it('R16: missing Kalshi quotes are unavailable, never synthetic $1 asks', () => {
    const km: KalshiMarket = {
      ticker: 'KX-TEST-001',
      event_ticker: 'KX-TEST',
    };
    const shape = buildKalshiArbShape(km);
    expect(shape.yesAsk).toBe(0);
    expect(shape.noAsk).toBe(0);
    expect(shape.yesAskDepth).toBeUndefined();
  });

  it('R16a: a Kalshi ask with unknown size remains visible but explicit zero size is not executable', () => {
    const missingSize = buildKalshiArbShape({
      ticker: 'KXLIVTOUR-YOR26-CSMI',
      event_ticker: 'KXLIVTOUR-YOR26',
      yes_ask_dollars: '0.0100',
      yes_ask_size_fp: '55200.00',
      no_ask_dollars: '1.0000',
      // Some Kalshi responses omit no_ask_size_fp even when the quote is valid.
    });
    const explicitZero = buildKalshiArbShape({
      ticker: 'KXLIVTOUR-YOR26-ZERO',
      event_ticker: 'KXLIVTOUR-YOR26',
      no_ask_dollars: '1.0000',
      yes_bid_size_fp: '0',
    });

    expect(missingSize.yesAsk).toBe(0.01);
    expect(missingSize.noAsk).toBe(1);
    expect(explicitZero.noAsk).toBe(0);
  });

  it('R16b: malformed Kalshi prices become safe non-executable values', () => {
    const shape = buildKalshiArbShape({
      ticker: 'KX-MALFORMED',
      event_ticker: 'KX-TEST',
      yes_bid_dollars: 'not-a-price',
      yes_ask_dollars: 'Infinity',
      no_bid_dollars: '-0.01',
      no_ask_dollars: 'NaN',
      last_price_dollars: 'bad-data',
    });

    expect(shape).toMatchObject({
      yesBid: 0,
      yesAsk: 0,
      noBid: 0,
      noAsk: 0,
      lastPrice: 0,
    });
  });

  it('R16c: normalized Kalshi shape is safe for manual-match response rows', () => {
    const shape = buildKalshiArbShape({
      ticker: 'KX-MANUAL-MALFORMED',
      event_ticker: 'KX-TEST',
      yes_ask_dollars: 'Infinity',
      no_ask_dollars: 'not-a-price',
    });

    // The scan route uses this shape directly for skipAutoMatch rows. No raw
    // upstream numeric value may enter that client-facing response.
    expect(Number.isFinite(shape.yesAsk)).toBe(true);
    expect(Number.isFinite(shape.noAsk)).toBe(true);
    expect(shape.yesAsk).toBe(0);
    expect(shape.noAsk).toBe(0);
  });
});

// ==================== R17-R19: computeApy ====================
describe('REGRESSION: computeApy', () => {
  it('R17: APY annualiserar ROI', () => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    const apy = computeApy(10, future.toISOString());
    expect(apy).toBeGreaterThan(100);
  });

  it('R18: expired event → unavailable APY', () => {
    const past = new Date();
    past.setDate(past.getDate() - 1);
    const apy = computeApy(10, past.toISOString());
    expect(apy).toBeNull();
  });

  it('R19: null/undefined expiry → unavailable APY', () => {
    expect(computeApy(10, null as any)).toBeNull();
    expect(computeApy(10, undefined as any)).toBeNull();
  });
});

// ==================== R20-R22: chooseBestPmStructure heuristik ====================
describe('REGRESSION: chooseBestPmStructure', () => {
  const chooseBestPmStructure = (allPmMarkets: any[]): any[] => {
    const namedMarkets = allPmMarkets.filter((m: any) =>
      m.groupItemTitle && m.groupItemTitle !== '' && m.groupItemTitle !== 'N/A'
    );
    const unnamedMarkets = allPmMarkets.filter((m: any) =>
      !m.groupItemTitle || m.groupItemTitle === '' || m.groupItemTitle === 'N/A'
    );
    if (namedMarkets.length === 0) return unnamedMarkets;
    if (unnamedMarkets.length === 0) return namedMarkets;
    const uniqueGroups = new Set(namedMarkets.map((m: any) => m.groupItemTitle));
    if (uniqueGroups.size > 1 && namedMarkets.length >= unnamedMarkets.length) {
      return namedMarkets;
    }
    return unnamedMarkets.length > namedMarkets.length ? unnamedMarkets : namedMarkets;
  };

  it('R20: alla unnamed → returnerar unnamed', () => {
    const markets = [{ groupItemTitle: '' }, { groupItemTitle: '' }];
    expect(chooseBestPmStructure(markets)).toHaveLength(2);
  });

  it('R21: flera olika groupItemTitle → returnerar named (turnering)', () => {
    const markets = [
      { groupItemTitle: 'Match A' }, { groupItemTitle: 'Match B' },
      { groupItemTitle: '' },
    ];
    const result = chooseBestPmStructure(markets);
    expect(result).toHaveLength(2);
    expect(result[0].groupItemTitle).toBe('Match A');
  });

  it('R22: blandat utan turnering → väljer längsta', () => {
    const markets = [
      { groupItemTitle: 'Group A' }, { groupItemTitle: 'Group A' },
      { groupItemTitle: '' }, { groupItemTitle: '' }, { groupItemTitle: '' },
    ];
    const result = chooseBestPmStructure(markets);
    expect(result).toHaveLength(3); // unnamed är längst
  });
});

// ==================== R23-R24: API timeout safety ====================
describe('REGRESSION: withTimeout', () => {
  const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    );
    return Promise.race([promise, timeout]);
  };

  it('R23: snabb promise → returnerar värdet', async () => {
    const result = await withTimeout(Promise.resolve('success'), 1000, 'test');
    expect(result).toBe('success');
  });

  it('R24: långsam promise → rejectar med timeout-fel', async () => {
    await expect(withTimeout(new Promise(() => {}), 50, 'slow')).rejects.toThrow('timed out');
  });
});
