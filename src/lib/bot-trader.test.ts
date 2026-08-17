import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateBotTrade,
  buildExecutionRequest,
  revalidateBotTradeEconomics,
  unifiedOutcomeToBotInput,
  getAuthoritativeMatchedFill,
  getBotTradePublication,
  type BotSettings,
  type BotTradeInput,
} from './bot-trader';
import type { UnifiedOutcome } from './matcher';
import type { BotScanCandidate, PersistedBotScan } from './bot-scan-consumer';
import { walkExecutableBook } from './executable-book';
import { orderbookState } from './orderbook-state';
import type { PropositionRelationship } from './proposition-identity';

vi.mock('./proposition-registry', () => ({
  resolveCanonicalPropositionRelationship: (relationship: PropositionRelationship | null | undefined) => relationship ?? null,
  findCanonicalPropositionRelationship: () => null,
}));

const TEST_PM_CONDITION_ID = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEST_PM_NO_TOKEN_ID = '38424385756462253442221613485727105608987714090195314133724025202573806948368';

function verifiedRelationship(pmSide: 'yes' | 'no' = 'no'): PropositionRelationship {
  const states = ['team a', 'not team a'];
  return {
    schemaVersion: 1,
    state: 'verified_complementary',
    verificationSource: 'authoritative_platform_metadata',
    verifiedAt: new Date().toISOString(),
    parentEventId: 'event-1',
    resolutionRuleId: 'event-1-rules-v1',
    exhaustivePayoutStates: states,
    humanLabel: 'Kalshi Team A ↔ Polymarket opposite payout',
    legs: {
      kalshi: {
        platform: 'kalshi', platformMarketId: 'KXTEST-A', parentEventId: 'event-1',
        selectedOutcome: 'team a', contractSide: 'yes', payoutState: 'team a',
        eventPayoutStates: states, resolutionRuleId: 'event-1-rules-v1',
        humanLabel: 'Kalshi YES — Team A', marketQuestion: 'Will Team A win?', tokenId: null,
      },
      polymarket: {
        platform: 'polymarket', platformMarketId: TEST_PM_CONDITION_ID, parentEventId: 'event-1',
        selectedOutcome: pmSide === 'yes' ? 'not team a' : 'team a', contractSide: pmSide,
        payoutState: 'not team a', eventPayoutStates: states, resolutionRuleId: 'event-1-rules-v1',
        humanLabel: `Polymarket ${pmSide.toUpperCase()} — opposite payout`,
        marketQuestion: pmSide === 'yes' ? 'Will someone other than Team A win?' : 'Will Team A win?',
        tokenId: pmSide === 'yes' ? 'yes-token' : TEST_PM_NO_TOKEN_ID,
      },
    },
  };
}

vi.mock('./bot-action-log', () => ({
  appendBotActionLog: vi.fn(async () => 1),
}));
vi.mock('./bot-trader-messages', () => ({
  createBotMessage: vi.fn(async () => 1),
  updateBotMessage: vi.fn(async () => undefined),
}));

describe('getAuthoritativeMatchedFill', () => {
  it('uses venue-reported matched contracts and fill prices, including matched partial fills', () => {
    expect(getAuthoritativeMatchedFill({
      kalshiResult: { filledContracts: 2, filledPrice: 0.451 },
      polymarketResult: { filledContracts: 2, filledPrice: 0.497 },
    })).toEqual({ kalshiContracts: 2, pmContracts: 2, kalshiPrice: 0.451, pmPrice: 0.497 });
  });

  it('refuses to invent a position from mismatched, zero, or missing venue fills', () => {
    expect(getAuthoritativeMatchedFill({
      kalshiResult: { filledContracts: 2, filledPrice: 0.45 },
      polymarketResult: { filledContracts: 1, filledPrice: 0.50 },
    })).toBeNull();
    expect(getAuthoritativeMatchedFill({
      kalshiResult: { filledContracts: 0, filledPrice: 0.45 },
      polymarketResult: { filledContracts: 0, filledPrice: 0.50 },
    })).toBeNull();
  });
});

function baseSettings(overrides?: Partial<BotSettings>): BotSettings {
  return {
    enabled: true,
    mode: 'paper',
    selectionMethod: 'hybrid',
    minRoiPct: 2.0,
    minApyPct: 0,
    minDepthUsd: 0.5,
    minSharesPerLeg: 1,
    maxExpiryDays: 365,
    maxTradesPerDay: 10,
    ...overrides,
  };
}

