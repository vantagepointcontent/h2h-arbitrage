import { describe, it, expect } from 'vitest';
import { matchOutcomes, calculateArbitrageMax, parseDepth, computeApy, normalizeName, similarity } from './matcher';
import type { KalshiMarket } from './kalshi';
import type { PMMarket } from './polymarket';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeKalshi(overrides: Partial<KalshiMarket> = {}): KalshiMarket {
  return {
    ticker: 'KXTEST-01',
    event_ticker: 'KXTEST',
    title: 'Test Market',
    yes_bid_dollars: '0.44',
    yes_ask_dollars: '0.45',
    no_bid_dollars: '0.54',
    no_ask_dollars: '0.55',
    last_price_dollars: '0.50',
    volume_24h_fp: '1000',
    yes_ask_size_fp: '5000',
    no_ask_size_fp: '5000',
    ...overrides,
  } as KalshiMarket;
}

function makePm(overrides: Partial<PMMarket> = {}): PMMarket {
  return {
    id: 'pm-1',
    conditionId: 'cond-123',
    question: 'Will X happen?',
    slug: 'test-event',
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.58","0.42"]',
    bestBid: 0.57,
    bestAsk: 0.59,
    lastTradePrice: 0.58,
    groupItemTitle: '',
    volume: '5000',
    ...overrides,
  } as PMMarket;
}

// ─── Bet-type matching tests ──────────────────────────────────────────

describe('Bet-type cross-matching prevention', () => {
  it('should not match winner market with top-scorer market for same team', () => {
    const kalshiMarkets: KalshiMarket[] = [
      makeKalshi({
        ticker: 'KX-MLSW-01',
        title: 'Who will win the MLS Cup?',
        yes_sub_title: 'Real Madrid',
        no_sub_title: 'Real Madrid No',
        custom_strike: { uuid: 'abc12345-def0-1234-5678-abcdef123456' },
      }),
      makeKalshi({
        ticker: 'KX-MLTS-01',
        title: 'MLS Cup Top Scorer',
        yes_sub_title: 'Real Madrid',
        no_sub_title: 'Real Madrid No',
        custom_strike: { uuid: 'def12345-abc0-1234-5678-abcdef123456' },
      }),
    ];

    const pmMarkets: PMMarket[] = [
      makePm({
        conditionId: 'cond-winner',
        question: 'Who will win the MLS Cup?',
        groupItemTitle: 'Real Madrid',
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.30","0.70"]',
      }),
      makePm({
        conditionId: 'cond-scorer',
        question: 'MLS Cup Top Scorer',
        groupItemTitle: 'Real Madrid',
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.15","0.85"]',
      }),
    ];

    const outcomes = matchOutcomes(kalshiMarkets, pmMarkets, 'MLS Cup', 1000);
    const matched = outcomes.filter((o: any) => o.kalshi && o.polymarket);

    // Each Kalshi market should match only its corresponding PM market (same bet type)
    // Not 4 matches (cross-bet-type), but 2 correct matches
    expect(matched.length).toBeLessThanOrEqual(2);

    // Verify no winner↔scorer cross-match
    const winnerMatch = matched.find((m: any) => m.kalshi?.ticker === 'KX-MLSW-01');
    const scorerMatch = matched.find((m: any) => m.kalshi?.ticker === 'KX-MLTS-01');
    if (winnerMatch && winnerMatch.polymarket) {
      expect(winnerMatch.polymarket.conditionId).toBe('cond-winner');
    }
    if (scorerMatch && scorerMatch.polymarket) {
      expect(scorerMatch.polymarket.conditionId).toBe('cond-scorer');
    }
  });

  it('should match winner markets across platforms when bet types align', () => {
    const kalshiMarkets: KalshiMarket[] = [
      makeKalshi({
        ticker: 'KX-WIN-01',
        title: 'Who will win the World Cup?',
        yes_sub_title: 'Brazil',
        no_sub_title: 'Brazil No',
        custom_strike: { uuid: 'aaa12345-def0-1234-5678-abcdef123456' },
      }),
    ];

    const pmMarkets: PMMarket[] = [
      makePm({
        conditionId: 'cond-win-brazil',
        question: 'Who will win the World Cup?',
        groupItemTitle: 'Brazil',
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.40","0.60"]',
      }),
    ];

    const outcomes = matchOutcomes(kalshiMarkets, pmMarkets, 'World Cup', 1000);
    const matched = outcomes.filter((o: any) => o.kalshi && o.polymarket);
    expect(matched.length).toBe(1);
    expect(matched[0].kalshi.ticker).toBe('KX-WIN-01');
    expect(matched[0].polymarket.conditionId).toBe('cond-win-brazil');
  });
});

// ─── Arbitrage calculation tests ──────────────────────────────────────

describe('calculateArbitrageMax — happy paths', () => {
  const kalshi = {
    ticker: 'KXTEST',
    yesBid: 0.44,
    yesAsk: 0.45,
    noBid: 0.54,
    noAsk: 0.55,
    lastPrice: 0.50,
    yesAskDepth: 5000,
    noAskDepth: 5000,
  };
  const pm = {
    conditionId: 'cond-1',
    marketId: 'pm-1',
    yesPrice: 0.58,
    noPrice: 0.42,
    bestBid: 0.57,
    bestAsk: 0.59,
    lastTradePrice: 0.58,
    negRisk: false,
  };

  it('detects Buy YES Kalshi + NO PM arb when prices sum < 1', () => {
    const arb = calculateArbitrageMax(kalshi as any, pm as any, 1000, 800, 500, 400);
    expect(arb.strategy).not.toBe('No arb');
    expect(arb.roiPct).toBeGreaterThan(0);
    expect(arb.expectedProfit).toBeGreaterThan(0);
    // Net of fees — profit should be less than gross
    expect(arb.fees).toBeDefined();
    if (arb.fees) {
      expect(arb.fees.worstCaseNetProfit).toBeLessThanOrEqual(arb.expectedProfit);
    }
  });

  it('detects Buy YES PM + NO Kalshi arb when reversed prices sum < 1', () => {
    const arb = calculateArbitrageMax(
      { ...kalshi, yesAsk: 0.60, noAsk: 0.40 } as any,
      { ...pm, yesPrice: 0.35, noPrice: 0.65, bestAsk: 0.35 } as any,
      1000, 800, 500, 400,
    );
    expect(arb.strategy).not.toBe('No arb');
    expect(arb.roiPct).toBeGreaterThan(0);
  });
});

