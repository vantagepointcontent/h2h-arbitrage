import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPolymarketBook,
  computeCapturedLiveArbitrages,
  computeAllLiveArbitrages,
  parseBookStaleMs,
} from './live-arb-engine';
import { orderbookState } from './orderbook-state';
import {
  KALSHI_RECONNECT_BASE_MS,
  KALSHI_RECONNECT_MAX_MS,
} from './kalshi-ws';
import {
  CLOB_RECONNECT_BASE_MS,
  CLOB_RECONNECT_MAX_MS,
} from './clob-ws';
import { applyKalshiWsMessage, applyPmWsUpdates } from './ws-book-apply';
import { buildExecutionRequest, liveArbResultToBotInput } from './bot-trader';
import type { PropositionRelationship } from './proposition-identity';

vi.mock('./proposition-registry', () => ({
  resolveCanonicalPropositionRelationship: (relationship: PropositionRelationship | null | undefined) => relationship ?? null,
  findCanonicalPropositionRelationship: () => null,
}));

const outcome = {
  artist: 'Example',
  kalshiMarketQuestion: 'Will Example win on Kalshi?',
  pmMarketQuestion: 'Will Example win on Polymarket?',
  kalshiTicker: 'KX-BUG-096',
  pmYesTokenId: '1001',
  pmNoTokenId: '1002',
  pmBinaryVerified: true,
  pmYesMinOrderSize: 1,
  pmNoMinOrderSize: 1,
  pmYesTickSize: 0.01,
  pmNoTickSize: 0.01,
  crossOutcomeMutuallyExclusiveVerified: true,
  crossOutcomeExhaustiveVerified: true,
  pmConditionId: `0x${'1'.repeat(64)}`,
  propositionRelationship: {
    schemaVersion: 1 as const,
    state: 'verified_complementary' as const,
    verificationSource: 'authoritative_platform_metadata' as const,
    verifiedAt: '2026-08-17T12:00:00.000Z',
    parentEventId: 'example-event',
    resolutionRuleId: 'example-event-rules-v1',
    exhaustivePayoutStates: ['example', 'not example'],
    humanLabel: 'Kalshi YES Example ↔ Polymarket NO Example',
    legs: {
      kalshi: {
        platform: 'kalshi' as const, platformMarketId: 'KX-BUG-096', parentEventId: 'example-event',
        selectedOutcome: 'example', contractSide: 'yes' as const, payoutState: 'example',
        eventPayoutStates: ['example', 'not example'], resolutionRuleId: 'example-event-rules-v1',
        humanLabel: 'Kalshi YES — Example', marketQuestion: 'Will Example happen?', tokenId: null,
      },
      polymarket: {
        platform: 'polymarket' as const, platformMarketId: `0x${'1'.repeat(64)}`, parentEventId: 'example-event',
        selectedOutcome: 'example', contractSide: 'no' as const, payoutState: 'not example',
        eventPayoutStates: ['example', 'not example'], resolutionRuleId: 'example-event-rules-v1',
        humanLabel: 'Polymarket NO — Example', marketQuestion: 'Will Example happen?', tokenId: '1002',
      },
    },
  },
  pmFeesEnabled: true,
  pmFeeSchedule: { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.25 },
};

const complement = {
  artist: 'Complement',
  kalshiMarketQuestion: 'Will Complement win on Kalshi?',
  pmMarketQuestion: 'Will Complement win on Polymarket?',
  kalshiTicker: 'KX-BUG-101-COMP',
  pmYesTokenId: '2001',
  pmNoTokenId: '2002',
  pmBinaryVerified: true,
  pmYesMinOrderSize: 1,
  pmNoMinOrderSize: 1,
  pmYesTickSize: 0.01,
  pmNoTickSize: 0.01,
  crossOutcomeMutuallyExclusiveVerified: true,
  crossOutcomeExhaustiveVerified: true,
  pmConditionId: `0x${'2'.repeat(64)}`,
  pmFeesEnabled: true,
  pmFeeSchedule: { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.25 },
};