function makeInput(overrides?: Partial<BotTradeInput>): BotTradeInput {
  const farFuture = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const depthTimestamp = new Date().toISOString();
  const input: BotTradeInput = {
    pairId: 'pair-1',
    marketTitle: 'Test Market',
    outcome: 'Team A',
    strategy: 'Buy YES Kalshi + NO PM',
    roiPct: 3.0,
    apyPct: 0,
    expectedProfit: 1.5,
    kalshiStake: 45,
    pmStake: 50,
    kalshiTicker: 'KXTEST-A',
    pmConditionId: TEST_PM_CONDITION_ID,
    pmYesTokenId: 'yes-token',
    pmNoTokenId: TEST_PM_NO_TOKEN_ID,
    kalshiYesAsk: 0.45,
    kalshiNoAsk: 0.58,
    pmYesAsk: 0.55,
    pmNoAsk: 0.52,
    kalshiYesDepth: 50,
    kalshiNoDepth: 60,
    pmYesDepth: 60,
    pmNoDepth: 55,
    pmYesMinOrderSize: 1,
    pmNoMinOrderSize: 1,
    pmYesTickSize: 0.01,
    pmNoTickSize: 0.01,
    expiryDate: farFuture,
    category: 'Politics',
    propositionRelationship: verifiedRelationship(),
    ...overrides,
  };
  const quote = (price: number | null | undefined, depth: number | undefined) => {
    if (price == null || price <= 0 || depth == null || depth <= 0) return undefined;
    return walkExecutableBook({
      side: 'buy',
      levels: [{ priceCents: Math.round(price * 100), quantityMicros: Math.floor(depth / price * 1_000_000) }],
      requestedQuantityMicros: 1_000_000,
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp,
    });
  };
  const result = {
    ...input,
    kalshiYesExecutableQuote: overrides?.kalshiYesExecutableQuote ?? quote(input.kalshiYesAsk, input.kalshiYesDepth),
    kalshiNoExecutableQuote: overrides?.kalshiNoExecutableQuote ?? quote(input.kalshiNoAsk, input.kalshiNoDepth),
    pmYesExecutableQuote: overrides?.pmYesExecutableQuote ?? quote(input.pmYesAsk, input.pmYesDepth),
    pmNoExecutableQuote: overrides?.pmNoExecutableQuote ?? quote(input.pmNoAsk, input.pmNoDepth),
  };
  const quantity = (price: number | null | undefined, depth: number | undefined) =>
    price != null && price > 0 && depth != null && depth > 0
      ? Math.floor(depth / price * 1_000_000) / 1_000_000
      : 0;
  orderbookState.removeBook(input.kalshiTicker!);
  orderbookState.setBook(input.kalshiTicker!, [
    { price: input.kalshiYesAsk!, quantity: quantity(input.kalshiYesAsk, input.kalshiYesDepth) },
  ], [
    { price: input.kalshiNoAsk!, quantity: quantity(input.kalshiNoAsk, input.kalshiNoDepth) },
  ], 0, { tickSizeCents: 1, minimumOrderQuantityMicros: 1_000_000, depthTimestamp });
  const pmYesId = input.pmYesTokenId ?? input.pmConditionId!;
  const pmNoId = input.pmNoTokenId ?? input.pmConditionId!;
  orderbookState.removeBook(pmYesId);
  if (pmNoId !== pmYesId) orderbookState.removeBook(pmNoId);
  orderbookState.setBook(pmYesId, [
    { price: input.pmYesAsk!, quantity: quantity(input.pmYesAsk, input.pmYesDepth) },
  ], pmYesId === pmNoId ? [
    { price: input.pmNoAsk!, quantity: quantity(input.pmNoAsk, input.pmNoDepth) },
  ] : [], 0, { tickSizeCents: 1, minimumOrderQuantityMicros: 1_000_000, depthTimestamp });
  if (pmNoId !== pmYesId) {
    orderbookState.setBook(pmNoId, [], [
      { price: input.pmNoAsk!, quantity: quantity(input.pmNoAsk, input.pmNoDepth) },
    ], 0, { tickSizeCents: 1, minimumOrderQuantityMicros: 1_000_000, depthTimestamp });
  }
  // The fee-authority test fixture resolves the selected executable PM token
  // to this ID before building the final order request.
  orderbookState.removeBook(TEST_PM_NO_TOKEN_ID);
  orderbookState.setBook(TEST_PM_NO_TOKEN_ID, [], [
    { price: input.pmNoAsk!, quantity: quantity(input.pmNoAsk, input.pmNoDepth) },
  ], 0, { tickSizeCents: 1, minimumOrderQuantityMicros: 1_000_000, depthTimestamp });
  return result;
}