describe('calculateArbitrageMax — unhappy paths', () => {
  const kalshi = {
    ticker: 'KXTEST',
    yesBid: 0.55,
    yesAsk: 0.60,
    noBid: 0.40,
    noAsk: 0.45,
    lastPrice: 0.50,
    yesAskDepth: 5000,
    noAskDepth: 5000,
  };
  const pm = {
    conditionId: 'cond-1',
    marketId: 'pm-1',
    yesPrice: 0.55,
    noPrice: 0.45,
    bestBid: 0.54,
    bestAsk: 0.56,
    lastTradePrice: 0.55,
    negRisk: false,
  };

  it('returns no arb when prices sum > 1 (no opportunity)', () => {
    const arb = calculateArbitrageMax(kalshi as any, pm as any, 1000, 800, 500, 400);
    // Both sides: 0.60 + 0.45 = 1.05 > 1, and 0.56 + 0.45 = 1.01 > 1
    expect(arb.roiPct).toBeLessThanOrEqual(0);
  });

  it('returns no arb when prices are identical on both platforms', () => {
    const identical = {
      yesBid: 0.50,
      yesAsk: 0.50,
      noBid: 0.50,
      noAsk: 0.50,
      lastPrice: 0.50,
      yesAskDepth: 5000,
      noAskDepth: 5000,
    };
    const arb = calculateArbitrageMax(identical as any, { ...pm, yesPrice: 0.50, noPrice: 0.50, bestAsk: 0.50 } as any, 1000, 800, 500, 400);
    // 0.50 + 0.50 = 1.0 — no spread, no arb
    expect(arb.roiPct).toBeLessThanOrEqual(0);
  });

  it('handles tiny spread (0.001) gracefully', () => {
    const arb = calculateArbitrageMax(
      { ...kalshi, yesAsk: 0.499, noAsk: 0.501 } as any,
      { ...pm, noPrice: 0.500, bestAsk: 0.501 } as any,
      1000, 800, 500, 400,
    );
    // Tiny spread — either small profit or small loss, must be finite
    expect(isFinite(arb.expectedProfit)).toBe(true);
    expect(isFinite(arb.roiPct)).toBe(true);
  });
});

// ─── parseDepth tests ─────────────────────────────────────────────────

describe('parseDepth', () => {
  it('parses plain numbers', () => {
    expect(parseDepth('500')).toBe(500);
    expect(parseDepth('0')).toBe(0);
    expect(parseDepth(1000)).toBe(1000);
  });

  it('parses K/M/B suffixes', () => {
    expect(parseDepth('$1.2K')).toBe(1200);
    expect(parseDepth('$2.5M')).toBe(2500000);
    expect(parseDepth('$1B')).toBe(1000000000);
  });

  it('handles null/undefined/invalid', () => {
    expect(parseDepth(null)).toBe(0);
    expect(parseDepth(undefined)).toBe(0);
    expect(parseDepth('')).toBe(0);
    expect(parseDepth('abc')).toBe(0);
  });

  it('handles Infinity string', () => {
    expect(parseDepth('Infinity')).toBe(Infinity);
  });
});

// ─── computeApy tests ─────────────────────────────────────────────────

describe('computeApy', () => {
  it('returns raw ROI for null expiry (no annualization)', () => {
    expect(computeApy(10, null)).toBe(10);
    expect(computeApy(10, undefined)).toBe(10);
  });

  it('returns 0 for past expiry', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(computeApy(10, past)).toBe(0);
  });

  it('annualizes ROI for future expiry', () => {
    const future365 = new Date(Date.now() + 365 * 86400000).toISOString();
    const apy = computeApy(10, future365);
    expect(apy).toBeCloseTo(10, 0); // ~10% APY for 10% ROI over 1 year
  });

  it('inflates ROI for short-dated markets', () => {
    const future7 = new Date(Date.now() + 7 * 86400000).toISOString();
    const apy = computeApy(5, future7);
    expect(apy).toBeGreaterThan(100); // 5% over 7 days = ~260% APY
  });
});

// ─── normalizeName & similarity ───────────────────────────────────────

describe('normalizeName', () => {
  it('lowercases and strips special chars', () => {
    expect(normalizeName('Real Madrid!')).toBe('real madrid');
    expect(normalizeName('U.S.A.')).toBe('usa');
  });

  it('collapses whitespace', () => {
    expect(normalizeName('  extra   spaces  ')).toBe('extra spaces');
  });
});

describe('similarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(similarity('real madrid', 'real madrid')).toBe(1.0);
  });

  it('returns 0 for completely different strings', () => {
    expect(similarity('real madrid', 'liverpool fc')).toBe(0);
  });

  it('returns partial similarity for overlapping words', () => {
    const s = similarity('real madrid winner', 'real madrid');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});