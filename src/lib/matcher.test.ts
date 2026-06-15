import { describe, it, expect } from 'vitest';
import {
  calculateArbitrageMax,
  computeApy,
  parseDepth,
  normalizeName,
  similarity,
  matchOutcomes,
  buildPmArbShape,
} from './matcher';
import { getClobPrices } from './polymarket-clob';

describe('calculateArbitrageMax', () => {
  const kalshi = {
    ticker: 'KXTEST',
    yesBid: 0.40, yesAsk: 0.45,
    noBid: 0.55, noAsk: 0.60,
    lastPrice: 0.42,
    volume24h: '', yesBidDepth: '$10K', yesAskDepth: '$5K', noBidDepth: '', noAskDepth: '',
  };
  const pm = {
    marketId: 'pm-test', conditionId: 'c-test',
    yesPrice: 0.50, noPrice: 0.50,
    bestBid: 0.49, bestAsk: 0.51,
    lastTradePrice: 0.50,
    volume: '', liquidity: '', askDepth: 5000,
  };

  it('beaktar Kalshi depth för kapital', () => {
    const r = calculateArbitrageMax(kalshi, pm, 5000, 0, 5000, 0);
    expect(r.maxCapital).toBeGreaterThan(0);
    expect(r.strategy).not.toBe('No arb');
  });

  it('beaktar PM depth för kapital', () => {
    const r = calculateArbitrageMax(kalshi, pm, 5000, 0, 5000, 0);
    expect(r.pmStake).toBeGreaterThan(0);
    expect(r.kalshiStake).toBeGreaterThan(0);
  });

  it('ger No arb om ingen depth', () => {
    const r = calculateArbitrageMax(
      { ...kalshi, yesAskDepth: '0', noAskDepth: '0' },
      { ...pm, askDepth: 0 },
      0, 0, 0, 0
    );
    expect(r.strategy).toBe('No arb');
  });

  it('depth begränsar maxCapital', () => {
    // Låg depth = låg capital
    const low = calculateArbitrageMax(kalshi, pm, 100, 0, 100, 0);
    const high = calculateArbitrageMax(kalshi, pm, 100_000, 0, 100_000, 0);
    expect(high.maxCapital).toBeGreaterThan(low.maxCapital);
  });
});

describe('computeApy', () => {
  it('ger ROI som APY om ingen expiryDate (kan inte annualisera)', () => {
    expect(computeApy(10, null)).toBe(10);
    expect(computeApy(10, undefined)).toBe(10);
  });

  it('linjär annualisering: 10% på 30 dagar', () => {
    const expiry = new Date(Date.now() + 30 * 86400000).toISOString();
    expect(computeApy(10, expiry)).toBeCloseTo(121.7, 0);
  });

  it('expired → 0', () => {
    expect(computeApy(50, '2020-01-01')).toBe(0);
  });

  it('en dag → 3650% APY (linjär extrapolering)', () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    expect(computeApy(10, tomorrow)).toBeCloseTo(3650, 0);
  });

  it('365 dagar → samma APY som ROI', () => {
    const inOneYear = new Date(Date.now() + 365 * 86400000).toISOString();
    expect(computeApy(10, inOneYear)).toBeCloseTo(10, 0);
  });
});

describe('parseDepth', () => {
  it('hanterar $ suffix', () => {
    expect(parseDepth('$5K')).toBe(5000);
    expect(parseDepth('$1.5M')).toBe(1_500_000);
  });

  it('hanterar nummer direkt', () => {
    expect(parseDepth(1000)).toBe(1000);
    expect(parseDepth('0')).toBe(0);
  });

  it('hanterar null/undefined', () => {
    expect(parseDepth(null)).toBe(0);
    expect(parseDepth(undefined)).toBe(0);
  });

  it('hanterar tom string', () => {
    expect(parseDepth('')).toBe(0);
    expect(parseDepth('  ')).toBe(0);
  });
});