describe('buildExecutionRequest Polymarket identity', () => {
  it('places the selected NO leg with its executable token', () => {
    const request = buildExecutionRequest(makeInput({
      pmConditionId: TEST_PM_CONDITION_ID,
      pmYesTokenId: 'yes-token',
      pmNoTokenId: TEST_PM_NO_TOKEN_ID,
      strategy: 'Buy YES Kalshi + NO PM',
    }));

    expect(request?.pmConditionId).toBe(TEST_PM_CONDITION_ID);
    expect(request?.polymarketOrder).toMatchObject({
      marketId: TEST_PM_NO_TOKEN_ID,
      conditionId: TEST_PM_NO_TOKEN_ID,
      outcome: 'no',
    });
  });

  it('normalizes the canonical parent conditionId before persistence', () => {
    const request = buildExecutionRequest(makeInput({
      pmConditionId: `  ${TEST_PM_CONDITION_ID.toUpperCase()}  `,
      pmNoTokenId: TEST_PM_NO_TOKEN_ID,
      strategy: 'Buy YES Kalshi + NO PM',
    }));

    expect(request?.pmConditionId).toBe(TEST_PM_CONDITION_ID);
  });

  it('rejects a token id supplied in the parent conditionId field', () => {
    expect(buildExecutionRequest(makeInput({
      pmConditionId: TEST_PM_NO_TOKEN_ID,
      pmNoTokenId: TEST_PM_NO_TOKEN_ID,
      strategy: 'Buy YES Kalshi + NO PM',
    }))).toBeNull();
  });
});

function makeUnifiedOutcome(overrides?: Partial<UnifiedOutcome>): UnifiedOutcome {
  return {
    artist: 'Team A',
    kalshi: {
      ticker: 'KXTEST-A',
      yesBid: 0.44,
      yesAsk: 0.45,
      noBid: 0.57,
      noAsk: 0.58,
      lastPrice: 0.50,
      yesAskDepth: '50',
      noAskDepth: '60',
    },
    polymarket: {
      marketId: 'pm-market-a',
      conditionId: 'pm-condition-a',
      yesPrice: 0.54,
      noPrice: 0.52,
      bestBid: 0.53,
      bestAsk: 0.55,
      lastTradePrice: 0.54,
      askDepth: 60,
      noAskDepth: 55,
      yesMinOrderSize: 1,
      noMinOrderSize: 1,
      yesTickSize: 0.01,
      noTickSize: 0.01,
    },
    arbitrage: {
      strategy: 'Buy YES Kalshi + NO PM',
      kalshiStake: 45,
      pmStake: 50,
      expectedProfit: 1.5,
      roiPct: 3.0,
      apyPct: 0,
      maxCapital: 100,
      buyPlatform: 'kalshi',
      buyPrice: 0.45,
      sellPlatform: 'polymarket',
      sellPrice: 0.52,
      arbType: 'direct',
    },
    source: 'auto',
    ...overrides,
  } as UnifiedOutcome;
}

describe('getBotSettings', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('./settings', async (importOriginal) => ({
      ...(await importOriginal()),
      getSetting: vi.fn(async (key: string) => {
        switch (key) {
          case 'bot.enabled': return true;
          case 'bot.mode': return 'paper';
          case 'bot.selectionMethod': return 'hybrid';
          case 'bot.minRoiPct': return 2.5;
          case 'bot.minApyPct': return 0;
          case 'bot.minSharesPerLeg': return 2;
          case 'bot.maxExpiryDays': return 1;
          case 'bot.maxTradesPerDay': return 5;
          default: return undefined;
        }
      }),
    }));
  });

  afterEach(() => {
    vi.doUnmock('./settings');
    vi.restoreAllMocks();
  });

  it('loads and coerces settings from DB', async () => {
    const { getBotSettings } = await import('./bot-trader');
    const settings = await getBotSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.mode).toBe('paper');
    expect(settings.minRoiPct).toBe(2.5);
    expect(settings.minSharesPerLeg).toBe(2);
    expect(settings.maxTradesPerDay).toBe(5);
  });
});

