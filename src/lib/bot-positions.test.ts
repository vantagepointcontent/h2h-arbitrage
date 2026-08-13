import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BotPositionStore,
  calculateBotPositionEntryCost,
  calculatePositionValuation,
  createBotPosition,
  fetchAuthoritativeBotFeeConfig,
  filterBotAnalyticsPositions,
  getKalshiResolvedPrices,
  pollOpenBotPositions,
  summarizeBotPerformance,
  summarizeBotPositions,
  type BotPosition,
} from './bot-positions';
import { calcKalshiFee, calcPolymarketFee } from './matcher';

function openPosition(overrides: Partial<BotPosition> = {}): BotPosition {
  return {
    id: 1,
    executionId: 7,
    marketId: 'pair-1',
    marketTitle: 'Test market',
    kalshiTicker: 'KXTEST',
    pmConditionId: '0xabc',
    strategy: 'Buy YES Kalshi + NO PM',
    kalshiSide: 'yes',
    pmSide: 'no',
    buyPriceKalshiCents: 45,
    buyPricePmCents: 50,
    sharesKalshi: 10,
    sharesPm: 10,
    totalCostCents: 978,
    expectedPayoutCents: 1000,
    expectedProfitCents: 22,
    feesCents: 28,
    category: 'Politics',
    pmTheta: 0.04,
    kalshiEntryFeeType: 'quadratic',
    kalshiEntryFeeMultiplierPpm: 1_000_000,
    kalshiEntryFeeSource: 'kalshi-series:KXTEST',
    kalshiEntryFeeObservedAt: '2026-08-01T00:00:00.000Z',
    kalshiEntryFeeVersion: 'series-v1',
    pmEntryTokenId: 'pm-no-token',
    pmEntryFeeRateBps: 400,
    pmEntryFeeSource: 'polymarket-clob:/fee-rate',
    pmEntryFeeObservedAt: '2026-08-01T00:00:00.000Z',
    pmEntryFeeVersion: 'clob-v1',
    kalshiEntryFeeCents: 18,
    pmEntryFeeCents: 10,
    kalshiExitFeeType: 'quadratic',
    kalshiExitFeeMultiplierPpm: 1_000_000,
    kalshiExitFeeSource: 'kalshi-series:KXTEST',
    kalshiExitFeeObservedAt: '2026-08-08T12:00:00.000Z',
    kalshiExitFeeVersion: 'series-v1',
    pmExitTokenId: 'pm-no-token',
    pmExitFeeRateBps: 400,
    pmExitFeeSource: 'polymarket-clob:/fee-rate',
    pmExitFeeObservedAt: '2026-08-08T12:00:00.000Z',
    pmExitFeeVersion: 'clob-v1',
    status: 'open',
    openedAt: '2026-08-01T00:00:00.000Z',
    expiryDate: '2026-08-10T00:00:00.000Z',
    settledAt: null,
    currentPriceKalshiCents: 45,
    currentPricePmCents: 55,
    currentValueCents: 1000,
    kalshiGrossProceedsMicrocents: 450_000_000,
    pmGrossProceedsMicrocents: 550_000_000,
    kalshiNetProceedsCents: 450,
    pmNetProceedsCents: 550,
    kalshiExitFeeCents: 0,
    pmExitFeeCents: 0,
    unrealizedPnlCents: 22,
    unrealizedRoiBps: 225,
    lastValuationAt: '2026-08-01T00:00:00.000Z',
    realizedPnlCents: null,
    settlementSide: null,
    executionMode: 'paper',
    dryRun: true,
    ...overrides,
  };
}

describe('summarizeBotPositions', () => {

  it('reconciles fee-net capital, P&L, ROI, win rate, and entry APY for one method', () => {
    const rows = [
      openPosition({ id: 1, selectionMethod: 'roi', totalCostCents: 1000, expectedProfitCents: 100, currentValueCents: 1050, unrealizedPnlCents: 50, openedAt: '2026-08-01T00:00:00.000Z', expiryDate: '2026-08-11T00:00:00.000Z' }),
      openPosition({ id: 2, selectionMethod: 'roi', status: 'settled', totalCostCents: 1000, expectedProfitCents: 100, unrealizedPnlCents: null, realizedPnlCents: 200, resolutionPayoutCents: 1200, resolutionValidationStatus: 'verified', settledAt: '2026-08-05T00:00:00.000Z', openedAt: '2026-08-01T00:00:00.000Z', expiryDate: '2026-08-11T00:00:00.000Z' }),
    ];
    expect(summarizeBotPositions(rows, new Date('2026-08-01T00:05:00.000Z'))).toEqual({
      tradeCount: 2,
      deployedCapitalCents: 2000,
      realizedPnlCents: 200,
      unrealizedPnlCents: 50,
      winRateBps: 10_000,
      averageEntryRoiBps: 1000,
      currentRoiBps: 1250,
      averageApyPct: 365,
    });
  });

  it('returns honest zero and no-data values for an empty method', () => {
    expect(summarizeBotPositions([])).toEqual({ tradeCount: 0, deployedCapitalCents: 0, realizedPnlCents: 0, unrealizedPnlCents: 0, winRateBps: 0, averageEntryRoiBps: 0, currentRoiBps: 0, averageApyPct: null });
  });

  it('excludes pending settlement P&L from verified settlement statistics', () => {
    const result = summarizeBotPositions([
      openPosition({ status: 'settled', realizedPnlCents: 200, resolutionValidationStatus: 'pending' }),
    ]);
    expect(result.realizedPnlCents).toBe(0);
    expect(result.winRateBps).toBe(0);
  });
});

