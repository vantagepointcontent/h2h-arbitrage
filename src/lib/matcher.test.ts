import { describe, it, expect, vi } from 'vitest';
import {
  calculateArbitrageMax,
  calculateBestArbitrageForOutcome,
  calculateAllArbitrages,
  computeApy,
  parseDepth,
  normalizeName,
  similarity,
  matchOutcomes,
  buildPmArbShape,
  buildKalshiArbShape,
  normalizeOutcomePlatforms,
  parseSuspiciousRoiPct,
} from './matcher';

describe('buildKalshiArbShape', () => {
  const market = (overrides: Record<string, unknown> = {}) => ({
    ticker: 'KX-ASK-SIZE',
    yes_bid_dollars: '0.39',
    yes_ask_dollars: '0.41',
    no_bid_dollars: '0.57',
    no_ask_dollars: '0.59',
    last_price_dollars: '0.40',
    volume_24h_fp: '100',
    yes_bid_size_fp: '10',
    yes_ask_size_fp: '5',
    no_bid_size_fp: '10',
    no_ask_size_fp: '5',
    ...overrides,
  }) as unknown as Parameters<typeof buildKalshiArbShape>[0];

  it('preserves quoted ask prices when Kalshi omits ask-size fields', () => {
    const shape = buildKalshiArbShape(market({
      yes_ask_size_fp: undefined,
      no_ask_size_fp: null,
    }));

    expect(shape.yesAsk).toBe(0.41);
    expect(shape.noAsk).toBe(0.59);
  });

  it('keeps explicitly zero-sized asks non-executable', () => {
    const shape = buildKalshiArbShape(market({
      yes_ask_size_fp: 0,
      no_ask_size_fp: '0',
    }));

    expect(shape.yesAsk).toBe(0);
    expect(shape.noAsk).toBe(0);
  });
});

describe('buildPmArbShape fee authority', () => {
  it('preserves Gamma fee authority on the API/persistence arb shape', () => {
    const shape = buildPmArbShape({
      id: 'pm-politics', conditionId: '0xpolitics', question: 'Will the candidate win?',
      slug: 'candidate-win', outcomes: '["Yes","No"]', outcomePrices: '["0.70","0.30"]',
      clobTokenIds: '["yes-token","no-token"]', bestBid: 0.69, bestAsk: 0.70,
      active: true, closed: false, feesEnabled: true,
      feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
    });

    expect(shape).toMatchObject({
      feesEnabled: true,
      feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
    });
  });
});

describe('parseSuspiciousRoiPct', () => {
  it.each([undefined, '', '0', '-1', 'NaN', 'Infinity', '-Infinity', 'invalid'])
    ('falls back to 25 for unsafe threshold: %s', (value) => {
      expect(parseSuspiciousRoiPct(value)).toBe(25);
    });

  it('accepts a finite positive threshold', () => {
    expect(parseSuspiciousRoiPct('12.5')).toBe(12.5);
  });
});