describe('normalizeName', () => {
  it('lowercase + tar bort icke-alfanumeriska', () => {
    expect(normalizeName('Elon Musk!!')).toBe('elon musk');
  });

  it('kollapsar mellanslag', () => {
    expect(normalizeName('  TrumP   WIN  ')).toBe('trump win');
  });
});

describe('similarity', () => {
  it('ger 1 vid identiska ord', () => {
    expect(similarity('trump win election', 'trump win election')).toBe(1);
  });

  it('ger 0 vid ingen överlapp', () => {
    expect(similarity('alpha beta', 'gamma delta')).toBe(0);
  });

  it('ger mellanvärde vid partiell match', () => {
    const s = similarity('trump win election', 'trump lose election');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it('upprepade ord ger lågt/medium score — known behavior', () => {
    const s = similarity('trump trump trump win', 'trump lose');
    expect(s).toBeGreaterThan(0); // bara att det inte kraschar
    expect(s).toBeLessThan(1);
  });
});

describe('getClobPrices', () => {
  it(' YES/NO från tokens', () => {
    const r = getClobPrices({
      condition_id: 'c1',
      tokens: [
        { token_id: 't1', outcome: 'Yes', price: 0.55 },
        { token_id: 't2', outcome: 'No', price: 0.45 },
      ],
      best_bid: 0.54, best_ask: 0.56, last_trade_price: 0.55,
    } as any);
    expect(r?.yesPrice).toBe(0.55);
    expect(r?.noPrice).toBe(0.45);
  });

  it('fallback till best_bid/best_ask om token saknar price', () => {
    const r = getClobPrices({
      condition_id: 'c1',
      tokens: [
        { token_id: 't1', outcome: 'Yes' },
        { token_id: 't2', outcome: 'No' },
      ],
      best_bid: 0.54, best_ask: 0.56, last_trade_price: 0.55,
    } as any);
    expect(r?.yesPrice).toBe(0.56); // YES best_ask
    expect(r?.noPrice).toBeCloseTo(0.44, 6);   // NO ask derived from 1 - YES best_bid
  });

  it('deriverar noPrice från yesPrice (1 - yes)', () => {
    const r = getClobPrices({
      condition_id: 'c1',
      tokens: [
        { token_id: 't1', outcome: 'Yes', price: 0.60 },
        { token_id: 't2', outcome: 'No' },
      ],
      best_bid: 0.59, best_ask: 0.61,
    } as any);
    expect(r?.noPrice).toBeCloseTo(0.40, 2);
  });

  it('returnerar null vid total avsaknad av data', () => {
    const r = getClobPrices({
      condition_id: 'c1',
      tokens: [],
    } as any);
    expect(r).toBeNull();
  });
});

describe('matchOutcomes', () => {
  it('matchar exakt identiska namn', () => {
    const km = [{ ticker: 'KXTRUMP', event_ticker: 'KXTRUMP', title: 'Will Trump win?', yes_bid_dollars: '0.40', yes_ask_dollars: '0.45', no_bid_dollars: '0.55', no_ask_dollars: '0.60' }];
    const pm = [{ id: 'pm1', conditionId: 'c1', question: 'Trump Win?', outcomes: '["Yes","No"]', outcomePrices: '["0.50","0.50"]', active: true, closed: false, slug: 'trump' }];
    const r = matchOutcomes(km as any, pm as any, 'Trump Win?', 1000, new Date(Date.now() + 86400000 * 30).toISOString());
    expect(r.length).toBeGreaterThan(0);
  });

  it('returnerar unmatched om inga likheter', () => {
    const km = [{ ticker: 'KXSPACE', event_ticker: 'KXSPACE', title: 'SpaceX launch?', yes_bid_dollars: '0.40', yes_ask_dollars: '0.45', no_bid_dollars: '0.55', no_ask_dollars: '0.60' }];
    const pm = [{ id: 'pm1', conditionId: 'c1', question: 'Biden approval?', outcomes: '["Yes","No"]', outcomePrices: '["0.50","0.50"]', active: true, closed: false, slug: 'biden' }];
    const r = matchOutcomes(km as any, pm as any, 'Biden approval?', 1000);
    const matched = r.filter(o => o.kalshi && o.polymarket);
    expect(matched.length).toBe(0); // inga matchar
  });
});

// =====================================================================
// REGRESSION TESTS: Null-safe price coercion (GEN-1)
// Regression for: bestBid=null causes 1-null=1 in JS
// =====================================================================

function makePmMarket(overrides: Partial<any> = {}) {
  return {
    id: 'pm-regression',
    conditionId: 'cond-123',
    question: 'Test Market',
    outcomes: '[\"Yes\",\"No\"]',
    outcomePrices: '[\"0.50\",\"0.50\"]',
    bestBid: 0.50,
    bestAsk: 0.51,
    lastTradePrice: 0.50,
    active: true,
    closed: false,
    slug: 'test-market',
    ...overrides,
  };
}

describe('buildPmArbShape — null coercion regression (GEN-1)', () => {
  // --- Core null-coercion bug: 1 - null = 1 in JS ---
  describe('null bestBid/bestAsk handling', () => {
    it('both null → falls back to gamma outcomePrices', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: null,
        bestAsk: null,
        outcomePrices: '[\"0.42\",\"0.58\"]',
      }));
      expect(shape.yesPrice).toBe(0.42);
      expect(shape.noPrice).toBe(0.58);
      // CRITICAL: noPrice must NOT be 1 (the old bug: 1 - null = 1)
      expect(shape.noPrice).not.toBe(1);
    });

    it('only bestBid null → derives from bestAsk', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: null,
        bestAsk: 0.55,
      }));
      expect(shape.yesPrice).toBe(0.55);
      expect(shape.noPrice).toBeCloseTo(0.45, 6); // 1 - 0.55
      expect(shape.noPrice).not.toBe(1); // regression: must not be 1
    });

    it('only bestAsk null → derives from bestBid', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: 0.48,
        bestAsk: null,
      }));
      expect(shape.yesPrice).toBeCloseTo(0.52, 6); // 1 - 0.48
      expect(shape.noPrice).toBe(0.48);
    });

    it('both present → standard derivation', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: 0.49,
        bestAsk: 0.51,
      }));
      expect(shape.yesPrice).toBe(0.51);
      expect(shape.noPrice).toBeCloseTo(0.51, 6); // 1 - 0.49
    });

    it('undefined bestBid/bestAsk → same as null (both != null catches both)', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: undefined,
        bestAsk: undefined,
        outcomePrices: '[\"0.33\",\"0.67\"]',
      }));
      expect(shape.yesPrice).toBe(0.33);
      expect(shape.noPrice).toBe(0.67);
    });
  });

  // --- Empty orderbook detection ---
  describe('empty orderbook detection', () => {
    it('bestAsk >= 0.99 && bestBid <= 0.01 → uses gamma prices', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: 0.01,
        bestAsk: 0.99,
        outcomePrices: '[\"0.45\",\"0.55\"]',
      }));
      expect(shape.yesPrice).toBe(0.45);
      expect(shape.noPrice).toBe(0.55);
    });

    it('bestAsk = 1.00 && bestBid = 0.00 → uses gamma prices', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: 0,
        bestAsk: 1,
        outcomePrices: '[\"0.60\",\"0.40\"]',
      }));
      expect(shape.yesPrice).toBe(0.60);
      expect(shape.noPrice).toBe(0.40);
    });

    it('normal spread (not empty) → uses orderbook', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: 0.49,
        bestAsk: 0.51,
        outcomePrices: '[\"0.99\",\"0.01\"]',
      }));
      // Should use orderbook, NOT gamma prices
      expect(shape.yesPrice).toBe(0.51);
      expect(shape.noPrice).toBeCloseTo(0.51, 6);
    });
  });

  // --- Neg-risk markets ---
  describe('neg-risk markets', () => {
    it('uses CLOB outcomePrices directly (not binary derivation)', () => {
      const shape = buildPmArbShape(makePmMarket({
        neg_risk: true,
        bestBid: 0.30,
        bestAsk: 0.35,
        outcomePrices: '[\"0.35\",\"0.40\"]',
      }));
      // Neg-risk: uses outcomePrices directly, NOT 1-bestBid
      expect(shape.yesPrice).toBe(0.35);
      expect(shape.noPrice).toBe(0.40);
      // Sum can exceed 1 for neg-risk
      expect(shape.yesPrice + shape.noPrice).toBeGreaterThan(0.7);
    });

    it('neg-risk with null bestBid/bestAsk → uses CLOB prices', () => {
      const shape = buildPmArbShape(makePmMarket({
        neg_risk: true,
        bestBid: null,
        bestAsk: null,
        outcomePrices: '[\"0.25\",\"0.30\"]',
      }));
      expect(shape.yesPrice).toBe(0.25);
      expect(shape.noPrice).toBe(0.30);
    });

    it('neg-risk empty orderbook → uses gamma prices', () => {
      const shape = buildPmArbShape(makePmMarket({
        neg_risk: true,
        bestBid: 0.01,
        bestAsk: 0.99,
        outcomePrices: '[\"0.20\",\"0.25\"]',
      }));
      expect(shape.yesPrice).toBe(0.20);
      expect(shape.noPrice).toBe(0.25);
    });
  });

  // --- Edge cases ---
  describe('edge cases', () => {
    it('zero gamma prices → safe defaults', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: null,
        bestAsk: null,
        outcomePrices: '[\"0\",\"0\"]',
      }));
      expect(shape.yesPrice).toBe(0);
      expect(shape.noPrice).toBe(0); // 1 - 0 = 1, but with ?? 0 fallback
    });

    it('extreme gamma prices (>1 range handled gracefully)', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: null,
        bestAsk: null,
        outcomePrices: '[\"1.50\",\"-0.10\"]',
      }));
      expect(shape.yesPrice).toBe(1.5);
      expect(shape.noPrice).toBe(-0.1);
    });

    it('bestAsk only, very small value → noPrice close to 1', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: null,
        bestAsk: 0.01,
      }));
      expect(shape.yesPrice).toBe(0.01);
      expect(shape.noPrice).toBeCloseTo(0.99, 6);
    });

    it('bestBid only, very large value → yesPrice close to 0', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: 0.99,
        bestAsk: null,
      }));
      expect(shape.yesPrice).toBeCloseTo(0.01, 6);
      expect(shape.noPrice).toBe(0.99);
    });

    it('returned shape has correct bestBid/bestAsk fallbacks', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: null,
        bestAsk: null,
        outcomePrices: '[\"0.50\",\"0.50\"]',
      }));
      expect(shape.bestBid).toBe(0.5);
      expect(shape.bestAsk).toBe(0.5);
    });
  });

  // --- Original bug reproduction ---
  describe('original bug: 1 - null = 1', () => {
    it('BUG REPRODUCTION: without !=null check, noPrice would be 1', () => {
      // Simulate what the OLD buggy code would do:
      // Old code: noPrice = 1 - bestBid (without null check)
      // 1 - null = 1 in JS
      const oldStyleNoPrice = 1 - null; // = 1
      expect(oldStyleNoPrice).toBe(1);

      // Our fix ensures this never happens
      const shape = buildPmArbShape(makePmMarket({
        bestBid: null,
        bestAsk: null,
        outcomePrices: '[\"0.42\",\"0.58\"]',
      }));
      expect(shape.noPrice).toBe(0.58);
      expect(shape.noPrice).not.toBe(1); // THE FIX
    });

    it('bestBid null with valid bestAsk → noPrice derived from bestAsk, not null', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: null,
        bestAsk: 0.60,
      }));
      // Old bug: would compute noPrice = 1 - null = 1
      // Fixed: noPrice = 1 - bestAsk = 0.40
      expect(shape.noPrice).toBeCloseTo(0.40, 6);
      expect(shape.noPrice).not.toBe(1);
    });
  });
});