describe('summarizeBotPerformance', () => {
  it('uses one fee-inclusive population for cards and chart while suppressing stale executable marks', () => {
    const rows = [
      openPosition({ id: 1, openedAt: '2026-08-10T13:00:00.000Z', totalCostCents: 978, currentValueCents: 1022, lastValuationAt: '2026-08-11T13:55:00.000Z', expectedPayoutCents: 1000 }),
      openPosition({ id: 2, openedAt: '2026-08-10T14:00:00.000Z', totalCostCents: 900, currentValueCents: 950, lastValuationAt: '2026-08-11T13:00:00.000Z', expectedPayoutCents: 1000 }),
      openPosition({ id: 3, status: 'settled', openedAt: '2026-08-11T12:00:00.000Z', settledAt: '2026-08-11T13:00:00.000Z', totalCostCents: 950, currentValueCents: 1000, realizedPnlCents: 50, resolutionPayoutCents: 1000, resolutionValidationStatus: 'verified' }),
    ];

    const result = summarizeBotPerformance(rows, new Date('2026-08-11T14:00:00.000Z'));
    expect(result.capital).toEqual({ deployedCents: 2828, currentCents: null, heldToResolutionCents: 2000 });
    expect(result.pnl).toEqual({ realizedCents: 50, unrealizedCents: null, totalCents: null, roiBps: null });
    expect(result.valuation).toEqual({ fresh: 1, stale: 1, unavailable: 0, pendingSettlement: 0, asOf: '2026-08-11T13:55:00.000Z' });
    expect(result.entryCohorts).toEqual([
      { date: '2026-08-10', deployedCents: 1878, currentCents: null, heldToResolutionCents: 2000, realizedCents: 0, unrealizedCents: null, trades: 2 },
      { date: '2026-08-11', deployedCents: 950, currentCents: 1000, heldToResolutionCents: 0, realizedCents: 50, unrealizedCents: 0, trades: 1 },
    ]);
  });

  it('distinguishes unavailable marks and does not treat unverified settlement as realized', () => {
    const result = summarizeBotPerformance([
      openPosition({ currentValueCents: null, lastValuationAt: null }),
      openPosition({ id: 2, status: 'settled', realizedPnlCents: 40, resolutionValidationStatus: 'pending' }),
    ], new Date('2026-08-11T14:00:00.000Z'));

    expect(result.valuation).toMatchObject({ fresh: 0, stale: 0, unavailable: 1, pendingSettlement: 1 });
    expect(result.pnl).toEqual({ realizedCents: 0, unrealizedCents: null, totalCents: null, roiBps: null });
  });

  it('accounts for verified closed positions and fails closed on incomplete terminal accounting', () => {
    const result = summarizeBotPerformance([
      openPosition({ id: 1, status: 'closed', totalCostCents: 900, realizedPnlCents: 100, resolutionPayoutCents: 1000, resolutionValidationStatus: 'verified' }),
      openPosition({ id: 2, status: 'settled', totalCostCents: 900, realizedPnlCents: null, resolutionPayoutCents: 1000, resolutionValidationStatus: 'verified' }),
    ]);

    expect(result.capital).toEqual({ deployedCents: 1800, currentCents: null, heldToResolutionCents: 0 });
    expect(result.pnl).toEqual({ realizedCents: 100, unrealizedCents: 0, totalCents: null, roiBps: null });
    expect(result.valuation.pendingSettlement).toBe(1);
    expect(result.entryCohorts[0]).toMatchObject({ currentCents: null, realizedCents: 100 });
  });
});