describe('platform-neutral outcome model', () => {
  it('emits canonical platform data while preserving legacy fields during migration', () => {
    const normalized = normalizeOutcomePlatforms({
      artist: 'Example',
      kalshi: { ticker: 'KX-EXAMPLE', yesBid: 0.4, yesAsk: 0.42, noBid: 0.58, noAsk: 0.6, lastPrice: 0.41 },
      polymarket: { marketId: 'pm-example', conditionId: 'condition-example', yesPrice: 0.43, noPrice: 0.57, bestBid: 0.42, bestAsk: 0.43, lastTradePrice: 0.43 },
      arbitrage: { strategy: 'No arb', arbType: 'direct', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0, maxCapital: 0 },
      source: 'auto',
    });

    expect(normalized.kalshi?.ticker).toBe('KX-EXAMPLE');
    expect(normalized.polymarket?.conditionId).toBe('condition-example');
    expect(normalized.platforms).toEqual([
      expect.objectContaining({ platformId: 'kalshi', marketId: 'KX-EXAMPLE', outcomeId: 'KX-EXAMPLE', yesPrice: 0.42 }),
      expect.objectContaining({ platformId: 'polymarket', marketId: 'pm-example', outcomeId: 'condition-example', yesPrice: 0.43 }),
    ]);
  });
});
import { getClobAskDepths, getClobPrices } from './polymarket-clob';

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
    yesMinOrderSize: 1, noMinOrderSize: 1, yesTickSize: 0.01, noTickSize: 0.01,
    feesEnabled: true,
    feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.25 },
  };

  it('caps executable capital by known Kalshi and PM ask depth', () => {
    const r = calculateArbitrageMax(kalshi, pm, 5000, 0, 5000, 5000, 'Sports');
    expect(r.maxCapital).toBeGreaterThan(0);
    expect(r.maxCapital).toBeLessThanOrEqual(1000);
    expect(r.depthVerified).toBe(true);
  });

  it('shows a profitable quote but keeps it unexecutable when required depth is missing', () => {
    const r = calculateArbitrageMax(kalshi, pm, 5000, 0, 5000, 0, 'Sports');
    expect(r.strategy).toBe('Buy YES Kalshi + NO PM');
    expect(r.roiPct).toBeGreaterThan(0);
    expect(r.maxCapital).toBe(0);
    expect(r.kalshiStake).toBe(0);
    expect(r.pmStake).toBe(0);
    expect(r.depthVerified).toBe(false);
    expect(r.fees).toMatchObject({
      kalshiFee: expect.any(Number),
      pmFee: expect.any(Number),
      kalshiFeeDetails: expect.stringContaining('Kalshi'),
      pmFeeDetails: expect.stringContaining('Polymarket'),
    });
    expect(Number.isFinite(r.fees!.kalshiFee)).toBe(true);
    expect(Number.isFinite(r.fees!.pmFee)).toBe(true);
  });

  it('fails closed when an unknown PM ask depth is represented as Infinity', () => {
    const r = calculateArbitrageMax(kalshi, pm, 5000, 0, 5000, parseDepth('Infinity'), 'Sports');

    expect(r.strategy).toBe('Buy YES Kalshi + NO PM');
    expect(r.maxCapital).toBe(0);
    expect(r.expectedProfit).toBe(0);
    expect(r.depthVerified).toBe(false);
  });

  it('shows a profitable PM YES + Kalshi NO quote when its Kalshi NO depth is unavailable', () => {
    const r = calculateArbitrageMax(
      { ...kalshi, yesAsk: 0.65, noAsk: 0.40 },
      { ...pm, yesPrice: 0.56, bestAsk: 0.56, noPrice: 0.46 },
      80, 0, 5000, 5000,
      'Tech',
    );
    expect(r.strategy).toBe('Buy YES PM + NO Kalshi');
    expect(r.roiPct).toBeCloseTo(1.088, 3);
    expect(r.expectedProfit).toBe(0);
    expect(r.kalshiStake + r.pmStake).toBe(0);
    expect(r.depthVerified).toBe(false);
  });

  it('fails closed when an otherwise deep required ask price is zero', () => {
    const r = calculateArbitrageMax(
      { ...kalshi, yesAsk: 0 },
      pm,
      5_000,
      5_000,
      5_000,
      5_000,
    );

    expect(r.strategy).not.toBe('Buy YES Kalshi + NO PM');
    expect(r.kalshiStake).toBeGreaterThanOrEqual(0);
    expect(r.pmStake).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.roiPct)).toBe(true);
    expect(Number.isFinite(r.expectedProfit)).toBe(true);
  });

  it('returns no executable arb when all required depth is missing', () => {
    const r = calculateArbitrageMax(
      { ...kalshi, yesAsk: 0.60, noAsk: 0.45, yesAskDepth: '0', noAskDepth: '0' },
      { ...pm, bestAsk: 0.60, noPrice: 0.45, askDepth: 0 },
      0, 0, 0, 0
    );
    expect(r.strategy).toBe('No arb');
    expect(r.depthVerified).toBe(false);
  });

  it('keeps maxCapital at the canonical one-share quantity when depth is executable', () => {
    // Låg depth = låg capital
    const low = calculateArbitrageMax(kalshi, pm, 100, 0, 100, 100);
    const high = calculateArbitrageMax(kalshi, pm, 100_000, 0, 100_000, 100_000);
    expect(low.maxCapital).toBe(1);
    expect(high.maxCapital).toBe(1);
  });
});

