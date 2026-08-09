import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateBotTrade,
  maybeExecuteBotTrade,
  unifiedOutcomeToBotInput,
  getBotSettings,
  type BotSettings,
  type BotTradeInput,
} from './bot-trader';
import type { UnifiedOutcome } from './matcher';

vi.mock('./bot-action-log', () => ({
  appendBotActionLog: vi.fn(async () => 1),
}));

function baseSettings(overrides?: Partial<BotSettings>): BotSettings {
  return {
    enabled: true,
    mode: 'paper',
    minRoiPct: 2.0,
    minApyPct: 0,
    minDepthUsd: 0.5,
    minSharesPerLeg: 1,
    maxExpiryDays: 1,
    maxTradesPerDay: 10,
    ...overrides,
  };
}

function makeInput(overrides?: Partial<BotTradeInput>): BotTradeInput {
  const farFuture = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
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
    pmConditionId: 'pm-condition-a',
    kalshiYesAsk: 0.45,
    kalshiNoAsk: 0.58,
    pmYesAsk: 0.55,
    pmNoAsk: 0.52,
    kalshiYesDepth: 50,
    kalshiNoDepth: 60,
    pmYesDepth: 60,
    pmNoDepth: 55,
    expiryDate: farFuture,
    ...overrides,
  };
}

function makeUnifiedOutcome(overrides?: Partial<UnifiedOutcome>): UnifiedOutcome {
  const farFuture = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
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

  it('rejects markets expiring sooner than maxExpiryDays', () => {
    const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
    const ev = evaluateBotTrade(makeInput({ expiryDate: soon }), baseSettings({ maxExpiryDays: 1 }));
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('Expires');
  });

  it('rejects when either leg has insufficient dollar depth', () => {
    const ev = evaluateBotTrade(makeInput({ kalshiYesDepth: 0.3 }), baseSettings({ minDepthUsd: 1 }));
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('depth');
  });

  it('rejects when shares per leg are below minimum', () => {
    const ev = evaluateBotTrade(makeInput({ kalshiYesDepth: 0.9, pmNoDepth: 0.9 }), baseSettings({ minSharesPerLeg: 2 }));
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

  it('rejects same-platform internal arbs (not yet bot-tradeable)', () => {
    const ev = evaluateBotTrade(
      makeInput({ strategy: 'Same-platform YES+YES Kalshi: A + B' }),
      baseSettings(),
    );
    expect(ev.shouldTrade).toBe(false);
    expect(ev.reason).toContain('Missing tradeable ask price');
  });

  it('accepts cross-outcome YES+YES strategy with correct leg prices', () => {
    const ev = evaluateBotTrade(
      makeInput({
        strategy: 'Buy YES both sides: Kalshi A + PM B',
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
      } as any,
    });
    const input = unifiedOutcomeToBotInput('pair-1', 'Test Market', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), o);
    expect(input.kalshiYesDepth).toBe(1200);
  });
});

describe('maybeExecuteBotTrade safety', () => {
  beforeEach(() => {
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
          case 'bot.minRoiPct': return 0.5;
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock('./persistence');
    vi.doUnmock('./settings');
  });

  it('simulates in paper mode even when production requested', async () => {
    const { maybeExecuteBotTrade } = await import('./bot-trader');
    const result = await maybeExecuteBotTrade(makeInput());
    expect(result.dryRun).toBe(true);
    expect(result.executed).toBe(true);
    expect(result.reason).toContain('Paper');
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