describe('evaluateBotTrade', () => {
  it('approves a simple profitable trade with enough depth', () => {
    const ev = evaluateBotTrade(makeInput(), baseSettings());
    expect(ev.shouldTrade).toBe(true);
    expect(ev.criteria.sharesK).toBeCloseTo(111.11, 1);
    expect(ev.criteria.sharesP).toBeCloseTo(105.77, 1);
    expect(ev.criteria.expiryDays).toBeGreaterThan(6);
  });

  it('rejects when disabled', () => {
    const ev = evaluateBotTrade(makeInput(), baseSettings({ enabled: false }));
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('disabled');
  });

  it('rejects non-positive ROI', () => {
    const ev = evaluateBotTrade(makeInput({ roiPct: 0 }), baseSettings());
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('not positive');
  });

  it('rejects ROI below minimum', () => {
    const ev = evaluateBotTrade(makeInput({ roiPct: 1.5 }), baseSettings({ minRoiPct: 2.0 }));
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('ROI');
  });

  it('rejects APY below minimum when APY filter enabled', () => {
    const ev = evaluateBotTrade(makeInput({ apyPct: 5 }), baseSettings({ minApyPct: 10 }));
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('APY');
  });

  it('allows APY below minimum when filter disabled (minApyPct=0)', () => {
    const ev = evaluateBotTrade(makeInput({ apyPct: 0 }), baseSettings({ minApyPct: 0 }));
    expect(ev.shouldTrade).toBe(true);
  });

  it('rejects markets expiring later than maxExpiryDays', () => {
    const later = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const ev = evaluateBotTrade(makeInput({ expiryDate: later }), baseSettings({ maxExpiryDays: 1 }));
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('Expires');
  });

  it('rejects when either leg cannot fill the configured shares at its quoted ask', () => {
    const ev = evaluateBotTrade(makeInput({ kalshiYesAsk: 0.45, kalshiYesDepth: 0.3 }), baseSettings({ minDepthUsd: 0.01, minSharesPerLeg: 1 }));
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('depth');
  });

  it('accepts one share at 24c with $0.24 ask-level depth instead of requiring a fixed $0.50', () => {
    const ev = evaluateBotTrade(
      makeInput({ kalshiYesAsk: 0.24, pmNoAsk: 0.74, kalshiYesDepth: 0.24, pmNoDepth: 0.74 }),
      baseSettings({ minDepthUsd: 999, minSharesPerLeg: 1 }),
    );
    expect(ev.shouldTrade).toBe(true);
    expect(ev.criteria.sharesK).toBeCloseTo(1, 6);
    expect(ev.criteria.sharesP).toBeCloseTo(1, 6);
  });

  it('rejects when depth cannot fill the canonical one-share hedge', () => {
    const ev = evaluateBotTrade(makeInput({ kalshiYesDepth: 0.2, pmNoDepth: 0.2 }), baseSettings({ minSharesPerLeg: 10 }));
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('shares');
  });

  it('handles $1 placement: 0.5 share per leg at $0.50 ask → ~$0.50/leg depth satisfies per-leg $0.50 minimum', () => {
    // The setting is per-leg depth. With $0.50 ask and $0.50 depth per leg, each leg
    // has exactly 1 share available, for a ~$1 total trade. This matches the
    // acceptance text: "approximately $0.50 per leg".
    const ev = evaluateBotTrade(
      makeInput({ kalshiYesAsk: 0.5, pmNoAsk: 0.5, kalshiYesDepth: 0.5, pmNoDepth: 0.5 }),
      baseSettings({ minDepthUsd: 0.5, minSharesPerLeg: 1 }),
    );
    expect(ev.shouldTrade).toBe(true);
    expect(ev.criteria.sharesK).toBeCloseTo(1, 3);
    expect(ev.criteria.sharesP).toBeCloseTo(1, 3);
  });

  it('rejects legacy invalid same-platform YES+YES strategies explicitly', () => {
    const ev = evaluateBotTrade(
      makeInput({ strategy: 'Same-platform YES+YES Kalshi: A + B' }),
      baseSettings(),
    );
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('Invalid legacy Internal arb: same-platform YES+YES is directional duplication');
  });

  it('rejects unknown strategy text instead of silently buying YES Kalshi + NO PM', () => {
    const ev = evaluateBotTrade(makeInput({ strategy: 'mystery strategy' }), baseSettings());
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('Unsupported strategy');
  });

  it('accepts cross-outcome YES+YES strategy with correct leg prices', () => {
    const ev = evaluateBotTrade(
      makeInput({
        strategy: 'Buy YES both sides: Kalshi A + PM B',
        crossOutcomeMutuallyExclusiveVerified: true,
        crossOutcomeExhaustiveVerified: true,
        propositionRelationship: verifiedRelationship('yes'),
        kalshiYesAsk: 0.42,
        pmYesAsk: 0.55,
      }),
      baseSettings(),
    );
    expect(ev.criteria.sharesK).toBeCloseTo(119.05, 1);
    expect(ev.criteria.sharesP).toBeCloseTo(109.09, 1);
    expect(ev.shouldTrade).toBe(true);
  });

  it('rejects cross-outcome with missing yes ask', () => {
    const ev = evaluateBotTrade(
      makeInput({
        strategy: 'Buy YES both sides: Kalshi A + PM B',
        kalshiYesAsk: null,
      }),
      baseSettings(),
    );
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('Missing tradeable ask price');
  });
});