describe('computeApy', () => {
  it('ger unavailable om expiryDate saknas', () => {
    expect(computeApy(10, null)).toBeNull();
    expect(computeApy(10, undefined)).toBeNull();
  });

  it('sammansatt annualisering: 10% på 30 dagar', () => {
    const expiry = new Date(Date.now() + 30 * 86400000).toISOString();
    expect(computeApy(10, expiry)).toBeCloseTo((1.1 ** (365 / 30) - 1) * 100, 0);
  });

  it('expired → 0', () => {
    expect(computeApy(50, '2020-01-01')).toBeNull();
  });

  it('en dag använder sammansatt APY utan Infinity', () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    expect(Number.isFinite(computeApy(10, tomorrow))).toBe(true);
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

  it('rejects non-finite and non-positive depth as non-executable', () => {
    expect(parseDepth('Infinity')).toBe(0);
    expect(parseDepth(Infinity)).toBe(0);
    expect(parseDepth(-1)).toBe(0);
  });

  it('fails closed on malformed depth strings with a numeric prefix', () => {
    expect(parseDepth('500 contracts')).toBe(0);
    expect(parseDepth('1K stale')).toBe(0);
    expect(parseDepth('1.5M?')).toBe(0);
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
  it(' YES/NO från tokens', async () => {
    const r = await getClobPrices({
      condition_id: 'c1',
      tokens: [
        { token_id: 't1', outcome: 'Yes', price: 0.55 },
        { token_id: 't2', outcome: 'No', price: 0.45 },
      ],
      best_bid: 0.54, best_ask: 0.56, last_trade_price: 0.55,
    } as any);
    expect(r?.yesPrice).toBe(0.56); // YES best_ask
    expect(r?.noPrice).toBeCloseTo(0.46, 6);   // 1 - best_bid
  });

  it('fallback till best_bid/best_ask om token saknar price', async () => {
    const r = await getClobPrices({
      condition_id: 'c1',
      tokens: [
        { token_id: 't1', outcome: 'Yes' },
        { token_id: 't2', outcome: 'No' },
      ],
      best_bid: 0.54, best_ask: 0.56, last_trade_price: 0.55,
    } as any);
    expect(r?.yesPrice).toBe(0.56); // YES best_ask
    expect(r?.noPrice).toBeCloseTo(0.46, 6);   // NO ask derived from 1 - YES best_bid
  });

  it('fails closed instead of clamping malformed aggregate CLOB quotes', async () => {
    const r = await getClobPrices({
      condition_id: 'c-malformed',
      tokens: [],
      best_bid: Number.NaN,
      best_ask: Number.POSITIVE_INFINITY,
    } as any);

    expect(r).toBeNull();
  });

  it('deriverar noPrice från yesPrice (1 - yes)', async () => {
    const r = await getClobPrices({
      condition_id: 'c1',
      tokens: [
        { token_id: 't1', outcome: 'Yes', price: 0.60 },
        { token_id: 't2', outcome: 'No' },
      ],
      best_bid: 0.59, best_ask: 0.61,
    } as any);
    expect(r?.noPrice).toBeCloseTo(0.41, 2);
  });

  it('falls back to token orderbooks when a standard market omits aggregate best bid/ask', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes('token_id=yes-token')) {
        return { ok: true, json: async () => ({ asks: [{ price: '0.83', size: '5' }], bids: [{ price: '0.29', size: '90' }] }) };
      }
      if (url.includes('token_id=no-token')) {
        return { ok: true, json: async () => ({ asks: [{ price: '0.71', size: '90' }], bids: [{ price: '0.17', size: '5' }] }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', mockFetch);

    try {
      const r = await getClobPrices({
        condition_id: 'c-token-fallback',
        tokens: [
          { token_id: 'yes-token', outcome: 'Yes' },
          { token_id: 'no-token', outcome: 'No' },
        ],
        best_bid: null,
        best_ask: null,
      } as any);

      expect(r).toMatchObject({ yesPrice: 0.83, noPrice: 0.71, bestBid: 0.29, bestAsk: 0.83 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed when token-book prices are malformed rather than parsing prefixes', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        asks: [{ price: '0.20junk', size: '5' }, { price: 'Infinity', size: '2' }],
        bids: [{ price: '0.10junk', size: '5' }],
      }),
    }));
    vi.stubGlobal('fetch', mockFetch);

    try {
      const r = await getClobPrices({
        condition_id: 'c-malformed-token-book',
        tokens: [
          { token_id: 'yes-malformed', outcome: 'Yes' },
          { token_id: 'no-malformed', outcome: 'No' },
        ],
      } as any);

      expect(r).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not treat a neg-risk token midpoint as an executable NO ask', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes('token_id=yes-neg-risk')) {
        return { ok: true, json: async () => ({ asks: [{ price: '0.21', size: '10' }], bids: [] }) };
      }
      if (url.includes('token_id=no-neg-risk')) {
        return { ok: true, json: async () => ({ asks: [], bids: [{ price: '0.79', size: '10' }] }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', mockFetch);

    try {
      const r = await getClobPrices({
        condition_id: 'c-neg-risk-no-ask',
        neg_risk: true,
        tokens: [
          { token_id: 'yes-neg-risk', outcome: 'Yes', price: 0.21 },
          { token_id: 'no-neg-risk', outcome: 'No', price: 0.895 },
        ],
      } as any);

      expect(r).toMatchObject({ yesPrice: 0.21, noPrice: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returnerar null vid total avsaknad av data', async () => {
    const r = await getClobPrices({
      condition_id: 'c1',
      tokens: [],
    } as any);
    expect(r).toBeNull();
  });
});

describe('getClobAskDepths', () => {
  it('uses only quantity at each token best ask and returns dollar depth', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes('token_id=yes-depth')) {
        return { ok: true, json: async () => ({ asks: [{ price: '0.42', size: '10' }, { price: '0.42', size: '5' }, { price: '0.43', size: '100' }], bids: [] }) };
      }
      if (url.includes('token_id=no-depth')) {
        return { ok: true, json: async () => ({ asks: [{ price: '0.57', size: '8' }, { price: '0.61', size: '500' }], bids: [] }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', mockFetch);
    try {
      const depth = await getClobAskDepths({
        condition_id: 'c-depth',
        tokens: [{ token_id: 'yes-depth', outcome: 'Yes' }, { token_id: 'no-depth', outcome: 'No' }],
      } as any);
      expect(depth.yesAskDepth).toBeCloseTo(6.3, 8);
      expect(depth.noAskDepth).toBeCloseTo(4.56, 8);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed when a token is unavailable', async () => {
    const depth = await getClobAskDepths({ condition_id: 'c-missing', tokens: [] } as any);
    expect(depth).toMatchObject({ yesAskDepth: 0, noAskDepth: 0 });
  });

  it('rejects malformed, above-par, and non-decimal ask levels', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        asks: [
          { price: '0x0f', size: '2' },
          { price: '1', size: '4' },
          { price: '0.42junk', size: '8' },
        ],
        bids: [],
      }),
    }));
    vi.stubGlobal('fetch', mockFetch);
    try {
      const depth = await getClobAskDepths({
        condition_id: 'c-invalid-depth',
        tokens: [{ token_id: 'yes-invalid-depth', outcome: 'Yes' }, { token_id: 'no-invalid-depth', outcome: 'No' }],
      } as any);
      expect(depth).toMatchObject({ yesAskDepth: 0, noAskDepth: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('downgrades all PM name-collision diagnostics to debug', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      matchOutcomes([], [
        { id: 'pm-binary-1', conditionId: 'c-binary-1', question: 'Alpha?', outcomes: '["Yes","No"]', outcomePrices: '["0.50","0.50"]', active: true, closed: false, slug: 'alpha-1' },
        { id: 'pm-binary-2', conditionId: 'c-binary-2', question: 'Alpha!', outcomes: '["Yes","No"]', outcomePrices: '["0.50","0.50"]', active: true, closed: false, slug: 'alpha-2' },
        { id: 'pm-multi-1', conditionId: 'c-multi-1', question: 'Event One', outcomes: '["Beta"]', outcomePrices: '["0.50"]', active: true, closed: false, slug: 'beta-1' },
        { id: 'pm-multi-2', conditionId: 'c-multi-2', question: 'Event Two', outcomes: '["Beta!"]', outcomePrices: '["0.50"]', active: true, closed: false, slug: 'beta-2' },
      ] as any, 'Collision test');

      expect(warn).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
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
    clobTokenIds: '["yes-token","no-token"]',
    ...overrides,
  };
}

describe('buildPmArbShape — CLOB-empty regression guard (BUG-086b)', () => {
  it('verifies binary settlement only with exact distinct aligned token identifiers', () => {
    expect(buildPmArbShape(makePmMarket()).binaryVerified).toBe(true);
    expect(buildPmArbShape(makePmMarket({ clobTokenIds: undefined })).binaryVerified).toBe(false);
    expect(buildPmArbShape(makePmMarket({ clobTokenIds: '["same","same"]' })).binaryVerified).toBe(false);
    expect(buildPmArbShape(makePmMarket({ clobTokenIds: '["yes"]' })).binaryVerified).toBe(false);
    expect(buildPmArbShape(makePmMarket({ outcomes: '["A","B","C"]', clobTokenIds: '["a","b","c"]' })).binaryVerified).toBe(false);
    expect(buildPmArbShape(makePmMarket({ negRisk: true })).binaryVerified).toBe(false);
  });

  it('zeros all executable prices when a reachable CLOB has no asks, regardless of Gamma values', () => {
    const shape = buildPmArbShape(makePmMarket({
      clobEmpty: true,
      bestBid: 0.58,
      bestAsk: 0.60,
      outcomePrices: '["0.60","0.40"]',
    }));
    expect(shape.yesPrice).toBe(0.60);
    expect(shape.noPrice).toBe(0.40);
    expect(shape.bestBid).toBe(0);
    expect(shape.bestAsk).toBe(0);
    expect(shape.askDepth).toBe(0);
    expect(shape.isExecutable).toBe(false);
  });

  it('uses CLOB ask depth and never substitutes Gamma liquidity', () => {
    const shape = buildPmArbShape(makePmMarket({
      bestBid: 0.49,
      bestAsk: 0.51,
      liquidityNum: 999_999,
      askDepth: 12.75,
      noAskDepth: 8.5,
    }));
    expect(shape.askDepth).toBe(12.75);
    expect(shape.noAskDepth).toBe(8.5);
  });

  it('fails closed when CLOB depth is unavailable despite Gamma liquidity', () => {
    const shape = buildPmArbShape(makePmMarket({ liquidityNum: 999_999 }));
    expect(shape.askDepth).toBe(0);
    expect(shape.noAskDepth).toBe(0);
  });
});

describe('buildPmArbShape — null coercion regression (GEN-1)', () => {
  // --- Core null-coercion bug: 1 - null = 1 in JS ---
  describe('null bestBid/bestAsk handling', () => {
    it('both null → uses Gamma only when CLOB availability is unknown', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: null as unknown as number,
        bestAsk: null as unknown as number,
        outcomePrices: '[\"0.42\",\"0.58\"]',
      }));
      // A missing CLOB result is different from a reachable-but-empty CLOB.
      // The latter sets clobEmpty and is covered by BUG-086b above.
      expect(shape.yesPrice).toBe(0.42);
      expect(shape.noPrice).toBe(0.58);
      expect(shape.noPrice).not.toBe(1);
    });

    it('only bestBid null → derives from bestAsk', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: null as unknown as number,
        bestAsk: 0.55,
      }));
      expect(shape.yesPrice).toBe(0.55);
      expect(shape.noPrice).toBeCloseTo(0.45, 6); // 1 - 0.55
      expect(shape.noPrice).not.toBe(1); // regression: must not be 1
    });

    it('only bestAsk null → derives from bestBid', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: 0.48,
        bestAsk: null as unknown as number,
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

    it('undefined bestBid/bestAsk → uses Gamma only when CLOB availability is unknown', () => {
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
    it('fails closed for malformed Gamma best quotes instead of treating them as live orderbook data', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: '0x0.49',
        bestAsk: '0.51junk',
        lastTradePrice: 'Infinity',
        outcomePrices: '["0.42","0.58"]',
      }));

      expect(shape.yesPrice).toBe(0.42);
      expect(shape.noPrice).toBe(0.58);
      expect(shape.bestAsk).toBe(0.42);
      expect(shape.bestBid).toBeCloseTo(0.4116, 6);
      expect(shape.lastTradePrice).toBe(0);
    });

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
      expect(shape.yesPrice).toBe(0);
      expect(shape.noPrice).toBe(1);
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
      expect(shape.bestBid).toBeCloseTo(0.49, 6); // derived 2% below Gamma fallback price
      expect(shape.bestAsk).toBe(0.5);
    });
  });

  // --- Original bug reproduction ---
  describe('original bug: 1 - null = 1', () => {
    it('BUG REPRODUCTION: without !=null check, noPrice would be 1', () => {
      // Simulate what the OLD buggy code would do:
      // Old code: noPrice = 1 - bestBid (without null check)
      // 1 - null = 1 in JS
      const oldStyleNoPrice = 1 - (null as unknown as number); // = 1
      expect(oldStyleNoPrice).toBe(1);

      // Our fix ensures this never happens
      const shape = buildPmArbShape(makePmMarket({
        bestBid: null as unknown as number,
        bestAsk: null as unknown as number,
        outcomePrices: '[\"0.42\",\"0.58\"]',
      }));
      expect(shape.noPrice).toBe(0.58);
      expect(shape.noPrice).not.toBe(1); // THE FIX
    });

    it('bestBid null with valid bestAsk → noPrice derived from bestAsk, not null', () => {
      const shape = buildPmArbShape(makePmMarket({
        bestBid: null as unknown as number,
        bestAsk: 0.60,
      }));
      // Old bug: would compute noPrice = 1 - null = 1
      // Fixed: noPrice = 1 - bestAsk = 0.40
      expect(shape.noPrice).toBeCloseTo(0.40, 6);
      expect(shape.noPrice).not.toBe(1);
    });
  });
});