describe('filterBotAnalyticsPositions', () => {
  it('matches Dashboard rolling and server-local Today boundaries inclusively', () => {
    const now = new Date(2026, 7, 11, 14, 0, 0);
    const rows = [
      openPosition({ id: 1, openedAt: new Date(2026, 7, 11, 0, 0, 0).toISOString() }),
      openPosition({ id: 2, openedAt: new Date(2026, 7, 10, 23, 59, 59).toISOString() }),
      openPosition({ id: 3, openedAt: new Date(now.getTime() - 7 * 86_400_000).toISOString() }),
      openPosition({ id: 4, openedAt: new Date(now.getTime() - 7 * 86_400_000 - 1).toISOString() }),
    ];

    expect(filterBotAnalyticsPositions(rows, { method: 'all', range: 'today' }, now).map((row) => row.id)).toEqual([1]);
    expect(filterBotAnalyticsPositions(rows, { method: 'all', range: '7d' }, now).map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it('filters immutable selection methods and keeps only null attribution as legacy', () => {
    const rows = [
      openPosition({ id: 1, selectionMethod: 'roi' }),
      openPosition({ id: 2, selectionMethod: 'apy' }),
      openPosition({ id: 3, selectionMethod: null }),
    ];

    expect(filterBotAnalyticsPositions(rows, { method: 'roi', range: 'all' }).map((row) => row.id)).toEqual([1]);
    expect(filterBotAnalyticsPositions(rows, { method: 'legacy', range: 'all' }).map((row) => row.id)).toEqual([3]);
  });
});

describe('calculatePositionValuation', () => {
  it('rejects a stale executable observation instead of publishing it as current value or P&L', () => {
    expect(() => calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiYesBids: [{ priceCents: 48, size: 10 }],
      kalshiNoBids: [{ priceCents: 51, size: 10 }],
      pmYesBids: [{ priceCents: 42, size: 10 }],
      pmNoBids: [{ priceCents: 57, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      valuedAt: '2026-08-08T12:02:00.001Z',
      expiryDate: null,
    })).toThrow(/stale executable quote/i);
  });

  it('marks an open YES-Kalshi/NO-PM position to executable sell bids using integer cents', () => {
    const result = calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiYesBids: [{ priceCents: 48, size: 10 }],
      kalshiNoBids: [{ priceCents: 51, size: 10 }],
      pmYesBids: [{ priceCents: 42, size: 10 }],
      pmNoBids: [{ priceCents: 57, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
    });

    expect(result).toEqual({
      status: 'open',
      currentPriceKalshiCents: 48,
      currentPricePmCents: 57,
      currentValueCents: 1022,
      kalshiGrossProceedsMicrocents: 480_000_000,
      pmGrossProceedsMicrocents: 570_000_000,
      kalshiNetProceedsCents: 462,
      pmNetProceedsCents: 560,
      kalshiExitFeeCents: 18,
      pmExitFeeCents: 10,
      unrealizedPnlCents: 44,
      unrealizedRoiBps: 450,
      lastValuationAt: '2026-08-08T12:00:00.000Z',
      settledAt: null,
      realizedPnlCents: null,
      settlementSide: null,
    });
  });

  it('liquidates the full held quantity through both bid ladders and subtracts exit fees on both legs', () => {
    const result = calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 50,
      kalshiNoBidCents: 45,
      pmYesBidCents: 45,
      pmNoBidCents: 55,
      kalshiYesBids: [{ priceCents: 50.5, size: 5 }, { priceCents: 40.5, size: 5 }],
      kalshiNoBids: [{ priceCents: 45, size: 10 }],
      pmYesBids: [{ priceCents: 45, size: 10 }],
      pmNoBids: [{ priceCents: 55, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
    });

    const expectedExitFeesCents = Math.round((
      calcKalshiFee(5, 0.505)
      + calcKalshiFee(5, 0.405)
      + calcPolymarketFee(10, 0.55, 0.04)
    ) * 100);
    expect(result.currentPriceKalshiCents).toBe(46);
    expect(result.currentPricePmCents).toBe(55);
    expect(result.kalshiGrossProceedsMicrocents).toBe(455_000_000);
    expect(result.pmGrossProceedsMicrocents).toBe(550_000_000);
    expect(result.kalshiNetProceedsCents + result.pmNetProceedsCents).toBe(result.currentValueCents);
    expect(result.currentValueCents).toBe(1005 - expectedExitFeesCents);
    expect(result.unrealizedPnlCents).toBe(result.currentValueCents - 978);
    expect(result.unrealizedRoiBps).toBe(Math.round((result.unrealizedPnlCents * 10_000) / 978));
  });

  it('preserves sub-cent per-leg depth proceeds while allocating the combined rounded net exactly', () => {
    const result = calculatePositionValuation(openPosition({
      sharesKalshi: 1,
      sharesPm: 1,
      buyPriceKalshiCents: 45,
      buyPricePmCents: 50,
      totalCostCents: 95,
      expectedPayoutCents: 100,
      expectedProfitCents: 5,
      feesCents: 0,
      kalshiEntryFeeMultiplierPpm: 0,
      kalshiEntryFeeCents: 0,
      pmTheta: 0,
      pmEntryFeeRateBps: 0,
      pmEntryFeeCents: 0,
      kalshiExitFeeMultiplierPpm: 0,
      pmExitFeeRateBps: 0,
    }), {
      kalshiYesBidCents: 51,
      kalshiNoBidCents: 49,
      pmYesBidCents: 51,
      pmNoBidCents: 49,
      kalshiYesBids: [{ priceCents: 50.55, size: 1 }],
      kalshiNoBids: [{ priceCents: 49.45, size: 1 }],
      pmYesBids: [{ priceCents: 50.55, size: 1 }],
      pmNoBids: [{ priceCents: 49.45, size: 1 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    });

    expect(result.kalshiGrossProceedsMicrocents).toBe(50_550_000);
    expect(result.pmGrossProceedsMicrocents).toBe(49_450_000);
    expect(result.kalshiNetProceedsCents).toBe(51);
    expect(result.pmNetProceedsCents).toBe(49);
    expect(result.currentValueCents).toBe(100);
  });

  it('applies the Kalshi cent ceiling once after aggregating raw fees across depth levels', () => {
    const result = calculatePositionValuation(openPosition({
      sharesKalshi: 2,
      sharesPm: 2,
      totalCostCents: 194,
      expectedPayoutCents: 200,
      expectedProfitCents: 6,
      kalshiEntryFeeCents: 4,
      feesCents: 4,
      pmTheta: 0,
      pmEntryFeeRateBps: 0,
      pmEntryFeeCents: 0,
      pmExitFeeRateBps: 0,
    }), {
      kalshiYesBidCents: 20,
      kalshiNoBidCents: 80,
      pmYesBidCents: 100,
      pmNoBidCents: 100,
      kalshiYesBids: [{ priceCents: 10, size: 1 }, { priceCents: 20, size: 1 }],
      kalshiNoBids: [{ priceCents: 80, size: 2 }],
      pmYesBids: [{ priceCents: 100, size: 2 }],
      pmNoBids: [{ priceCents: 100, size: 2 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    });

    expect(result.kalshiExitFeeCents).toBe(2);
    expect(result.currentValueCents).toBe(228);
  });

  it('fails closed when top bids exist but authoritative executable ladders are missing', () => {
    expect(() => calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(/executable bid depth unavailable/i);
  });

  it.each([
    { levels: [{ priceCents: 48, size: 10 }, { priceCents: Number.NaN, size: 1 }] },
    { levels: [{ priceCents: 48, size: 10 }, { priceCents: 47, size: -1 }] },
    { levels: [{ priceCents: 48, size: 10 }, { priceCents: 101, size: 1 }] },
  ])('rejects an entire mixed valid and malformed executable ladder ($levels)', ({ levels: kalshiYesBids }) => {
    expect(() => calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiYesBids,
      kalshiNoBids: [{ priceCents: 51, size: 10 }],
      pmYesBids: [{ priceCents: 42, size: 10 }],
      pmNoBids: [{ priceCents: 57, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(/malformed executable bid depth/i);
  });

  it('rejects duplicate normalized prices instead of silently combining or discarding levels', () => {
    expect(() => calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiYesBids: [{ priceCents: 48, size: 5 }, { priceCents: 48, size: 5 }],
      kalshiNoBids: [{ priceCents: 51, size: 10 }],
      pmYesBids: [{ priceCents: 42, size: 10 }],
      pmNoBids: [{ priceCents: 57, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(/duplicate executable bid price/i);
  });

  it('reports a loss from executable proceeds below the fee-inclusive buy cost', () => {
    const result = calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 40,
      kalshiNoBidCents: 60,
      pmYesBidCents: 50,
      pmNoBidCents: 50,
      kalshiYesBids: [{ priceCents: 40, size: 10 }],
      kalshiNoBids: [{ priceCents: 60, size: 10 }],
      pmYesBids: [{ priceCents: 50, size: 10 }],
      pmNoBids: [{ priceCents: 50, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    });
    expect(result.currentValueCents).toBeLessThan(978);
    expect(result.unrealizedPnlCents).toBe(result.currentValueCents - 978);
    expect(result.unrealizedRoiBps).toBeLessThan(0);
  });

  it('fails closed when either held leg lacks enough executable bid depth', () => {
    expect(() => calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiYesBids: [{ priceCents: 48, size: 9 }],
      kalshiNoBids: [{ priceCents: 51, size: 10 }],
      pmYesBids: [{ priceCents: 42, size: 10 }],
      pmNoBids: [{ priceCents: 57, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(/insufficient executable bid depth/i);
  });

  it('fails closed when an executable bid is missing', () => {
    expect(() => calculatePositionValuation(openPosition(), {
      kalshiYesBidCents: null,
      kalshiNoBidCents: 100,
      pmYesBidCents: 100,
      pmNoBidCents: 0,
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
    })).toThrow(/missing executable/i);
  });

  it('fails closed instead of inventing a default fee theta for legacy positions', () => {
    expect(() => calculatePositionValuation(openPosition({ pmTheta: null }), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(/authoritative entry fee configuration/i);
  });

  it.each([
    { field: 'kalshiExitFeeMultiplierPpm', value: null, error: /Kalshi fee configuration/i },
    { field: 'pmExitFeeRateBps', value: null, error: /Polymarket fee configuration/i },
    { field: 'pmExitFeeRateBps', value: 500, error: /conflicting Polymarket fee configuration/i },
    { field: 'pmExitFeeObservedAt', value: '2026-08-08T11:58:00.000Z', error: /stale.*fee configuration/i },
  ])('fails valuation closed for missing, conflicting, or stale authority: $field', ({ field, value, error }) => {
    expect(() => calculatePositionValuation(openPosition({ [field]: value }), {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiYesBids: [{ priceCents: 48, size: 10 }],
      kalshiNoBids: [{ priceCents: 51, size: 10 }],
      pmYesBids: [{ priceCents: 42, size: 10 }],
      pmNoBids: [{ priceCents: 57, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(error);
  });

  it('settles only after expiry when held-side prices are exactly 100 and 0 cents without double-counting persisted entry fees', () => {
    const result = calculatePositionValuation(openPosition({ feesCents: 28 }), {
      kalshiYesBidCents: 100,
      kalshiNoBidCents: 0,
      pmYesBidCents: 100,
      pmNoBidCents: 0,
      observedAt: '2026-08-11T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      kalshiResolved: true,
      pmResolved: true,
    });

    expect(result.status).toBe('settled');
    expect(result.currentValueCents).toBe(1000);
    expect(result.realizedPnlCents).toBe(22);
    expect(result.settlementSide).toBe('kalshi');
    expect(result.settledAt).toBe('2026-08-11T12:00:00.000Z');
  });

  it('fails settlement closed when persisted entry authority or fee economics are malformed', () => {
    expect(() => calculatePositionValuation(openPosition({ kalshiEntryFeeMultiplierPpm: null }), {
      kalshiYesBidCents: 100,
      kalshiNoBidCents: 0,
      pmYesBidCents: 100,
      pmNoBidCents: 0,
      observedAt: '2026-08-11T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      kalshiResolved: true,
      pmResolved: true,
    })).toThrow(/authoritative entry fee configuration/i);
  });

  it('does not settle contradictory resolution prices', () => {
    const result = calculatePositionValuation(openPosition({
      kalshiExitFeeObservedAt: '2026-08-11T12:00:00.000Z',
      pmExitFeeObservedAt: '2026-08-11T12:00:00.000Z',
    }), {
      kalshiYesBidCents: 100,
      kalshiNoBidCents: 0,
      pmYesBidCents: 0,
      pmNoBidCents: 100,
      kalshiYesBids: [{ priceCents: 100, size: 10 }],
      kalshiNoBids: [{ priceCents: 1, size: 10 }],
      pmYesBids: [{ priceCents: 1, size: 10 }],
      pmNoBids: [{ priceCents: 100, size: 10 }],
      observedAt: '2026-08-11T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      kalshiResolved: true,
      pmResolved: true,
    });
    expect(result.status).toBe('open');
  });

  it('uses authoritative Kalshi settlement value when finalized books have no bids', () => {
    const kalshiResolution = getKalshiResolvedPrices({
      status: 'settled',
      settlement_value_dollars: '1.0000',
      yes_bid_dollars: undefined,
      no_bid_dollars: undefined,
    });
    expect(kalshiResolution).toEqual({ yesBidCents: 100, noBidCents: 0, resolved: true });

    const result = calculatePositionValuation(openPosition({ feesCents: 28 }), {
      kalshiYesBidCents: kalshiResolution.yesBidCents,
      kalshiNoBidCents: kalshiResolution.noBidCents,
      pmYesBidCents: 100,
      pmNoBidCents: 0,
      observedAt: '2026-08-11T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      kalshiResolved: kalshiResolution.resolved,
      pmResolved: true,
    });

    expect(result.status).toBe('settled');
    expect(result.settlementSide).toBe('kalshi');
    expect(result.realizedPnlCents).toBe(22);
  });
});

describe('calculateBotPositionEntryCost', () => {
  it('persists Buy Cost as both acquisition legs plus both entry execution fees', () => {
    const result = calculateBotPositionEntryCost({
      buyPriceKalshiCents: 45.1,
      buyPricePmCents: 50,
      sharesKalshi: 10,
      sharesPm: 10,
      pmTheta: 0.04,
      kalshiFeeMultiplierPpm: 1_000_000,
      pmFeeRateBps: 400,
    });
    const expectedKalshiFee = Math.round(calcKalshiFee(10, 0.451) * 100);
    const expectedPmFee = Math.round(calcPolymarketFee(10, 0.50, 0.04) * 100);
    expect(result.kalshiEntryFeeCents).toBe(expectedKalshiFee);
    expect(result.pmEntryFeeCents).toBe(expectedPmFee);
    expect(result.totalCostCents).toBe(451 + 500 + expectedKalshiFee + expectedPmFee);
  });

  it('uses non-default authoritative Kalshi multipliers and fee-free Polymarket tokens', () => {
    const result = calculateBotPositionEntryCost({
      buyPriceKalshiCents: 45.1,
      buyPricePmCents: 50,
      sharesKalshi: 10,
      sharesPm: 10,
      pmTheta: 0,
      kalshiFeeMultiplierPpm: 500_000,
      pmFeeRateBps: 0,
    });
    expect(result.kalshiEntryFeeCents).toBe(9);
    expect(result.pmEntryFeeCents).toBe(0);
    expect(result.totalCostCents).toBe(960);
  });
});

describe('fetchAuthoritativeBotFeeConfig', () => {
  it('runtime-validates and returns auditable non-default and fee-free venue authority', async () => {
    const result = await fetchAuthoritativeBotFeeConfig({
      kalshiTicker: 'KXTEST-YES',
      pmConditionId: '0xcondition',
      pmSide: 'no',
      category: 'Geopolitics',
      observedAt: '2026-08-08T12:00:00.000Z',
    }, {
      fetchJson: async (url) => {
        if (url.includes('/markets/')) return { market: { event_ticker: 'KXTEST-EVENT' } };
        if (url.includes('/events/')) return { event: { series_ticker: 'KXTEST', last_updated_ts: 'event-v1' } };
        if (url.includes('/series/')) return { series: { fee_type: 'quadratic', fee_multiplier: 0.5, last_updated_ts: 'series-v2' } };
        if (url.includes('/fee-rate')) return { base_fee: 0 };
        throw new Error(`Unexpected URL ${url}`);
      },
      fetchPmMarket: async () => ({
        tokens: [
          { token_id: 'yes-token', outcome: 'Yes' },
          { token_id: 'no-token', outcome: 'No' },
        ],
      }),
    });

    expect(result).toEqual({
      kalshi: {
        feeType: 'quadratic',
        feeMultiplierPpm: 500_000,
        source: 'https://external-api.kalshi.com/trade-api/v2/series/KXTEST',
        observedAt: '2026-08-08T12:00:00.000Z',
        version: 'quadratic:500000:series-v2',
      },
      polymarket: {
        tokenId: 'no-token',
        feeRateBps: 0,
        source: 'https://clob.polymarket.com/fee-rate?token_id=no-token|matcher-category-theta:geopolitics',
        observedAt: '2026-08-08T12:00:00.000Z',
        version: 'token-fee-rate:0|matcher-category-theta-v1:0',
      },
      pmTheta: 0,
    });
  });

  it('fails closed when token fee authority conflicts with the category theta', async () => {
    await expect(fetchAuthoritativeBotFeeConfig({
      kalshiTicker: 'KXTEST-YES',
      pmConditionId: '0xcondition',
      pmSide: 'no',
      category: 'Politics',
      observedAt: '2026-08-08T12:00:00.000Z',
    }, {
      fetchJson: async (url) => {
        if (url.includes('/markets/')) return { market: { event_ticker: 'KXTEST-EVENT' } };
        if (url.includes('/events/')) return { event: { series_ticker: 'KXTEST' } };
        if (url.includes('/series/')) return { series: { fee_type: 'quadratic', fee_multiplier: 1 } };
        return { base_fee: 500 };
      },
      fetchPmMarket: async () => ({ tokens: [{ token_id: 'no-token', outcome: 'No' }] }),
    })).rejects.toThrow(/conflicting authoritative Polymarket/i);
  });
});

describe('BotPositionStore', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('creates the full table without inventing an executable mark and prevents duplicate open pairs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1), (8, 0)`);
    client.close();

    const store = new BotPositionStore(dbUrl);
    const created = await store.create({
      executionId: 7,
      marketId: 'pair-1',
      marketTitle: 'Test market',
      kalshiTicker: 'KXTEST',
      pmConditionId: '0xabc',
      strategy: 'Buy YES Kalshi + NO PM',
      kalshiSide: 'yes',
      pmSide: 'no',
      buyPriceKalshiCents: 45,
      buyPricePmCents: 50,
      sharesKalshi: 10,
      sharesPm: 10,
      totalCostCents: 978,
      expectedPayoutCents: 1000,
      expectedProfitCents: 22,
      feesCents: 28,
      category: 'Politics',
      pmTheta: 0.04,
      kalshiEntryFeeType: 'quadratic',
      kalshiEntryFeeMultiplierPpm: 1_000_000,
      kalshiEntryFeeSource: 'kalshi-series:KXTEST',
      kalshiEntryFeeObservedAt: '2026-08-08T12:00:00.000Z',
      kalshiEntryFeeVersion: 'series-v1',
      pmEntryTokenId: 'pm-no-token',
      pmEntryFeeRateBps: 400,
      pmEntryFeeSource: 'polymarket-clob:/fee-rate',
      pmEntryFeeObservedAt: '2026-08-08T12:00:00.000Z',
      pmEntryFeeVersion: 'clob-v1',
      kalshiEntryFeeCents: 18,
      pmEntryFeeCents: 10,
      kalshiExitFeeType: 'quadratic',
      kalshiExitFeeMultiplierPpm: 1_000_000,
      kalshiExitFeeSource: 'kalshi-series:KXTEST',
      kalshiExitFeeObservedAt: '2026-08-08T12:00:00.000Z',
      kalshiExitFeeVersion: 'series-v1',
      pmExitTokenId: 'pm-no-token',
      pmExitFeeRateBps: 400,
      pmExitFeeSource: 'polymarket-clob:/fee-rate',
      pmExitFeeObservedAt: '2026-08-08T12:00:00.000Z',
      pmExitFeeVersion: 'clob-v1',
      openedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      selectionMethod: 'hybrid',
      executionMode: 'paper',
    });

    expect(created.currentPriceKalshiCents).toBeNull();
    expect(created.currentPricePmCents).toBeNull();
    expect(created.currentValueCents).toBeNull();
    expect(created.unrealizedPnlCents).toBeNull();
    expect(created.unrealizedRoiBps).toBeNull();
    expect(created.lastValuationAt).toBeNull();
    expect(created.dryRun).toBe(true);
    expect(created.selectionMethod).toBe('hybrid');
    expect(created.kalshiEntryFeeMultiplierPpm).toBe(1_000_000);
    expect(created.pmEntryFeeRateBps).toBe(400);
    expect(created.pmEntryTokenId).toBe('pm-no-token');
    await expect(store.hasOpenPair('KXTEST', '0xabc', 'paper')).resolves.toBe(true);
    await expect(store.hasOpenPair('KXTEST', '0xabc', 'live')).resolves.toBe(false);
    await expect(store.create({ ...created, id: undefined } as never)).rejects.toThrow(/open bot position/i);
    const live = await store.create({
      ...created,
      id: undefined,
      executionId: 8,
      executionMode: 'live',
    } as never);
    expect(live.executionMode).toBe('live');
    await expect(store.create({ ...live, id: undefined } as never)).rejects.toThrow(/open bot position/i);
    await expect(store.create({
      ...created,
      id: undefined,
      kalshiTicker: 'KXTEST2',
      pmConditionId: '0xdef',
      kalshiEntryFeeMultiplierPpm: null,
    } as never)).rejects.toThrow(/entry fee configuration/i);

    const columnsClient = createClient({ url: dbUrl });
    const columns = await columnsClient.execute('PRAGMA table_info(bot_positions)');
    columnsClient.close();
    expect(columns.rows.map((row) => String(row.name))).toEqual(expect.arrayContaining([
      'execution_id', 'buy_price_kalshi', 'buy_price_pm', 'current_value',
      'kalshi_gross_proceeds_microcents', 'pm_gross_proceeds_microcents',
      'kalshi_net_proceeds', 'pm_net_proceeds',
      'unrealized_pnl', 'unrealized_roi_pct', 'realized_pnl', 'settlement_side', 'selection_method',
      'kalshi_entry_fee_multiplier_ppm', 'pm_entry_fee_rate_bps', 'pm_entry_token_id',
      'kalshi_exit_fee_multiplier_ppm', 'pm_exit_fee_rate_bps', 'pm_exit_token_id',
    ]));
  });

  it('migrates legacy rows with null fee authority so they fail valuation closed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-legacy-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1)`);
    await client.execute(`CREATE TABLE bot_positions (id INTEGER PRIMARY KEY, execution_id INTEGER)`);
    await client.execute(`INSERT INTO bot_positions (id, execution_id) VALUES (1, 7)`);
    client.close();

    const store = new BotPositionStore(dbUrl);
    const [legacy] = await store.list({ status: 'all' });
    expect(legacy.kalshiEntryFeeMultiplierPpm).toBeNull();
    expect(legacy.pmEntryFeeRateBps).toBeNull();
    expect(legacy.kalshiExitFeeMultiplierPpm).toBeNull();
    expect(legacy.pmExitFeeRateBps).toBeNull();
    expect(legacy.kalshiGrossProceedsMicrocents).toBeNull();
    expect(legacy.pmGrossProceedsMicrocents).toBeNull();
    expect(legacy.kalshiNetProceedsCents).toBeNull();
    expect(legacy.pmNetProceedsCents).toBeNull();
    expect(() => calculatePositionValuation({
      ...legacy,
      sharesKalshi: 1,
      sharesPm: 1,
      pmTheta: 0.04,
      kalshiSide: 'yes',
      pmSide: 'no',
    }, {
      kalshiYesBidCents: 50,
      kalshiNoBidCents: 50,
      pmYesBidCents: 50,
      pmNoBidCents: 50,
      kalshiYesBids: [{ priceCents: 50, size: 1 }],
      pmNoBids: [{ priceCents: 50, size: 1 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).toThrow(/authoritative entry fee configuration/i);
    store.close();
  });

  it('allows paper and live reservations for the same normalized venue pair', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    client.close();
    const store = new BotPositionStore(dbUrl);

    await expect(store.reservePair('KXTEST', '0xAbC', 'paper')).resolves.toBe(true);
    await expect(store.reservePair('kxtest', '0xabc', 'live')).resolves.toBe(true);
    await expect(store.reservePair('KXTEST', '0xABC', 'paper')).resolves.toBe(false);
    await expect(store.reservePair('KXTEST', '0xABC', 'live')).resolves.toBe(false);
    store.close();
  });

  it('treats different Polymarket conditions as distinct pairs for the same Kalshi ticker', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    client.close();
    const store = new BotPositionStore(dbUrl);

    await expect(store.reservePair('KXTEST', '0xabc', 'paper')).resolves.toBe(true);
    await expect(store.reservePair('KXTEST', '0xdef', 'paper')).resolves.toBe(true);
    store.close();
  });

  it('atomically rejects same-mode reservations across concurrent clients', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    client.close();
    const first = new BotPositionStore(dbUrl);
    const second = new BotPositionStore(dbUrl);

    const results = await Promise.all([
      first.reservePair('KXTEST', '0xAbC', 'live'),
      second.reservePair('kxtest', '0xabc', 'live'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    await first.releasePair('KXTEST', '0xABC', 'live');
    await expect(second.reservePair('kxtest', '0xabc', 'live')).resolves.toBe(true);
    first.close();
    second.close();
  });

  it('does not expire a reservation protecting known unpersisted exposure', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    client.close();
    const store = new BotPositionStore(dbUrl);

    await expect(store.reservePair('KXTEST', '0xabc', 'paper')).resolves.toBe(true);
    await store.retainPairForExposure('KXTEST', '0xabc', 'paper');
    const agingClient = createClient({ url: dbUrl });
    await agingClient.execute(`UPDATE bot_position_reservations SET reserved_at = '2000-01-01T00:00:00.000Z'`);
    agingClient.close();

    await expect(store.reservePair('kxtest', '0xABC', 'paper')).resolves.toBe(false);
    await expect(store.reservePair('kxtest', '0xABC', 'live')).resolves.toBe(true);
    store.close();
  });

  it('migrates legacy reservations to paper without blocking live mode', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-reservation-legacy-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`CREATE TABLE bot_position_reservations (
      pair_key TEXT PRIMARY KEY,
      reserved_at TEXT NOT NULL,
      exposure_at_risk INTEGER NOT NULL DEFAULT 0
    )`);
    await client.execute({
      sql: `INSERT INTO bot_position_reservations (pair_key, reserved_at, exposure_at_risk) VALUES (?, ?, 1)`,
      args: ['kxtest\u00000xabc', '2026-08-11T12:00:00.000Z'],
    });
    client.close();

    const store = new BotPositionStore(dbUrl);
    await expect(store.reservePair('KXTEST', '0xABC', 'paper')).resolves.toBe(false);
    await expect(store.reservePair('KXTEST', '0xABC', 'live')).resolves.toBe(true);

    const migrated = createClient({ url: dbUrl });
    const rows = await migrated.execute(`SELECT pair_key, execution_mode, exposure_at_risk FROM bot_position_reservations ORDER BY execution_mode`);
    expect(rows.rows).toMatchObject([
      { pair_key: 'kxtest', execution_mode: 'live', exposure_at_risk: 0 },
      { pair_key: 'kxtest', execution_mode: 'paper', exposure_at_risk: 1 },
    ]);
    migrated.close();
    store.close();
  });

  it('updates a persisted open position with valuation and settlement output', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 0)`);
    client.close();
    const store = new BotPositionStore(dbUrl);
    const created = await store.create({
      ...openPosition(),
      kalshiExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
      pmExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
      id: undefined,
      dryRun: undefined,
      executionMode: 'live',
    } as never);
    const currentKalshiFee = {
      feeType: 'quadratic',
      feeMultiplierPpm: 1_000_000,
      source: 'kalshi-series:KXTEST',
      observedAt: '2026-08-08T12:00:00.000Z',
      version: 'series-v1',
    } as const;
    const currentPmFee = {
      tokenId: 'pm-no-token',
      feeRateBps: 400,
      source: 'polymarket-clob:/fee-rate',
      observedAt: '2026-08-08T12:00:00.000Z',
      version: 'clob-v1',
    } as const;
    const refreshed: BotPosition = {
      ...created,
      kalshiExitFeeType: currentKalshiFee.feeType,
      kalshiExitFeeMultiplierPpm: currentKalshiFee.feeMultiplierPpm,
      kalshiExitFeeSource: currentKalshiFee.source,
      kalshiExitFeeObservedAt: currentKalshiFee.observedAt,
      kalshiExitFeeVersion: currentKalshiFee.version,
      pmExitTokenId: currentPmFee.tokenId,
      pmExitFeeRateBps: currentPmFee.feeRateBps,
      pmExitFeeSource: currentPmFee.source,
      pmExitFeeObservedAt: currentPmFee.observedAt,
      pmExitFeeVersion: currentPmFee.version,
    };

    const valuation = calculatePositionValuation(refreshed, {
      kalshiYesBidCents: 48,
      kalshiNoBidCents: 51,
      pmYesBidCents: 42,
      pmNoBidCents: 57,
      kalshiYesBids: [{ priceCents: 48, size: 10 }],
      kalshiNoBids: [{ priceCents: 51, size: 10 }],
      pmYesBids: [{ priceCents: 42, size: 10 }],
      pmNoBids: [{ priceCents: 57, size: 10 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
    });
    await store.updateValuationWithFeeConfig(created.id, valuation, currentKalshiFee, currentPmFee);
    await store.clearOpenValuation(created.id, '2026-08-08T11:59:00.000Z');
    await store.updateValuationWithFeeConfig(created.id, {
      ...valuation,
      currentValueCents: 1,
      unrealizedPnlCents: -977,
      lastValuationAt: '2026-08-08T11:58:00.000Z',
    }, { ...currentKalshiFee, source: 'stale-kalshi', observedAt: '2026-08-08T11:58:00.000Z' },
    { ...currentPmFee, source: 'stale-pm', observedAt: '2026-08-08T11:58:00.000Z' });

    const [stored] = await store.list({ status: 'open', limit: 10 });
    expect(stored.currentValueCents).toBe(1022);
    expect(stored.kalshiGrossProceedsMicrocents).toBe(480_000_000);
    expect(stored.pmGrossProceedsMicrocents).toBe(570_000_000);
    expect(stored.kalshiNetProceedsCents).toBe(462);
    expect(stored.pmNetProceedsCents).toBe(560);
    expect(stored.unrealizedPnlCents).toBe(44);
    expect(stored.kalshiExitFeeSource).toBe('kalshi-series:KXTEST');
    expect(stored.pmExitFeeSource).toBe('polymarket-clob:/fee-rate');
    expect(stored.dryRun).toBe(false);
  });
});

describe('pollOpenBotPositions fail-closed valuation', () => {
  it('clears prior marks at each malformed, shallow, or stale depth observation timestamp', async () => {
    const previousCwd = process.cwd();
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-poller-'));
    try {
      process.chdir(dir);
      await mkdir(path.join(dir, 'data'));
      const dbUrl = `file:${path.join(dir, 'data', 'edgefinder.db')}`;
      const client = createClient({ url: dbUrl });
      await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
      await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1)`);
      client.close();
      const created = await createBotPosition({
        ...openPosition(),
        kalshiExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
        pmExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
        id: undefined,
        dryRun: undefined,
      } as never);

      const runAttempt = async (
        attemptedAt: string,
        kalshiYesBids: Array<{ priceCents: number; size: number }>,
        depthObservedAt = attemptedAt,
      ) => pollOpenBotPositions({
        observedAt: attemptedAt,
        fetchKalshi: async () => ({
          yes_bid_dollars: '0.48',
          no_bid_dollars: '0.51',
          close_time: '2026-08-10T00:00:00.000Z',
          status: 'open',
        }),
        fetchKalshiBids: async () => ({
          yesBids: kalshiYesBids,
          noBids: [{ priceCents: 51, size: 10 }],
          observedAt: depthObservedAt,
        }),
        fetchPmBids: async () => ({
          yesBidCents: 42,
          noBidCents: 57,
          yesBids: [{ priceCents: 42, size: 10 }],
          noBids: [{ priceCents: 57, size: 10 }],
          resolved: false,
          observedAt: attemptedAt,
        }),
        fetchFeeConfig: async () => ({
          kalshi: {
            feeType: 'quadratic',
            feeMultiplierPpm: 1_000_000,
            source: 'kalshi-series:KXTEST',
            observedAt: attemptedAt,
            version: 'series-v1',
          },
          polymarket: {
            tokenId: 'pm-no-token',
            feeRateBps: 400,
            source: 'polymarket-clob:/fee-rate',
            observedAt: attemptedAt,
            version: 'clob-v1',
          },
          pmTheta: 0.04,
        }),
      });
      const setPriorMark = async () => {
        const db = createClient({ url: dbUrl });
        await db.execute({
          sql: `UPDATE bot_positions SET current_price_kalshi = 48, current_price_pm = 57,
            current_value = 1000,
            kalshi_gross_proceeds_microcents = 480000000, pm_gross_proceeds_microcents = 570000000,
            kalshi_net_proceeds = 480, pm_net_proceeds = 520,
            unrealized_pnl = 50, unrealized_roi_pct = 526 WHERE id = ?`,
          args: [created.id],
        });
        db.close();
      };
      const expectClearedAt = async (attemptedAt: string) => {
        const db = createClient({ url: dbUrl });
        const row = (await db.execute({ sql: 'SELECT * FROM bot_positions WHERE id = ?', args: [created.id] })).rows[0];
        db.close();
        expect(row.current_price_kalshi).toBeNull();
        expect(row.current_price_pm).toBeNull();
        expect(row.current_value).toBeNull();
        expect(row.kalshi_gross_proceeds_microcents).toBeNull();
        expect(row.pm_gross_proceeds_microcents).toBeNull();
        expect(row.kalshi_net_proceeds).toBeNull();
        expect(row.pm_net_proceeds).toBeNull();
        expect(row.unrealized_pnl).toBeNull();
        expect(row.unrealized_roi_pct).toBeNull();
        expect(row.last_valuation_at).toBe(attemptedAt);
      };

      await setPriorMark();
      await expect(runAttempt('2026-08-08T12:00:00.000Z', [
        { priceCents: 48, size: 10 },
        { priceCents: Number.NaN, size: 1 },
      ])).resolves.toMatchObject({ updated: 0, errors: [{ id: created.id }] });
      await expectClearedAt('2026-08-08T12:00:00.000Z');

      await setPriorMark();
      await expect(runAttempt('2026-08-08T12:01:00.000Z', [{ priceCents: 48, size: 9 }]))
        .resolves.toMatchObject({ updated: 0, errors: [{ id: created.id }] });
      await expectClearedAt('2026-08-08T12:01:00.000Z');

      await setPriorMark();
      await expect(runAttempt(
        '2026-08-08T12:02:00.000Z',
        [{ priceCents: 48, size: 10 }],
        '2026-08-08T12:00:00.000Z',
      )).resolves.toMatchObject({ updated: 0, errors: [{ id: created.id }] });
      await expectClearedAt('2026-08-08T12:02:00.000Z');

      let kalshiBookRequested = false;
      let feeAuthorityRequested = false;
      await expect(pollOpenBotPositions({
        observedAt: '2026-08-11T12:00:00.000Z',
        fetchKalshi: async () => ({
          close_time: '2026-08-10T00:00:00.000Z',
          status: 'settled',
          settlement_value_dollars: '1.0000',
        }),
        fetchKalshiBids: async () => {
          kalshiBookRequested = true;
          throw new Error('resolved Kalshi market must not require a book');
        },
        fetchPmBids: async () => ({
          yesBidCents: 100,
          noBidCents: 0,
          resolved: true,
          observedAt: '2026-08-11T12:00:00.000Z',
        }),
        fetchFeeConfig: async () => {
          feeAuthorityRequested = true;
          throw new Error('settlement must not require exit fee authority');
        },
      })).resolves.toMatchObject({ updated: 1, settled: 1, errors: [] });
      expect(kalshiBookRequested).toBe(false);
      expect(feeAuthorityRequested).toBe(false);
    } finally {
      process.chdir(previousCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