describe('buildExecutionRequest', () => {
  it('fails closed when no executable book quote is attached', () => {
    const input = makeInput();
    delete input.kalshiYesExecutableQuote;
    delete input.pmNoExecutableQuote;

    expect(buildExecutionRequest(input)).toBeNull();
  });

  it('immutably carries strategy-selected YES/YES asks into one-share orders', () => {
    const req = buildExecutionRequest(makeInput({
      strategy: 'Buy YES both sides: Kalshi Republican + PM Democratic',
      crossOutcomeMutuallyExclusiveVerified: true,
      crossOutcomeExhaustiveVerified: true,
      propositionRelationship: verifiedRelationship('yes'),
      kalshiYesAsk: 0.40,
      pmYesAsk: 0.52,
      kalshiStake: 40,
      pmStake: 52,
      expectedProfit: 8,
    }));
    expect(req?.kalshiOrder).toMatchObject({ outcome: 'yes', price: 0.40, contracts: 1, size: 0.40 });
    expect(req?.polymarketOrder).toMatchObject({ outcome: 'yes', price: 0.52, contracts: 1, size: 0.52 });
    expect(req?.estimatedProfit).toBeCloseTo(0.08, 8);
  });

  it('fails closed when canonical relationship metadata is missing', () => {
    const input = makeInput();
    delete input.propositionRelationship;
    expect(evaluateBotTrade(input, baseSettings()).reason).toContain('server-owned canonical proposition registry');
    expect(buildExecutionRequest(input)).toBeNull();
  });

  it('rejects same-direction YES+YES even when legacy booleans say verified', () => {
    const propositionRelationship = verifiedRelationship('yes');
    propositionRelationship.legs.polymarket.selectedOutcome = 'team a';
    propositionRelationship.legs.polymarket.payoutState = 'team a';
    const input = makeInput({
      strategy: 'Buy YES both sides: Kalshi Team A + PM Team A',
      crossOutcomeMutuallyExclusiveVerified: true,
      crossOutcomeExhaustiveVerified: true,
      propositionRelationship,
    });
    expect(evaluateBotTrade(input, baseSettings())).toMatchObject({ shouldTrade: false });
    expect(buildExecutionRequest(input)).toBeNull();
  });

  it('uses the selected NO ask on PM and never substitutes the YES ask', () => {
    const req = buildExecutionRequest(makeInput({
      strategy: 'Buy YES Kalshi + NO PM',
      kalshiYesAsk: 0.03,
      pmYesAsk: 0.07,
      pmNoAsk: 0.94,
    }));
    expect(req?.kalshiOrder).toMatchObject({ outcome: 'yes', price: 0.03, contracts: 1 });
    expect(req?.polymarketOrder).toMatchObject({ outcome: 'no', price: 0.94, contracts: 1 });
  });

  it('rejects a venue minimum above the canonical one-share quantity', () => {
    const input = makeInput({
      kalshiYesAsk: 0.45,
      pmNoAsk: 0.50,
      kalshiYesDepth: 2.25,
      pmNoDepth: 2.50,
      pmNoMinOrderSize: 5,
    });

    expect(buildExecutionRequest(input, 1)).toBeNull();
  });

  it('does not upscale the canonical one-share quantity from a legacy configured minimum', () => {
    const req = buildExecutionRequest(makeInput({
      kalshiYesDepth: 3.15,
      pmNoDepth: 3.64,
    }), 7);

    expect(req?.kalshiOrder.contracts).toBe(1);
    expect(req?.polymarketOrder.contracts).toBe(1);
  });

  it('fails final qualification when fresh authoritative fees erase scan-time profit', () => {
    const input = makeInput({
      kalshiYesAsk: 0.49,
      pmNoAsk: 0.50,
      expectedProfit: 0.01,
      roiPct: 1,
    });
    const request = buildExecutionRequest(input)!;
    const economics = revalidateBotTradeEconomics(input, baseSettings({ minRoiPct: 0 }), request, {
      kalshi: {
        feeType: 'quadratic', feeMultiplierPpm: 1_000_000,
        source: 'kalshi-series:KXTEST', observedAt: new Date().toISOString(), version: 'quadratic:1000000',
      },
      polymarket: {
        tokenId: TEST_PM_NO_TOKEN_ID, feeRateBps: 700, feesEnabled: true,
        feeSchedule: { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.25 },
        orderBaseFeeBps: 1000,
        orderSource: `https://clob.polymarket.com/fee-rate?token_id=${TEST_PM_NO_TOKEN_ID}`,
        orderVersion: 'token-order-base-fee:1000',
        source: `https://gamma-api.polymarket.com/markets?condition_ids=${TEST_PM_CONDITION_ID}`,
        observedAt: new Date().toISOString(), version: 'gamma-fee-schedule:700:1:true:0.25',
      },
      pmTheta: 0.07,
    });

    expect(economics.eligible).toBe(false);
    expect(economics.expectedProfit).toBeLessThan(0);
    expect(economics.reason).toContain('not positive');
  });
});