// =====================================================================
// Cross-outcome arbitrage (red method) for strict binary markets
// =====================================================================

function makeOutcome(overrides: Partial<any> = {}): any {
  return {
    artist: 'Republican',
    source: 'auto',
    kalshi: {
      ticker: 'KXREP',
      yesBid: 0.85, yesAsk: 0.87,
      noBid: 0.15, noAsk: 0.17,
      lastPrice: 0.86,
      volume24h: '', yesBidDepth: '$10K', yesAskDepth: '$5K', noBidDepth: '$2K', noAskDepth: '$3K',
    },
    polymarket: {
      marketId: 'pm-rep', conditionId: 'c-rep',
      yesPrice: 0.80, noPrice: 0.20,
      bestBid: 0.79, bestAsk: 0.81,
      lastTradePrice: 0.80,
      volume: '', liquidity: '', askDepth: 5000, noAskDepth: 1000,
      yesMinOrderSize: 1, noMinOrderSize: 1, yesTickSize: 0.01, noTickSize: 0.01,
      feesEnabled: true,
      feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
    },
    arbitrage: { strategy: 'No arb', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0 },
    ...overrides,
  };
}

describe('calculateBestArbitrageForOutcome — cross-outcome', () => {
  it('emits Internal only as same-market YES+NO with executable depth and both-leg fees', () => {
    const base = makeOutcome();
    const current = makeOutcome({
      artist: 'Binary proposition',
      kalshi: {
        ...base.kalshi,
        ticker: 'KX-BINARY',
        yesAsk: 0.30,
        noAsk: 0.30,
        yesAskDepth: '300',
        noAskDepth: '300',
      },
      polymarket: {
        ...base.polymarket,
        bestAsk: 0.70,
        yesPrice: 0.70,
        noPrice: 0.70,
        askDepth: 700,
        noAskDepth: 700,
        binaryVerified: true,
      },
    });

    const result = calculateBestArbitrageForOutcome(current, null, 'politics', 100);

    expect(result.arbType).toBe('internal');
    expect(result.strategy).toBe('Same-platform YES+NO Kalshi: Binary proposition');
    expect(result.buyPlatform).toBe('kalshi');
    expect(result.sellPlatform).toBe('kalshi');
    expect(result.buyPrice).toBe(0.30);
    expect(result.sellPrice).toBe(0.30);
    expect(result.depthVerified).toBe(true);
    expect(result.fees?.kalshiFee).toBeGreaterThan(0);
    expect(result.expectedProfit).toBeGreaterThan(0);
  });

  it('rejects Polymarket Internal for neg-risk, non-binary, and unverified outcome structures', () => {
    const base = makeOutcome();
    for (const polymarket of [
      { ...base.polymarket, bestAsk: 0.30, noPrice: 0.30, binaryVerified: false },
      { ...base.polymarket, bestAsk: 0.30, noPrice: 0.30, binaryVerified: true, negRisk: true },
      { ...base.polymarket, bestAsk: 0.30, noPrice: 0.30, binaryVerified: undefined },
    ]) {
      const current = makeOutcome({
        kalshi: { ...base.kalshi, yesAsk: 0.70, noAsk: 0.70 },
        polymarket,
      });
      const result = calculateBestArbitrageForOutcome(current, null, 'politics', 100);
      expect(result.arbType).not.toBe('internal');
    }
  });

  it('requires positive executable depth on both Internal legs', () => {
    const base = makeOutcome();
    for (const [yesAskDepth, noAskDepth] of [['0', '100'], ['100', '0']]) {
      const current = makeOutcome({
        kalshi: { ...base.kalshi, yesAsk: 0.30, noAsk: 0.30, yesAskDepth, noAskDepth },
        polymarket: { ...base.polymarket, bestAsk: 0.70, noPrice: 0.70 },
      });
      const result = calculateBestArbitrageForOutcome(current, null, 'politics', 100);
      expect(result.arbType).not.toBe('internal');
    }
  });

  it('requires positive profit after fees on both Internal legs', () => {
    const base = makeOutcome();
    const current = makeOutcome({
      kalshi: { ...base.kalshi, yesAsk: 0.499, noAsk: 0.499, yesAskDepth: '100', noAskDepth: '100' },
      polymarket: { ...base.polymarket, bestAsk: 0.70, noPrice: 0.70 },
    });
    const result = calculateBestArbitrageForOutcome(current, null, 'politics', 100);
    expect(result.arbType).not.toBe('internal');
  });

  it('never emits legacy same-market YES+YES as Internal', () => {
    const base = makeOutcome();
    const current = makeOutcome({
      artist: 'First',
      kalshi: { ...base.kalshi, ticker: 'KX-FIRST', yesAsk: 0.20, noAsk: 0.90 },
      polymarket: { ...base.polymarket, conditionId: 'pm-first', bestAsk: 0.20, noPrice: 0.90 },
    });
    const complement = makeOutcome({
      artist: 'Second',
      kalshi: { ...base.kalshi, ticker: 'KX-SECOND', yesAsk: 0.20, noAsk: 0.90 },
      polymarket: { ...base.polymarket, conditionId: 'pm-second', bestAsk: 0.20, noPrice: 0.90 },
    });

    const result = calculateBestArbitrageForOutcome(current, complement, 'politics', 100);

    expect(result.strategy).not.toMatch(/^Same-platform YES\+YES/);
    if (result.arbType === 'internal') expect(result.strategy).toMatch(/^Same-platform YES\+NO/);
  });

  it('rejects cross-outcome self-pairing and duplicated platform identifiers', () => {
    const current = makeOutcome({
      artist: 'Same',
      kalshi: { ...makeOutcome().kalshi, ticker: 'KX-SAME', yesAsk: 0.20, noAsk: 0.90 },
      polymarket: { ...makeOutcome().polymarket, conditionId: 'pm-same', bestAsk: 0.20, noPrice: 0.90 },
    });
    const duplicate = makeOutcome({
      artist: 'Same',
      kalshi: { ...current.kalshi },
      polymarket: { ...current.polymarket },
    });

    const result = calculateBestArbitrageForOutcome(current, duplicate, 'politics', 100);

    expect(result.arbType).not.toBe('cross');
  });

  it('within-outcome gul A wins when cross-outcome is worse', () => {
    const current = makeOutcome();
    // PM NO = 0.20, Kalshi YES = 0.87 → gul A cost 1.07 (no arb)
    // PM YES = 0.81, Kalshi NO = 0.17 → gul B cost 0.98 → 2% gross arb
    const complement = makeOutcome({
      artist: 'Democratic',
      kalshi: { ...current.kalshi, ticker: 'KXDEM', yesAsk: 0.13, noAsk: 0.89, yesBid: 0.12, noBid: 0.88 },
      polymarket: { ...current.polymarket, marketId: 'pm-dem', conditionId: 'c-dem', bestAsk: 0.18, yesPrice: 0.18, noPrice: 0.86 },
    });
    const r = calculateBestArbitrageForOutcome(current, complement, 'politics');
    expect(r.strategy).toBe('Buy YES PM + NO Kalshi');
    expect(r.expectedProfit).toBeGreaterThan(0);
  });

  it('cross-outcome YES+YES wins when it beats within-outcome arbs', () => {
    // Both yellow arbs are unprofitable (>1 cost), but cross-outcome is cheap.
    // current: K YES 0.30 + PM NO 0.72 = 1.02 → no yellow A
    // current: PM YES 0.30 + K NO 0.72 = 1.02 → no yellow B
    // cross: K YES current 0.30 + PM YES complement 0.30 = 0.60 → gross ROI 40%
    const base = makeOutcome();
    const current = makeOutcome({
      kalshi: { ...base.kalshi, yesAsk: 0.30, noAsk: 0.72, yesBid: 0.28, noBid: 0.70 },
      polymarket: { ...base.polymarket, bestAsk: 0.30, yesPrice: 0.30, noPrice: 0.72, bestBid: 0.28 },
    });
    const complement = makeOutcome({
      artist: 'Democratic',
      kalshi: { ...base.kalshi, ticker: 'KXDEM', yesAsk: 0.30, noAsk: 0.72 },
      polymarket: { ...base.polymarket, marketId: 'pm-dem', conditionId: 'c-dem', bestAsk: 0.30, yesPrice: 0.30, noPrice: 0.72, bestBid: 0.28 },
    });
    const r = calculateBestArbitrageForOutcome(current, complement, 'politics', 1000, true);
    expect(r.strategy).toContain('both sides');
    expect(r.expectedProfit).toBeGreaterThan(0);
  });

  it('does not mark cross or same-platform opportunities executable with unknown depth', () => {
    const base = makeOutcome();
    const current = makeOutcome({
      kalshi: { ...base.kalshi, yesAsk: 0.30, noAsk: 0.72, yesAskDepth: '0', noAskDepth: '0' },
      polymarket: { ...base.polymarket, bestAsk: 0.30, yesPrice: 0.30, noPrice: 0.72, askDepth: 0, noAskDepth: 0 },
    });
    const complement = makeOutcome({
      artist: 'Democratic',
      kalshi: { ...base.kalshi, ticker: 'KXDEM', yesAsk: 0.30, noAsk: 0.72, yesAskDepth: '0', noAskDepth: '0' },
      polymarket: { ...base.polymarket, marketId: 'pm-dem', conditionId: 'c-dem', bestAsk: 0.30, yesPrice: 0.30, noPrice: 0.72, askDepth: 0, noAskDepth: 0 },
    });
    const r = calculateBestArbitrageForOutcome(current, complement, 'politics');
    expect(r.strategy).toBe('No arb');
    expect(r.maxCapital).toBe(0);
    expect(r.depthVerified).toBe(false);
  });

  it('fails closed when a raw non-finite PM depth reaches the orchestration layer', () => {
    const base = makeOutcome();
    const current = makeOutcome({
      kalshi: { ...base.kalshi, yesAsk: 0.30, noAsk: 0.72 },
      polymarket: { ...base.polymarket, bestAsk: 0.30, yesPrice: 0.30, noPrice: 0.72, askDepth: Infinity, noAskDepth: Infinity },
    });

    const r = calculateBestArbitrageForOutcome(current, null, 'politics');

    expect(r.maxCapital).toBe(0);
    expect(r.expectedProfit).toBe(0);
    expect(r.depthVerified).toBe(false);
  });

  it('uses normalized complementary PM ask depth for cross-outcome sizing', () => {
    const base = makeOutcome();
    const current = makeOutcome({
      kalshi: { ...base.kalshi, yesAsk: 0.30, noAsk: 0.72, yesAskDepth: '5000' },
      polymarket: { ...base.polymarket, bestAsk: 0.72, yesPrice: 0.72, noPrice: 0.72, askDepth: 5000, noAskDepth: 5000 },
    });
    const complement = makeOutcome({
      artist: 'Democratic',
      kalshi: { ...base.kalshi, ticker: 'KXDEM', yesAsk: 0.90, noAsk: 0.72, yesAskDepth: '5000' },
      // Runtime upstream payloads can still contain a valid compact depth string.
      polymarket: { ...base.polymarket, marketId: 'pm-dem', conditionId: 'c-dem', bestAsk: 0.30, yesPrice: 0.30, noPrice: 0.72, askDepth: '5K' as unknown as number, noAskDepth: 5000 },
    });

    const r = calculateBestArbitrageForOutcome(current, complement, 'politics', 1000, true);

    expect(r.strategy).toContain('both sides');
    expect(r.maxCapital).toBeGreaterThan(0);
    expect(r.depthVerified).toBe(true);
  });

  it('cross-outcome not considered without complement', () => {
    const current = makeOutcome();
    const r = calculateBestArbitrageForOutcome(current, null, 'politics');
    expect(r.strategy).not.toContain('both sides');
  });

  it('cross-outcome not created when combined YES cost is >= 1', () => {
    // No yellow arb and cross would cost exactly $1 → no edge at all.
    const base = makeOutcome();
    const current = makeOutcome({
      kalshi: { ...base.kalshi, yesAsk: 0.50, noAsk: 0.52 },
      polymarket: { ...base.polymarket, bestAsk: 0.50, yesPrice: 0.50, noPrice: 0.52, bestBid: 0.48 },
    });
    const complement = makeOutcome({
      artist: 'Democratic',
      kalshi: { ...base.kalshi, ticker: 'KXDEM', yesAsk: 0.50, noAsk: 0.52 },
      polymarket: { ...base.polymarket, marketId: 'pm-dem', conditionId: 'c-dem', bestAsk: 0.50, yesPrice: 0.50, noPrice: 0.52, bestBid: 0.48 },
    });
    const r = calculateBestArbitrageForOutcome(current, complement, 'politics');
    expect(r.strategy).not.toContain('both sides');
    // UI-03: Returns strategy with negative ROI instead of 'No arb'
    expect(r.strategy).not.toBe('No arb');
  });
});