describe('parseBookStaleMs', () => {
  it.each(['', '0', '-1', 'Infinity', '60seconds', '0x100'])(
    'fails closed to the safe default for invalid value %j',
    (value) => expect(parseBookStaleMs(value)).toBe(90_000),
  );

  it('accepts a finite positive decimal duration', () => {
    expect(parseBookStaleMs('90000')).toBe(90_000);
    expect(parseBookStaleMs('120000')).toBe(120_000);
  });
});

afterEach(() => {
  orderbookState.removeBook(outcome.kalshiTicker);
  orderbookState.removeBook(outcome.pmYesTokenId);
  orderbookState.removeBook(outcome.pmNoTokenId);
  orderbookState.removeBook(complement.kalshiTicker);
  orderbookState.removeBook(complement.pmYesTokenId);
  orderbookState.removeBook(complement.pmNoTokenId);
  vi.useRealTimers();
});

describe('computeAllLiveArbitrages stale handling (BUG-104)', () => {
  it('keeps last known prices visible but zeroes execution math when stale', () => {
    orderbookState.setBook(outcome.kalshiTicker,
      [{ price: 0.42, quantity: 100 }],
      [{ price: 0.58, quantity: 100 }],
    );
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.40, quantity: 100 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.60, quantity: 100 }]);

    vi.useFakeTimers();
    vi.advanceTimersByTime(91_000);

    const result = computeAllLiveArbitrages([outcome], 1000)[0];

    expect(result.stale).toBe(true);
    expect(result.kalshiMarketQuestion).toBe('Will Example win on Kalshi?');
    expect(result.pmMarketQuestion).toBe('Will Example win on Polymarket?');
    expect(result.kalshiYesAsk).toBe(0.42);
    expect(result.pmYesAsk).toBe(0.40);
    expect(result.roiPct).toBe(0);
    expect(result.expectedProfit).toBe(0);
    expect(result.kalshiStake).toBe(0);
    expect(result.pmStake).toBe(0);
  });

  it('still computes arbs when books are fresh within the 90s window', () => {
    orderbookState.setBook(outcome.kalshiTicker,
      [{ price: 0.35, quantity: 100 }],
      [{ price: 0.60, quantity: 100 }],
    );
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.42, quantity: 100 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.58, quantity: 100 }]);

    vi.useFakeTimers();
    vi.advanceTimersByTime(30_000);

    const result = computeAllLiveArbitrages([outcome], 1000)[0];

    expect(result.stale).toBe(false);
    expect(result.kalshiYesAsk).toBe(0.35);
    expect(result.pmYesAsk).toBe(0.42);
    expect(result.strategy).not.toBe('No arb');
    expect(result.roiPct).toBeGreaterThan(0);
  });
});