describe('unifiedOutcomeToBotInput', () => {
  it('maps a UnifiedOutcome into a BotTradeInput', () => {
    const o = makeUnifiedOutcome();
    const input = unifiedOutcomeToBotInput('pair-1', 'Test Market', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), o);
    expect(input.pairId).toBe('pair-1');
    expect(input.marketTitle).toBe('Test Market');
    expect(input.outcome).toBe('Team A');
    expect(input.kalshiTicker).toBe('KXTEST-A');
    expect(input.pmConditionId).toBe('pm-condition-a');
    expect(input.pmYesDepth).toBe(60);
  });

  it('normalizes Kalshi string depth into numbers', () => {
    const o = makeUnifiedOutcome({
      kalshi: {
        ticker: 'KXTEST-A',
        yesBid: 0.44,
        yesAsk: 0.45,
        noBid: 0.57,
        noAsk: 0.58,
        lastPrice: 0.50,
        yesAskDepth: '$1.2K',
        noAskDepth: '0',
      } as UnifiedOutcome['kalshi'],
    });
    const input = unifiedOutcomeToBotInput('pair-1', 'Test Market', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), o);
    expect(input.kalshiYesDepth).toBe(1200);
  });
});

describe('maybeExecuteBotTrade safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.stubEnv('H2H_DRY_RUN', 'true');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.doMock('./persistence', async (importOriginal) => ({
      ...(await importOriginal()),
      hasOpenBotPosition: vi.fn().mockResolvedValue(false),
      getTodayBotExposure: vi.fn().mockResolvedValue(0),
      persistExecution: vi.fn().mockResolvedValue(1),
    }));
    vi.doMock('./settings', async (importOriginal) => ({
      ...(await importOriginal()),
      getSetting: vi.fn(async (key: string) => {
        switch (key) {
          case 'bot.enabled': return true;
          case 'bot.mode': return 'paper';
          case 'bot.minRoiPct': return 0;
          case 'bot.minApyPct': return 0;
          case 'bot.minDepthUsd': return 0.01;
          case 'bot.minSharesPerLeg': return 1;
          case 'bot.maxExpiryDays': return 0;
          case 'bot.maxTradesPerDay': return 100;
          case 'execute.maxDailyExposure': return 10000;
          default: return undefined;
        }
      }),
      getExecutionMode: vi.fn().mockResolvedValue('paper'),
    }));
    vi.doMock('./bot-positions', async (importOriginal) => ({
      ...(await importOriginal()),
      fetchAuthoritativeBotFeeConfig: vi.fn().mockResolvedValue({
        kalshi: {
          authority: {
            marketTicker: 'KXTEST-YES', eventTicker: 'KXTEST-EVENT', seriesTicker: 'KXTEST',
            feeType: 'quadratic', feeMultiplierPpm: 1_000_000,
            source: 'kalshi-series:KXTEST', observedAt: new Date().toISOString(), version: 'quadratic:1000000',
          },
          feeType: 'quadratic', feeMultiplierPpm: 1_000_000, source: 'kalshi-series:KXTEST', observedAt: new Date().toISOString(), version: 'quadratic:1000000',
        },
        polymarket: {
          tokenId: TEST_PM_NO_TOKEN_ID, feeRateBps: 400, feesEnabled: true,
          feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
          orderBaseFeeBps: 1000,
          orderSource: `https://clob.polymarket.com/fee-rate?token_id=${TEST_PM_NO_TOKEN_ID}`,
          orderVersion: 'token-order-base-fee:1000',
          source: `https://gamma-api.polymarket.com/markets?condition_ids=${TEST_PM_CONDITION_ID}`,
          observedAt: new Date().toISOString(), version: 'gamma-fee-schedule:400:1:true:0.25',
        },
        pmTheta: 0.04,
      }),
      recordBotPosition: vi.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock('./auto-execute');
    vi.doUnmock('./persistence');
    vi.doUnmock('./settings');
    vi.doUnmock('./bot-positions');
  });

  it('simulates in paper mode even when production requested', async () => {
    const persistence = await import('./persistence');
    const positions = await import('./bot-positions');
    const { maybeExecuteBotTrade } = await import('./bot-trader');
    const input = makeInput();
    // This describe block resets the module graph before dynamically importing
    // BotTrader; seed the same runtime singleton used by executeArb.
    const runtimeState = (await import('./orderbook-state')).orderbookState;
    runtimeState.setBook(input.kalshiTicker!, [{ price: 0.45, quantity: 1 }], [], 0, {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp: input.kalshiYesExecutableQuote!.depthTimestamp!,
    });
    runtimeState.setBook(TEST_PM_NO_TOKEN_ID, [], [{ price: 0.52, quantity: 1 }], 0, {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp: input.pmNoExecutableQuote!.depthTimestamp!,
    });
    const result = await maybeExecuteBotTrade(input);
    expect(result.dryRun).toBe(true);
    expect(result.executed, JSON.stringify(result)).toBe(true);
    expect(result.positionPersisted).toBe(true);
    expect(result.persistenceError).toBeUndefined();
    expect(result.reason).toContain('Paper');
    expect(persistence.hasOpenBotPosition).toHaveBeenCalledWith('bot:pair-1:team-a', 'paper');
    expect(persistence.getTodayBotExposure).toHaveBeenCalledWith('paper');
    expect(result.executionRecord?.polymarketOrder).toMatchObject({
      conditionId: TEST_PM_NO_TOKEN_ID,
      signingFeeRateBps: 1000,
    });
    expect(positions.recordBotPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: 'paper',
        pmConditionId: TEST_PM_CONDITION_ID,
        pmSide: 'no',
      }),
      expect.objectContaining({
        polymarket: expect.objectContaining({ tokenId: TEST_PM_NO_TOKEN_ID }),
      }),
    );
  });

  it('does not publish a successful paper trade when canonical position persistence fails', async () => {
    const positions = await import('./bot-positions');
    const messages = await import('./bot-trader-messages');
    const actionLog = await import('./bot-action-log');
    vi.mocked(positions.recordBotPosition).mockRejectedValueOnce(new Error('disk full'));
    const { maybeExecuteBotTrade } = await import('./bot-trader');
    const input = makeInput();
    const runtimeState = (await import('./orderbook-state')).orderbookState;
    runtimeState.setBook(input.kalshiTicker!, [{ price: 0.45, quantity: 1 }], [], 0, {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp: input.kalshiYesExecutableQuote!.depthTimestamp!,
    });
    runtimeState.setBook(TEST_PM_NO_TOKEN_ID, [], [{ price: 0.52, quantity: 1 }], 0, {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp: input.pmNoExecutableQuote!.depthTimestamp!,
    });

    const result = await maybeExecuteBotTrade(input);

    expect(result).toMatchObject({
      executed: false,
      dryRun: true,
      positionPersisted: false,
      persistenceError: expect.stringContaining('disk full'),
    });
    expect(result.reason).toMatch(/paper trade persistence failed/i);
    expect(result.reason).not.toMatch(/simulated/i);
    expect(result.exposureState).toBeUndefined();
    expect(messages.createBotMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageType: 'trade_failed',
      messageText: expect.stringContaining('BotTrader attempted'),
    }));
    expect(messages.createBotMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      messageType: 'trade_placed',
    }));
    expect(actionLog.appendBotActionLog).toHaveBeenCalledWith(expect.objectContaining({
      step: 'result',
      responseStatus: 'failed',
      errorReason: expect.stringContaining('disk full'),
    }));
    expect(actionLog.appendBotActionLog).not.toHaveBeenCalledWith(expect.objectContaining({
      step: 'result',
      responseStatus: 'passed',
    }));
  });

  it('carries a controlled eligible scan through the real consumer and execution engine without a financial order', async () => {
    const { createBotScanConsumer } = await import('./bot-scan-consumer');
    const { maybeExecuteBotTrade } = await import('./bot-trader');
    const input = makeInput({ pmConditionId: TEST_PM_CONDITION_ID, pmNoTokenId: TEST_PM_NO_TOKEN_ID });
    const runtimeState = (await import('./orderbook-state')).orderbookState;
    runtimeState.setBook(input.kalshiTicker!, [{ price: 0.45, quantity: 1 }], [], 0, {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp: input.kalshiYesExecutableQuote!.depthTimestamp!,
    });
    runtimeState.setBook(TEST_PM_NO_TOKEN_ID, [], [{ price: 0.52, quantity: 1 }], 0, {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp: input.pmNoExecutableQuote!.depthTimestamp!,
    });
    const refreshedCandidate = {
      ...input,
      fees: { kalshiFee: 0.01, pmFee: 0.01 },
      candidateIndex: 0,
    } as BotScanCandidate;
    const scan: PersistedBotScan = {
      id: 91,
      marketId: input.pairId,
      marketTitle: input.marketTitle,
      scannedAt: new Date().toISOString(),
      positiveArbCount: 1,
      candidates: [refreshedCandidate],
    };
    const terminalAudits: Array<{ state: string; reasonCode: string; details: unknown }> = [];
    const consumer = createBotScanConsumer({
      now: () => new Date(),
      getSettings: async () => baseSettings({ mode: 'paper' }),
      resolveExecutionMode: async () => 'paper',
      loadScan: async () => scan,
      listBacklog: async () => [scan],
      acquire: async () => ({
        scanId: scan.id, idempotencyKey: `scan:${scan.id}`, source: 'catch_up', state: 'received',
        reasonCode: 'scan_received', reason: 'received', receivedAt: scan.scannedAt, updatedAt: scan.scannedAt,
        attempts: 0, placementCount: 0, details: null, leaseOwner: 'lease-91',
      }),
      transition: async (_id, _owner, update) => ({ ...update } as never),
      finish: async (_id, _owner, update) => ({ ...update } as never),
      recordReplay: async () => undefined,
      advanceCursor: async () => undefined,
      revalidate: async () => scan.candidates,
      execute: maybeExecuteBotTrade,
      reserveOpportunity: async () => true,
      releaseOpportunity: async () => undefined,
      retainOpportunityForExposure: async () => undefined,
      recordCandidateDecision: async (_scan, _index, _candidate, state, reasonCode, _reason, details) => {
        terminalAudits.push({ state, reasonCode, details });
      },
    });

    await expect(consumer.consume(scan.id, 'catch_up')).resolves.toMatchObject({ state: 'placed', reasonCode: 'paper_placed' });
    expect(terminalAudits).toContainEqual(expect.objectContaining({
      state: 'accepted',
      reasonCode: 'execution_completed',
      details: expect.objectContaining({ final: true, executionMode: 'paper' }),
    }));
    expect((await import('./persistence')).persistExecution).toHaveBeenCalledOnce();
  });

  it('durably surfaces an unhedged rollback alert even when the alert store fails', async () => {
    vi.doMock('./auto-execute', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./auto-execute')>()),
      executeArb: vi.fn(async () => ({
        success: false,
        kalshiResult: { platform: 'kalshi', status: 'filled', filledContracts: 1, filledPrice: 0.45, timestamp: new Date().toISOString() },
        polymarketResult: { platform: 'polymarket', status: 'cancelled', filledContracts: 0, timestamp: new Date().toISOString() },
        rollbackExecuted: true,
        unhedged: true,
        executionTimeMs: 5,
        error: 'Leg B disappeared and rollback close failed',
        alerts: [{ level: 'error', message: 'Unhedged exposure remains after rollback failure', leg: 'kalshi' },
        ],
        steps: [],
      })),
    }));
    const messages = await import('./bot-trader-messages');
    vi.mocked(messages.createBotMessage).mockRejectedValueOnce(new Error('SQLITE_BUSY alert store'));
    const actionLog = await import('./bot-action-log');
    const { maybeExecuteBotTrade } = await import('./bot-trader');

    const result = await maybeExecuteBotTrade(makeInput());

    expect(result).toMatchObject({
      executed: false,
      executionResult: { unhedged: true },
      alertStatus: { durable: false, delivered: false, error: 'Alert persistence failed: SQLITE_BUSY alert store' },
    });
    expect(actionLog.appendBotActionLog).toHaveBeenCalledWith(expect.objectContaining({
      step: 'alert',
      responseStatus: 'failed',
      responsePayload: expect.objectContaining({
        durable: false,
        error: 'Alert persistence failed: SQLITE_BUSY alert store',
      }),
      alertMetadata: expect.objectContaining({ unhedged: true }),
    }));
  });

  it('fails closed before execution when authoritative fee lookup fails', async () => {
    const positions = await import('./bot-positions');
    vi.mocked(positions.fetchAuthoritativeBotFeeConfig).mockRejectedValueOnce(new Error('fee endpoint unavailable'));
    const persistence = await import('./persistence');
    const { maybeExecuteBotTrade } = await import('./bot-trader');
    const result = await maybeExecuteBotTrade(makeInput());
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/fee authority/i);
    expect(persistence.persistExecution).not.toHaveBeenCalled();
  });
});