describe('calculateAllArbitrages — cross-outcome guard', () => {
  it('does NOT create cross-outcome arbs when market has more than two outcomes', () => {
    // Two matched outcomes (like Saudi + North Korea) plus many Kalshi-only outcomes.
    const matchedA = makeOutcome({ artist: 'Saudi Arabia' });
    const matchedB = makeOutcome({
      artist: 'North Korea',
      kalshi: { ...matchedA.kalshi, ticker: 'KXNK', yesAsk: 0.06, noAsk: 0.95 },
      polymarket: { ...matchedA.polymarket, marketId: 'pm-nk', conditionId: 'c-nk', bestAsk: 0.19, yesPrice: 0.19, noPrice: 0.89 },
    });
    const extra = Array.from({ length: 5 }, (_, i) => ({
      artist: `Extra ${i}`,
      source: 'kalshi',
      kalshi: matchedA.kalshi,
      polymarket: null,
      arbitrage: { strategy: 'No arb', kalshiStake: 0, pmStake: 0, expectedProfit: 0, roiPct: 0, buyPlatform: null, buyPrice: 0, sellPlatform: null, sellPrice: 0 },
    }));

    const outcomes = [matchedA, matchedB, ...extra];
    const result = calculateAllArbitrages(outcomes, 'politics');
    const strategies = result.map(o => o.arbitrage.strategy);
    expect(strategies.some(s => s.includes('both sides'))).toBe(false);
  });

  it('allows cross-outcome arbs for strictly binary markets (exactly two outcomes)', () => {
    const base = makeOutcome();
    const current = makeOutcome({
      kalshi: { ...base.kalshi, yesAsk: 0.30, noAsk: 0.72, yesBid: 0.28, noBid: 0.70 },
      polymarket: { ...base.polymarket, bestAsk: 0.30, yesPrice: 0.30, noPrice: 0.72, bestBid: 0.28 },
    });
    const complement = makeOutcome({
      artist: 'Democratic',
      kalshi: { ...base.kalshi, ticker: 'KXDEM', yesAsk: 0.30, noAsk: 0.72 },
      polymarket: { ...base.polymarket, marketId: 'pm-dem', conditionId: 'c-dem', bestAsk: 0.30, yesPrice: 0.30, noPrice: 0.72, bestBid: 0.28 },
    });
    const result = calculateAllArbitrages([current, complement], 'politics', 1000, {
      mutuallyExclusive: true,
      exhaustive: true,
    });
    const cross = result.find(o => o.arbitrage.strategy.includes('both sides'));
    expect(cross).toBeDefined();
  });
});