describe('computeAllLiveArbitrages effective execution quotes', () => {
  it('walks one share across shuffled depth but fails closed before Matched Market authorization', () => {
    const observedAt = new Date().toISOString();
    const constraints = {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp: observedAt,
    };
    orderbookState.setBook(outcome.kalshiTicker,
      [{ price: 0.45, quantity: 0.7 }, { price: 0.40, quantity: 0.4 }],
      [{ price: 0.70, quantity: 10 }],
      0,
      constraints,
    );
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.70, quantity: 10 }], [], 0, constraints);
    orderbookState.setBook(outcome.pmNoTokenId,
      [],
      [{ price: 0.50, quantity: 0.6 }, { price: 0.45, quantity: 0.5 }],
      0,
      constraints,
    );

    const result = computeAllLiveArbitrages([outcome], 100)[0];
    expect(result.kalshiYesExecutableQuote).toMatchObject({
      status: 'executable',
      vwapPriceMicroCents: 43_000_000,
      depthTimestamp: observedAt,
    });
    expect(result.pmNoExecutableQuote).toMatchObject({
      status: 'executable',
      vwapPriceMicroCents: 47_500_000,
      depthTimestamp: observedAt,
    });
    expect(result.kalshiYesAsk).toBe(0.43);
    expect(result.pmNoAsk).toBe(0.475);

    const input = liveArbResultToBotInput('pair-1', 'Market', undefined, result);
    expect(input.kalshiYesExecutableQuote).toEqual(result.kalshiYesExecutableQuote);
    expect(input.pmNoExecutableQuote).toEqual(result.pmNoExecutableQuote);
    expect(buildExecutionRequest(input)).toBeNull();
  });

  it('marks one-share Polymarket execution non-executable when the book minimum is five', () => {
    const observedAt = '2026-08-14T11:02:35.000Z';
    orderbookState.setBook(outcome.kalshiTicker,
      [{ price: 0.40, quantity: 10 }],
      [{ price: 0.70, quantity: 10 }],
    );
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.70, quantity: 10 }], [], 0, {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 5_000_000,
      depthTimestamp: observedAt,
    });
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.45, quantity: 10 }], 0, {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 5_000_000,
      depthTimestamp: observedAt,
    });

    const result = computeAllLiveArbitrages([outcome], 100)[0];
    expect(result.pmNoExecutableQuote).toMatchObject({
      status: 'non_executable',
      reason: 'below_minimum_order',
    });
    expect(result.strategy).toBe('No arb');
    expect(buildExecutionRequest(liveArbResultToBotInput('pair-1', 'Market', undefined, result))).toBeNull();
  });

  it('blocks Kalshi Internal when dollar depth is below the one-contract price', () => {
    orderbookState.setBook(outcome.kalshiTicker, [{ price: 0.30, quantity: 0.9 }], [{ price: 0.30, quantity: 0.9 }]);
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.70, quantity: 20 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.70, quantity: 20 }]);
    const result = computeAllLiveArbitrages([outcome], 10)[0];
    expect(result.strategy).not.toBe('Same-platform YES+NO Kalshi: Example');
  });

  it('blocks Polymarket Internal when either selected ask is off tick', () => {
    orderbookState.setBook(outcome.kalshiTicker, [{ price: 0.80, quantity: 20 }], [{ price: 0.80, quantity: 20 }]);
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.305, quantity: 20 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.305, quantity: 20 }]);
    const result = computeAllLiveArbitrages([outcome], 10)[0];
    expect(result.strategy).not.toBe('Same-platform YES+NO Polymarket: Example');
  });

  it('classifies same-market YES+NO as Internal and never pairs two YES contracts', () => {
    orderbookState.setBook(outcome.kalshiTicker, [{ price: 0.30, quantity: 20 }], [{ price: 0.30, quantity: 20 }]);
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.70, quantity: 20 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.70, quantity: 20 }]);

    const result = computeAllLiveArbitrages([outcome], 10)[0];

    expect(result.arbType).toBe('internal');
    expect(result.strategy).toBe('Same-platform YES+NO Kalshi: Example');
    expect(result.strategy).not.toContain('YES+YES');
    expect(result.expectedProfit).toBeGreaterThan(0);
    expect(result.fees?.kalshiFee).toBeGreaterThan(0);
  });

  it('rejects Polymarket Internal when exact binary settlement was not verified', () => {
    const unverified = { ...outcome, pmBinaryVerified: false };
    orderbookState.setBook(unverified.kalshiTicker, [{ price: 0.70, quantity: 20 }], [{ price: 0.70, quantity: 20 }]);
    orderbookState.setBook(unverified.pmYesTokenId, [{ price: 0.30, quantity: 20 }], []);
    orderbookState.setBook(unverified.pmNoTokenId, [], [{ price: 0.30, quantity: 20 }]);

    const result = computeAllLiveArbitrages([unverified], 10)[0];

    expect(result.strategy).not.toBe('Same-platform YES+NO Polymarket: Example');
    expect(result.arbType).not.toBe('internal');
  });

  it('rejects cross-outcome self-pairing with duplicated venue identifiers', () => {
    const duplicate = { ...outcome };
    orderbookState.setBook(outcome.kalshiTicker, [{ price: 0.20, quantity: 20 }], [{ price: 0.90, quantity: 20 }]);
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.20, quantity: 20 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.90, quantity: 20 }]);

    const result = computeAllLiveArbitrages([outcome, duplicate], 10);

    expect(result.every((candidate) => candidate.arbType !== 'cross')).toBe(true);
  });

  it('rejects cross-outcome selection when either explicit resolution fact is absent', () => {
    const notExhaustive = { ...complement, crossOutcomeExhaustiveVerified: false };
    orderbookState.setBook(outcome.kalshiTicker, [{ price: 0.20, quantity: 20 }], [{ price: 0.90, quantity: 20 }]);
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.90, quantity: 20 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.20, quantity: 20 }]);
    orderbookState.setBook(notExhaustive.kalshiTicker, [{ price: 0.90, quantity: 20 }], [{ price: 0.20, quantity: 20 }]);
    orderbookState.setBook(notExhaustive.pmYesTokenId, [{ price: 0.20, quantity: 20 }], []);
    orderbookState.setBook(notExhaustive.pmNoTokenId, [], [{ price: 0.90, quantity: 20 }]);
    const result = computeAllLiveArbitrages([outcome, notExhaustive], 10);
    expect(result.every((candidate) => candidate.arbType !== 'cross')).toBe(true);
  });

  it('charges both actual YES-leg fees for a captured cross strategy', () => {
    orderbookState.setBook(outcome.kalshiTicker,
      [{ price: 0.30, quantity: 100 }],
      [{ price: 0.70, quantity: 100 }],
    );
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.60, quantity: 100 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.40, quantity: 100 }]);
    orderbookState.setBook(complement.kalshiTicker,
      [{ price: 0.60, quantity: 100 }],
      [{ price: 0.40, quantity: 100 }],
    );
    orderbookState.setBook(complement.pmYesTokenId, [{ price: 0.40, quantity: 100 }], []);
    orderbookState.setBook(complement.pmNoTokenId, [], [{ price: 0.60, quantity: 100 }]);

    const [captured] = computeCapturedLiveArbitrages([outcome, complement], 100, 'sports', [{
      kalshiTicker: outcome.kalshiTicker,
      pmConditionId: complement.pmConditionId,
      arbType: 'cross',
      strategy: 'Buy YES both sides: Kalshi Example + PM Complement',
    }]);

    expect(captured.fees?.kalshiFee).toBeCloseTo(0.02, 5);
    expect(captured.fees?.pmFee).toBeCloseTo(0.012, 5);
    expect(captured.roiPct).toBeCloseTo(26.8, 4);
  });

  it('charges the authoritative PM YES fee while discovering a live cross strategy', () => {
    const feeBearingComplement = {
      ...complement,
      pmFeeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
    };
    orderbookState.setBook(outcome.kalshiTicker,
      [{ price: 0.30, quantity: 100 }],
      [{ price: 0.80, quantity: 100 }],
    );
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.80, quantity: 100 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.80, quantity: 100 }]);
    orderbookState.setBook(complement.kalshiTicker,
      [{ price: 0.80, quantity: 100 }],
      [{ price: 0.30, quantity: 100 }],
    );
    orderbookState.setBook(complement.pmYesTokenId, [{ price: 0.40, quantity: 100 }], []);
    orderbookState.setBook(complement.pmNoTokenId, [], [{ price: 0.80, quantity: 100 }]);

    const [discovered] = computeAllLiveArbitrages([outcome, feeBearingComplement], 100, 'sports');

    expect(discovered.arbType).toBe('cross');
    expect(discovered.pmFeeRateBps).toBe(400);
    expect(discovered.fees?.pmFee).toBeCloseTo(0.0096, 5);
    expect(discovered.expectedProfit).toBeCloseTo(0.2704, 5);
  });

  it('does not discover a cross strategy without companion Gamma fee authority', () => {
    const missingAuthority = {
      ...complement,
      pmFeesEnabled: undefined,
      pmFeeSchedule: undefined,
    };
    orderbookState.setBook(outcome.kalshiTicker,
      [{ price: 0.30, quantity: 100 }],
      [{ price: 0.80, quantity: 100 }],
    );
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.80, quantity: 100 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.80, quantity: 100 }]);
    orderbookState.setBook(complement.kalshiTicker,
      [{ price: 0.80, quantity: 100 }],
      [{ price: 0.30, quantity: 100 }],
    );
    orderbookState.setBook(complement.pmYesTokenId, [{ price: 0.40, quantity: 100 }], []);
    orderbookState.setBook(complement.pmNoTokenId, [], [{ price: 0.80, quantity: 100 }]);

    expect(computeAllLiveArbitrages([outcome, missingAuthority], 100, 'sports')
      .every((candidate) => candidate.arbType !== 'cross')).toBe(true);
  });

  it('prices a captured PM NO fee from its executable ask instead of the YES complement', () => {
    orderbookState.setBook(outcome.kalshiTicker,
      [{ price: 0.30, quantity: 100 }],
      [{ price: 0.70, quantity: 100 }],
    );
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.60, quantity: 100 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.45, quantity: 100 }]);

    const [captured] = computeCapturedLiveArbitrages([outcome], 100, 'sports', [{
      kalshiTicker: outcome.kalshiTicker,
      pmConditionId: outcome.pmConditionId,
      arbType: 'direct',
      strategy: 'Buy YES Kalshi + NO PM',
    }]);

    expect(captured.fees?.kalshiFee).toBeCloseTo(0.02, 5);
    expect(captured.fees?.pmFee).toBeCloseTo(0.01238, 5);
    expect(captured.roiPct).toBeCloseTo(21.762, 4);
  });

  it('values the captured direct direction even after the opposite direction becomes better', () => {
    orderbookState.setBook(outcome.kalshiTicker,
      [{ price: 0.40, quantity: 100 }],
      [{ price: 0.60, quantity: 100 }],
    );
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.55, quantity: 100 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.45, quantity: 100 }]);

    const best = computeAllLiveArbitrages([outcome], 100)[0];
    const [captured] = computeCapturedLiveArbitrages([outcome], 100, undefined, [{
      kalshiTicker: outcome.kalshiTicker,
      pmConditionId: outcome.pmConditionId,
      arbType: 'direct',
      strategy: 'Buy YES PM + NO Kalshi',
    }]);

    expect(best.strategy).toBe('Buy YES Kalshi + NO PM');
    expect(best.roiPct).toBeGreaterThan(0);
    expect(captured.strategy).toBe('Buy YES PM + NO Kalshi');
    expect(captured.kalshiStake + captured.pmStake).toBeGreaterThan(0);
    expect(captured.roiPct).toBeCloseTo(-18.238, 4);
  });

  it('skips a synthetic Kalshi ask below the REST floor and keeps price/depth paired', () => {
    orderbookState.setBook(outcome.kalshiTicker,
      [{ price: 0.20, quantity: 999 }, { price: 0.42, quantity: 7 }],
      [{ price: 0.55, quantity: 10 }],
    );
    orderbookState.setRealAskFloor(outcome.kalshiTicker, 0.42, 0.55);
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.44, quantity: 10 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.56, quantity: 5 }]);

    const result = computeAllLiveArbitrages([outcome], 100)[0];

    expect(result.kalshiYesAsk).toBe(0.42);
    expect(result.kalshiYesAskShares).toBe(1);
    expect(result.kalshiYesDepth).toBeCloseTo(0.42);
  });

  it('does not turn a zero-depth live quote into a direct executable stake', () => {
    orderbookState.setBook(outcome.kalshiTicker, [{ price: 0.30, quantity: 0 }], [{ price: 0.72, quantity: 0 }]);
    orderbookState.setRealAskFloor(outcome.kalshiTicker, 0.30, 0.72);
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.30, quantity: 10 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.72, quantity: 10 }]);

    const result = computeAllLiveArbitrages([outcome], 100)[0];

    expect(result.kalshiYesAsk).toBe(0.30); // quote stays visible
    expect(result.kalshiYesDepth).toBe(0);
    expect(result.strategy).toBe('No arb');
    expect(result.kalshiStake + result.pmStake).toBe(0);
  });

  it('blocks cross and same-platform candidates when a required live depth is unknown', () => {
    // Prices make every YES+YES path profitable, but the first Kalshi YES
    // quote has zero verified shares and must prevent any executable action.
    orderbookState.setBook(outcome.kalshiTicker, [{ price: 0.30, quantity: 0 }], [{ price: 0.72, quantity: 0 }]);
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.30, quantity: 0 }], []);
    orderbookState.setBook(outcome.pmNoTokenId, [], [{ price: 0.72, quantity: 10 }]);
    orderbookState.setBook(complement.kalshiTicker, [{ price: 0.30, quantity: 10 }], [{ price: 0.72, quantity: 10 }]);
    orderbookState.setBook(complement.pmYesTokenId, [{ price: 0.30, quantity: 0 }], []);
    orderbookState.setBook(complement.pmNoTokenId, [], [{ price: 0.72, quantity: 10 }]);

    const result = computeAllLiveArbitrages([outcome, complement], 100);

    expect(result[0].strategy).toBe('No arb');
    expect(result[0].kalshiStake + result[0].pmStake).toBe(0);
    expect(result[0].expectedProfit).toBe(0);
  });

  it('drops malformed and non-finite CLOB ask levels before they reach live orderbook state', () => {
    applyPolymarketBook(outcome.pmYesTokenId, [
      { price: 'Infinity', size: '10' },
      { price: '0.35', size: 'Infinity' },
      { price: '0.36junk', size: '5' },
      { price: '0x0.36', size: '5' },
      { price: '0.37', size: '0x4' },
      { price: '0.37', size: '4' },
    ]);

    expect(orderbookState.getBook(outcome.pmYesTokenId)?.yes.asks).toMatchObject([
      { price: 0.37, quantity: 4 },
    ]);
  });

  it('preserves CLOB tick, minimum order, and response timestamp for executable validation', () => {
    applyPolymarketBook(
      outcome.pmYesTokenId,
      [{ price: '0.31', size: '100' }],
      'yes',
      { tickSize: '0.01', minimumOrderSize: '5', depthTimestamp: '2026-08-14T11:02:35.000Z' },
    );

    expect(orderbookState.getExecutableQuote(outcome.pmYesTokenId, 'yes')).toMatchObject({
      status: 'non_executable',
      reason: 'below_minimum_order',
      depthTimestamp: '2026-08-14T11:02:35.000Z',
    });
  });

  it('preserves executable sub-cent CLOB ticks from decimal strings', () => {
    applyPolymarketBook(
      outcome.pmYesTokenId,
      [{ price: '0.425', size: '1' }],
      'yes',
      { tickSize: '0.001', minimumOrderSize: '1', depthTimestamp: new Date().toISOString() },
    );

    expect(orderbookState.getExecutableQuote(outcome.pmYesTokenId, 'yes')).toMatchObject({
      status: 'executable',
      vwapPriceMicroCents: 42_500_000,
      limitPriceMicroCents: 42_500_000,
    });
  });

  it('rejects non-finite and out-of-range levels at the shared orderbook boundary', () => {
    orderbookState.setBook(outcome.pmYesTokenId, [
      { price: Infinity, quantity: 5 },
      { price: 0.35, quantity: Infinity },
      { price: 1.01, quantity: 5 },
      { price: 0.35, quantity: 5 },
    ], []);

    expect(orderbookState.getBook(outcome.pmYesTokenId)?.yes.asks).toEqual([
      { price: 0.35, quantity: 5 },
    ]);
  });

  it('does not invent executable PM depth from a top-of-book update without size', () => {
    applyPmWsUpdates(
      [{ type: 'best_bid_ask', tokenId: outcome.pmYesTokenId, bestAsk: 0.35, bestBid: null, lastTradePrice: null, ts: Date.now() }],
      new Map([[outcome.pmYesTokenId, 'yes']]),
    );

    expect(orderbookState.getBook(outcome.pmYesTokenId)?.yes.asks).toEqual([]);
    expect(orderbookState.getWeightedAsk(outcome.pmYesTokenId, 'yes', 100).totalCost).toBe(0);
  });

  it('removes a stale cheaper PM level when a price-only update reports a worse best ask', () => {
    const staleDepthTimestamp = '2020-01-01T00:00:00.000Z';
    orderbookState.setBook(outcome.pmYesTokenId, [{ price: 0.30, quantity: 10 }, { price: 0.45, quantity: 8 }], [], 0, {
      tickSizeCents: 1,
      minimumOrderQuantityMicros: 1_000_000,
      depthTimestamp: staleDepthTimestamp,
    });

    applyPmWsUpdates(
      [{ type: 'best_bid_ask', tokenId: outcome.pmYesTokenId, bestAsk: 0.40, bestBid: null, lastTradePrice: null, ts: Date.now() }],
      new Map([[outcome.pmYesTokenId, 'yes']]),
    );

    expect(orderbookState.getBook(outcome.pmYesTokenId)?.yes.asks).toEqual([
      { price: 0.45, quantity: 8 },
    ]);
    expect(orderbookState.getBook(outcome.pmYesTokenId)?.depthTimestamp).toBe(staleDepthTimestamp);
    expect(orderbookState.isDepthStale(outcome.pmYesTokenId, 90_000)).toBe(true);
  });

  it('applies the first Kalshi snapshot after an early delta seeded an empty opposite side', () => {
    applyKalshiWsMessage({
      type: 'orderbook_delta',
      marketTicker: outcome.kalshiTicker,
      marketId: 'test-market',
      sid: 1,
      side: 'yes',
      price: 0.55,
      delta: 4,
      seq: 1,
      ts: Date.now(),
    });

    applyKalshiWsMessage({
      type: 'orderbook_snapshot',
      marketTicker: outcome.kalshiTicker,
      marketId: 'test-market',
      sid: 1,
      yes: [{ price: 0.45, quantity: 8 }],
      no: [{ price: 0.55, quantity: 6 }],
      seq: 2,
      ts: Date.now(),
    });

    const book = orderbookState.getBook(outcome.kalshiTicker);
    expect(book?.yes.asks).toHaveLength(1);
    expect(book?.yes.asks[0].price).toBeCloseTo(0.45);
    expect(book?.yes.asks[0].quantity).toBe(6);
    expect(book?.no.asks).toHaveLength(1);
    expect(book?.no.asks[0].price).toBeCloseTo(0.55);
    expect(book?.no.asks[0].quantity).toBe(8);
  });
});

describe('KalshiWsService reconnect tuning (BUG-104)', () => {
  it('uses reduced base/max reconnect constants', () => {
    expect(KALSHI_RECONNECT_BASE_MS).toBe(500);
    expect(KALSHI_RECONNECT_MAX_MS).toBe(15_000);
  });
});

describe('ClobWsService reconnect tuning (BUG-104)', () => {
  it('uses reduced base/max reconnect constants', () => {
    expect(CLOB_RECONNECT_BASE_MS).toBe(500);
    expect(CLOB_RECONNECT_MAX_MS).toBe(15_000);
  });
});