describe('BotTrader durable success publication', () => {
  it('does not publish live placement success when canonical position persistence fails', () => {
    const publication = getBotTradePublication({
      dryRun: false,
      marketTitle: 'Test Market',
      resultSuccess: true,
      shouldPersistPerformance: true,
      positionPersisted: false,
      persistenceError: 'Position persistence failed: disk full',
    });

    expect(publication).toEqual({
      executed: false,
      alertSuccess: false,
      reason: 'Production trade persistence failed for Test Market: Position persistence failed: disk full',
      exposureState: 'pending_reconciliation',
    });
  });
});

describe('edge cases', () => {
  it('returns disabled when enabled=false without hitting persistence', () => {
    const ev = evaluateBotTrade(makeInput(), baseSettings({ enabled: false }));
    expect(ev.shouldTrade).toBe(false);
  });

  it('handles missing expiryDate gracefully', () => {
    const ev = evaluateBotTrade(makeInput({ expiryDate: null }), baseSettings());
    expect(ev.shouldTrade).toBe(true);
    expect(ev.criteria.expiryDays).toBeNull();
  });

  it('handles malformed expiryDate', () => {
    const ev = evaluateBotTrade(makeInput({ expiryDate: 'not-a-date' }), baseSettings());
    expect(ev.criteria.expiryDays).toBeNull();
  });
});
