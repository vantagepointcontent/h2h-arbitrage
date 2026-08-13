import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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

  it('makes method deployed capital and entry ROI unavailable when any entry cost is unavailable', () => {
    const result = summarizeBotPositions([
      openPosition({ totalCostCents: 978 }),
      openPosition({ id: 2, totalCostCents: 9626, entryCostStatus: 'unavailable' }),
    ]);
    expect(result.deployedCapitalCents).toBeNull();
    expect(result.averageEntryRoiBps).toBeNull();
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
  it('does not treat a legacy position with unavailable authoritative entry cost as zero deployed capital', () => {
    const result = summarizeBotPerformance([
      openPosition({ entryCostStatus: 'unavailable', entryCostFailureReason: 'Legacy position lacks authoritative entry fill breakdown' }),
    ], new Date('2026-08-11T14:00:00.000Z'));

    expect(result.capital.deployedCents).toBeNull();
    expect(result.entryCost).toEqual({ available: 0, unavailable: 1 });
    expect(result.entryCohorts[0].deployedCents).toBeNull();
  });

  it('uses one fee-inclusive population for cards and chart while suppressing stale executable marks', () => {
    const rows = [
      openPosition({ id: 1, openedAt: '2026-08-10T13:00:00.000Z', totalCostCents: 978, currentValueCents: 1022, lastValuationAt: '2026-08-11T13:55:00.000Z', expectedPayoutCents: 1000 }),
      openPosition({ id: 2, openedAt: '2026-08-10T14:00:00.000Z', totalCostCents: 900, currentValueCents: 950, lastValuationAt: '2026-08-11T13:00:00.000Z', expectedPayoutCents: 1000 }),
      openPosition({ id: 3, status: 'settled', openedAt: '2026-08-11T12:00:00.000Z', settledAt: '2026-08-11T13:00:00.000Z', totalCostCents: 950, currentValueCents: 1000, realizedPnlCents: 50, resolutionPayoutCents: 1000, resolutionValidationStatus: 'verified' }),
    ];

    const result = summarizeBotPerformance(rows, new Date('2026-08-11T14:00:00.000Z'));
    expect(result.capital).toEqual({ deployedCents: 2828, currentCents: 2022, heldToResolutionCents: 2000, excludedOpenCostCents: 900 });
    expect(result.pnl).toEqual({ realizedCents: 50, unrealizedCents: 44, totalCents: 94, roiBps: 488 });
    expect(result.valuation).toEqual({ fresh: 1, stale: 1, unavailable: 0, pendingSettlement: 0, asOf: '2026-08-11T13:55:00.000Z' });
    expect(result.entryCohorts).toEqual([
      { date: '2026-08-10', deployedCents: 1878, currentCents: 1022, heldToResolutionCents: 2000, realizedCents: 0, unrealizedCents: 44, trades: 2 },
      { date: '2026-08-11', deployedCents: 950, currentCents: 1000, heldToResolutionCents: 0, realizedCents: 50, unrealizedCents: 0, trades: 1 },
    ]);
  });

  it('distinguishes unavailable marks and does not treat unverified settlement as realized', () => {
    const result = summarizeBotPerformance([
      openPosition({ currentValueCents: null, lastValuationAt: null }),
      openPosition({ id: 2, status: 'settled', realizedPnlCents: 40, resolutionValidationStatus: 'pending' }),
    ], new Date('2026-08-11T14:00:00.000Z'));

    expect(result.valuation).toMatchObject({ fresh: 0, stale: 0, unavailable: 1, pendingSettlement: 1 });
    expect(result.capital.excludedOpenCostCents).toBe(978);
    expect(result.pnl).toEqual({ realizedCents: 0, unrealizedCents: 0, totalCents: null, roiBps: null });
  });

  it('accounts for verified closed positions and fails closed on incomplete terminal accounting', () => {
    const result = summarizeBotPerformance([
      openPosition({ id: 1, status: 'closed', totalCostCents: 900, realizedPnlCents: 100, resolutionPayoutCents: 1000, resolutionValidationStatus: 'verified' }),
      openPosition({ id: 2, status: 'settled', totalCostCents: 900, realizedPnlCents: null, resolutionPayoutCents: 1000, resolutionValidationStatus: 'verified' }),
    ]);

    expect(result.capital).toEqual({ deployedCents: 1800, currentCents: 1000, heldToResolutionCents: 0, excludedOpenCostCents: 0 });
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
  it('uses venue-reported execution fees exactly once instead of recomputing configured fees', () => {
    const result = calculateBotPositionEntryCost({
      kalshiFills: [{ priceCents: 5.5, size: 1 }, { priceCents: 6.5, size: 1 }],
      pmFills: [{ priceCents: 91.25, size: 1 }, { priceCents: 92.75, size: 1 }],
      kalshiChargedFeeCents: 7,
      pmChargedFeeCents: 3,
      pmTheta: 0.04,
      kalshiFeeMultiplierPpm: 1_000_000,
      pmFeeRateBps: 400,
    });
    expect(result.kalshiEntryFeeCents).toBe(7);
    expect(result.pmEntryFeeCents).toBe(3);
    expect(result.totalCostCents).toBe(206);
  });

  it('reconciles multiple exact fills, fractional-cent gross, Kalshi aggregate rounding, and Polymarket fees', () => {
    const result = calculateBotPositionEntryCost({
      kalshiFills: [{ priceCents: 5.5, size: 1 }, { priceCents: 6.5, size: 1 }],
      pmFills: [{ priceCents: 91.25, size: 1 }, { priceCents: 92.75, size: 1 }],
      pmTheta: 0.04,
      kalshiFeeMultiplierPpm: 1_000_000,
      pmFeeRateBps: 400,
    });

    expect(result.kalshiGrossEntryMicrocents).toBe(12_000_000);
    expect(result.pmGrossEntryMicrocents).toBe(184_000_000);
    // Kalshi aggregates the two fractional raw fees before one venue ceiling.
    expect(result.kalshiEntryFeeCents).toBe(1);
    expect(result.pmEntryFeeCents).toBe(1);
    expect(result.totalCostCents).toBe(198);
    expect(result.roundingDeltaMicrocents).toBe(0);
  });

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
        source: 'https://clob.polymarket.com/fee-rate?token_id=no-token',
        observedAt: '2026-08-08T12:00:00.000Z',
        version: 'token-fee-rate:0',
      },
      pmTheta: 0,
    });
  });

  it('uses the current token fee rate instead of stale category assumptions', async () => {
    const result = await fetchAuthoritativeBotFeeConfig({
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
    });
    expect(result.pmTheta).toBe(0.05);
    expect(result.polymarket).toMatchObject({ feeRateBps: 500, tokenId: 'no-token' });
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
      kalshiTicker: 'KXTEST-LIVE',
      pmConditionId: '0xlive',
      buyPriceKalshiCents: 6,
      buyPricePmCents: 92,
      sharesKalshi: 2,
      sharesPm: 2,
      totalCostCents: 206,
      kalshiEntryGrossMicrocents: 12_000_000,
      pmEntryGrossMicrocents: 184_000_000,
      entryCostRoundingDeltaMicrocents: 0,
      kalshiEntryFillCount: 2,
      pmEntryFillCount: 2,
      expectedPayoutCents: 200,
      expectedProfitCents: -6,
      feesCents: 10,
      kalshiEntryFeeCents: 7,
      pmEntryFeeCents: 3,
    } as never);
    expect(live.executionMode).toBe('live');
    expect(live.remainingOpenPrincipalCents).toBe(196);
    expect(live.kalshiEntryFillCount).toBe(2);
    expect(live.pmEntryFillCount).toBe(2);
    expect(() => calculatePositionValuation(live, {
      kalshiYesBidCents: 6,
      kalshiNoBidCents: 94,
      pmYesBidCents: 8,
      pmNoBidCents: 92,
      kalshiYesBids: [{ priceCents: 6, size: 2 }],
      pmNoBids: [{ priceCents: 92, size: 2 }],
      observedAt: '2026-08-08T12:00:00.000Z',
      expiryDate: null,
    })).not.toThrow();
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
    expect(legacy.entryCostStatus).toBe('unavailable');
    expect(legacy.entryCostFailureReason).toMatch(/legacy position lacks authoritative entry fill and fee data/i);
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

  it('does not invent authoritative fills from reconciling legacy prices and fee metadata', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-legacy-fees-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1)`);
    await client.execute(`CREATE TABLE bot_positions (
      id INTEGER PRIMARY KEY,
      execution_id INTEGER,
      buy_price_kalshi INTEGER NOT NULL,
      buy_price_pm INTEGER NOT NULL,
      shares_kalshi INTEGER NOT NULL,
      shares_pm INTEGER NOT NULL,
      kalshi_entry_fee_type TEXT,
      kalshi_entry_fee_multiplier_ppm INTEGER,
      pm_entry_fee_rate_bps INTEGER,
      kalshi_entry_fee INTEGER NOT NULL,
      pm_entry_fee INTEGER NOT NULL,
      fees INTEGER NOT NULL,
      total_cost INTEGER NOT NULL,
      entry_cost_status TEXT NOT NULL,
      entry_cost_failure_reason TEXT
    )`);
    await client.execute(`INSERT INTO bot_positions (
      id, execution_id, buy_price_kalshi, buy_price_pm, shares_kalshi, shares_pm,
      kalshi_entry_fee_type, kalshi_entry_fee_multiplier_ppm, pm_entry_fee_rate_bps,
      kalshi_entry_fee, pm_entry_fee, fees, total_cost,
      entry_cost_status, entry_cost_failure_reason
    ) VALUES (1, 7, 6, 92, 1, 1, 'quadratic', 1000000, 0, 1, 0, 1, 99,
      'unavailable', NULL)`);
    client.close();

    const store = new BotPositionStore(dbUrl);
    const [legacy] = await store.list({ status: 'all' });

    expect(legacy.entryCostStatus).toBe('unavailable');
    expect(legacy.entryCostFailureReason).toMatch(/legacy position lacks authoritative entry fill and fee data/i);
    expect(legacy.kalshiEntryGrossMicrocents).toBeNull();
    expect(legacy.pmEntryGrossMicrocents).toBeNull();
    expect(legacy.kalshiEntryFillCount).toBeNull();
    expect(legacy.pmEntryFillCount).toBeNull();
    expect(summarizeBotPositions([legacy]).deployedCapitalCents).toBeNull();
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

  it('makes live reservations non-expiring before any venue placement can occur', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-live-reservation-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    client.close();
    const store = new BotPositionStore(dbUrl);

    await expect(store.reservePair('KXTEST', '0xabc', 'live')).resolves.toBe(true);
    const agingClient = createClient({ url: dbUrl });
    const reservation = await agingClient.execute(`SELECT exposure_at_risk FROM bot_position_reservations`);
    expect(Number(reservation.rows[0]?.exposure_at_risk)).toBe(1);
    await agingClient.execute(`UPDATE bot_position_reservations SET reserved_at = '2000-01-01T00:00:00.000Z'`);
    agingClient.close();
    store.close();

    const restarted = new BotPositionStore(dbUrl);
    await expect(restarted.reservePair('kxtest', '0xABC', 'live')).resolves.toBe(false);
    restarted.close();
  });

  it('keeps legacy duplicate positions readable while rejecting another open position for the pair', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-legacy-duplicates-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 0), (8, 0)`);
    await client.execute(`CREATE TABLE bot_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id INTEGER, kalshi_ticker TEXT,
      pm_condition_id TEXT, status TEXT, execution_mode TEXT
    )`);
    await client.execute(`INSERT INTO bot_positions (execution_id, kalshi_ticker, pm_condition_id, status, execution_mode)
      VALUES (7, 'KXTEST', '0xABC', 'open', 'live'), (8, 'kxtest', '0xabc', 'open', 'live')`);
    client.close();

    const store = new BotPositionStore(dbUrl);
    await expect(store.hasOpenPair('KXTEST', '0xabc', 'live')).resolves.toBe(true);

    const migrated = createClient({ url: dbUrl });
    await migrated.execute(`INSERT INTO executions (id, dry_run) VALUES (9, 0)`);
    await expect(migrated.execute(`
      UPDATE bot_positions SET status = 'open' WHERE id = 1
    `)).resolves.toMatchObject({ rowsAffected: 1 });
    await migrated.execute(`
      INSERT INTO bot_positions (execution_id, kalshi_ticker, pm_condition_id, status, execution_mode)
      VALUES (9, NULL, NULL, 'open', 'live')
    `);
    await expect(migrated.execute(`
      UPDATE bot_positions SET kalshi_ticker = 'KXTEST', pm_condition_id = '0xABC' WHERE execution_id = 9
    `)).rejects.toThrow(/open bot position already exists/i);
    await expect(migrated.execute(`
      INSERT INTO bot_positions (execution_id, kalshi_ticker, pm_condition_id, status, execution_mode)
      VALUES (9, 'KXTEST', '0xABC', 'open', 'live')
    `)).rejects.toThrow(/open bot position already exists/i);
    migrated.close();
    store.close();
  });

  it('applies the checked-in migration without rejecting legacy duplicate open positions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-migration-duplicates-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 0), (8, 0), (9, 0)`);
    await client.execute(`CREATE TABLE bot_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id INTEGER, execution_mode TEXT,
      kalshi_ticker TEXT, pm_condition_id TEXT, status TEXT, opened_at TEXT
    )`);
    await client.execute(`INSERT INTO bot_positions
      (execution_id, execution_mode, kalshi_ticker, pm_condition_id, status, opened_at)
      VALUES (7, 'live', 'KXTEST', '0xABC', 'open', ''),
             (8, 'live', 'kxtest', '0xabc', 'open', '')`);

    const migration = await readFile('src/migrations/20260808_001_create_bot_positions.sql', 'utf8');
    await expect(client.executeMultiple(migration)).resolves.toBeUndefined();
    await expect(client.execute(`INSERT INTO bot_positions
      (execution_id, execution_mode, kalshi_ticker, pm_condition_id, status, opened_at)
      VALUES (9, 'live', 'KXTEST', '0xABC', 'open', '')`)).rejects.toThrow(/open bot position already exists/i);
    client.close();
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
      { pair_key: 'kxtest', execution_mode: 'live', exposure_at_risk: 1 },
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
  it('bounds position refresh concurrency so a large ledger cannot overflow venue queues', async () => {
    let active = 0;
    let peak = 0;
    const positions = Array.from({ length: 60 }, (_, index) => openPosition({ id: index + 1 }));
    const positionStore = {
      listAllOpen: async () => positions,
      updateValuationWithFeeConfig: async () => undefined,
      updateValuation: async () => undefined,
      clearOpenValuation: async () => undefined,
    } as unknown as BotPositionStore;
    const result = await pollOpenBotPositions({
      positionStore,
      observedAt: '2026-08-08T12:00:00.000Z',
      fetchKalshi: async () => {
        active += 1;
        peak = Math.max(peak, active);
        if (active > 8) throw new Error('simulated venue queue overflow');
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { yes_bid_dollars: '0.48', no_bid_dollars: '0.51', status: 'open', close_time: '2026-08-10T00:00:00.000Z' };
      },
      fetchKalshiBids: async () => ({ yesBids: [{ priceCents: 48, size: 10 }], noBids: [{ priceCents: 51, size: 10 }], observedAt: '2026-08-08T12:00:00.000Z' }),
      fetchPmBids: async () => ({ yesBidCents: 42, noBidCents: 57, yesBids: [{ priceCents: 42, size: 10 }], noBids: [{ priceCents: 57, size: 10 }], resolved: false, observedAt: '2026-08-08T12:00:00.000Z' }),
      fetchFeeConfig: async () => ({
        kalshi: { feeType: 'quadratic', feeMultiplierPpm: 1_000_000, source: 'kalshi-series', observedAt: '2026-08-08T12:00:00.000Z', version: 'v1' },
        polymarket: { tokenId: 'pm-no-token', feeRateBps: 400, source: 'pm-fee', observedAt: '2026-08-08T12:00:00.000Z', version: 'v1' }, pmTheta: 0.04,
      }),
    });
    expect(peak).toBeLessThanOrEqual(8);
    expect(result).toEqual({ updated: 60, settled: 0, errors: [] });
  });

  it('persists venue observation time when fee lookup completes later', async () => {
    const position = openPosition({ id: 1 });
    let persistedAt: string | null = null;
    const positionStore = {
      listAllOpen: async () => [position],
      updateValuationWithFeeConfig: async (_id: number, valuation: { lastValuationAt: string }) => { persistedAt = valuation.lastValuationAt; },
      updateValuation: async () => undefined,
      clearOpenValuation: async () => undefined,
    } as unknown as BotPositionStore;
    const result = await pollOpenBotPositions({
      positionStore, observedAt: '2026-08-08T12:00:10.000Z',
      fetchKalshi: async () => ({ yes_bid_dollars: '0.48', no_bid_dollars: '0.51', status: 'open', close_time: '2026-08-10T00:00:00.000Z' }),
      fetchKalshiBids: async () => ({ yesBids: [{ priceCents: 48, size: 10 }], noBids: [{ priceCents: 51, size: 10 }], observedAt: '2026-08-08T12:00:04.000Z' }),
      fetchPmBids: async () => ({ yesBidCents: 42, noBidCents: 57, yesBids: [{ priceCents: 42, size: 10 }], noBids: [{ priceCents: 57, size: 10 }], resolved: false, observedAt: '2026-08-08T12:00:03.000Z' }),
      fetchFeeConfig: async () => ({
        kalshi: { feeType: 'quadratic', feeMultiplierPpm: 1_000_000, source: 'kalshi-series', observedAt: '2026-08-08T12:00:10.000Z', version: 'v1' },
        polymarket: { tokenId: 'pm-no-token', feeRateBps: 400, source: 'pm-fee', observedAt: '2026-08-08T12:00:10.000Z', version: 'v1' }, pmTheta: 0.04,
      }),
    });
    expect(result).toEqual({ updated: 1, settled: 0, errors: [] });
    expect(persistedAt).toBe('2026-08-08T12:00:03.000Z');
  });

  it('values an identifier-present legacy paper position from executable books and persisted buy cost', async () => {
    const previousCwd = process.cwd();
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-legacy-valuation-'));
    try {
      process.chdir(dir);
      await mkdir(path.join(dir, 'data'));
      const dbUrl = `file:${path.join(dir, 'data', 'edgefinder.db')}`;
      const client = createClient({ url: dbUrl });
      await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL, source TEXT)`);
      await client.execute(`INSERT INTO executions (id, dry_run, source) VALUES (7, 1, 'bot')`);
      client.close();
      const store = new BotPositionStore(dbUrl);
      const created = await store.create({
        ...openPosition(), id: undefined, dryRun: undefined, executionMode: 'paper',
        kalshiExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
        pmExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
      } as never);
      const legacy = createClient({ url: dbUrl });
      await legacy.execute({
        sql: `UPDATE bot_positions SET
          kalshi_entry_fee_type = NULL, kalshi_entry_fee_multiplier_ppm = NULL,
          kalshi_entry_fee_source = NULL, kalshi_entry_fee_observed_at = NULL,
          kalshi_entry_fee_version = NULL, pm_entry_token_id = NULL,
          pm_entry_fee_rate_bps = NULL, pm_entry_fee_source = NULL,
          pm_entry_fee_observed_at = NULL, pm_entry_fee_version = NULL
          WHERE id = ?`,
        args: [created.id],
      });
      legacy.close();
      store.close();

      await expect(pollOpenBotPositions({
        positionStore: new BotPositionStore(dbUrl),
        observedAt: '2026-08-08T12:00:00.000Z',
        fetchKalshi: async () => ({ yes_bid_dollars: '0.48', no_bid_dollars: '0.51', status: 'open', close_time: '2026-08-10T00:00:00.000Z' }),
        fetchKalshiBids: async () => ({
          yesBids: [{ priceCents: 48, size: 10 }], noBids: [{ priceCents: 51, size: 10 }],
          observedAt: '2026-08-08T12:00:00.000Z',
        }),
        fetchPmBids: async () => ({
          yesBidCents: 42, noBidCents: 57,
          yesBids: [{ priceCents: 42, size: 10 }], noBids: [{ priceCents: 57, size: 10 }],
          resolved: false, observedAt: '2026-08-08T12:00:00.000Z',
        }),
        fetchFeeConfig: async () => ({
          kalshi: { feeType: 'quadratic', feeMultiplierPpm: 1_000_000, source: 'kalshi-series', observedAt: '2026-08-08T12:00:00.000Z', version: 'v1' },
          polymarket: { tokenId: 'pm-no-token', feeRateBps: 400, source: 'pm-fee', observedAt: '2026-08-08T12:00:00.000Z', version: 'v1' },
          pmTheta: 0.04,
        }),
      })).resolves.toEqual({ updated: 1, settled: 0, errors: [] });

      const read = new BotPositionStore(dbUrl);
      const [valued] = await read.list({ status: 'open' });
      expect(valued.currentValueCents).toBe(1022);
      expect(valued.unrealizedPnlCents).toBe(44);
      expect(valued.valuationFailureReason).toBeNull();
      expect(valued.pmExitTokenId).toBe('pm-no-token');
      read.close();
    } finally {
      process.chdir(previousCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses current token fee authority for legacy paper liquidation without rewriting persisted entry economics', async () => {
    const previousCwd = process.cwd();
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-legacy-token-fee-'));
    try {
      process.chdir(dir);
      await mkdir(path.join(dir, 'data'));
      const dbUrl = `file:${path.join(dir, 'data', 'edgefinder.db')}`;
      const client = createClient({ url: dbUrl });
      await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL, source TEXT)`);
      await client.execute(`INSERT INTO executions (id, dry_run, source) VALUES (7, 1, 'bot')`);
      client.close();
      const store = new BotPositionStore(dbUrl);
      const created = await store.create({
        ...openPosition(), id: undefined, dryRun: undefined, executionMode: 'paper',
        kalshiExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
        pmExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
      } as never);
      const legacy = createClient({ url: dbUrl });
      await legacy.execute({
        sql: `UPDATE bot_positions SET kalshi_entry_fee_type = NULL, kalshi_entry_fee_multiplier_ppm = NULL,
          kalshi_entry_fee_source = NULL, kalshi_entry_fee_observed_at = NULL, kalshi_entry_fee_version = NULL,
          pm_entry_token_id = NULL, pm_entry_fee_rate_bps = NULL, pm_entry_fee_source = NULL,
          pm_entry_fee_observed_at = NULL, pm_entry_fee_version = NULL, category = NULL WHERE id = ?`,
        args: [created.id],
      });
      legacy.close();
      store.close();
      const result = await pollOpenBotPositions({
        positionStore: new BotPositionStore(dbUrl), observedAt: '2026-08-08T12:00:00.000Z',
        fetchKalshi: async () => ({ yes_bid_dollars: '0.48', no_bid_dollars: '0.51', status: 'open', close_time: '2026-08-10T00:00:00.000Z' }),
        fetchKalshiBids: async () => ({ yesBids: [{ priceCents: 48, size: 10 }], noBids: [{ priceCents: 51, size: 10 }], observedAt: '2026-08-08T12:00:00.000Z' }),
        fetchPmBids: async () => ({ yesBidCents: 42, noBidCents: 57, yesBids: [{ priceCents: 42, size: 10 }], noBids: [{ priceCents: 57, size: 10 }], resolved: false, observedAt: '2026-08-08T12:00:00.000Z' }),
        fetchFeeConfig: async () => ({
          kalshi: { feeType: 'quadratic', feeMultiplierPpm: 1_000_000, source: 'kalshi-series', observedAt: '2026-08-08T12:00:00.000Z', version: 'v1' },
          polymarket: { tokenId: 'pm-no-token', feeRateBps: 0, source: 'pm-fee', observedAt: '2026-08-08T12:00:00.000Z', version: 'v1' }, pmTheta: 0,
        }),
      });
      expect(result).toEqual({ updated: 1, settled: 0, errors: [] });
      const read = new BotPositionStore(dbUrl);
      const [valued] = await read.list({ status: 'open' });
      expect(valued.currentValueCents).toBe(1032);
      expect(valued.pmTheta).toBe(0.04);
      expect(valued.pmExitFeeRateBps).toBe(0);
      read.close();
    } finally {
      process.chdir(previousCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists a specific per-leg reason without letting one failed position block another', async () => {
    const previousCwd = process.cwd();
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-failure-reason-'));
    try {
      process.chdir(dir);
      await mkdir(path.join(dir, 'data'));
      const dbUrl = `file:${path.join(dir, 'data', 'edgefinder.db')}`;
      const client = createClient({ url: dbUrl });
      await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL, source TEXT)`);
      await client.execute(`INSERT INTO executions (id, dry_run, source) VALUES (7, 1, 'bot'), (8, 1, 'bot')`);
      client.close();
      const store = new BotPositionStore(dbUrl);
      const initial = {
        kalshiExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
        pmExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
      };
      const first = await store.create({ ...openPosition(), ...initial, id: undefined, dryRun: undefined } as never);
      const second = await store.create({ ...openPosition({ executionId: 8, kalshiTicker: 'KXSECOND' }), ...initial, id: undefined, dryRun: undefined } as never);
      store.close();

      const result = await pollOpenBotPositions({
        positionStore: new BotPositionStore(dbUrl),
        observedAt: '2026-08-08T12:00:00.000Z',
        fetchKalshi: async () => ({ yes_bid_dollars: '0.48', no_bid_dollars: '0.51', status: 'open', close_time: '2026-08-10T00:00:00.000Z' }),
        fetchKalshiBids: async (ticker) => ({
          yesBids: [{ priceCents: 48, size: ticker === 'KXSECOND' ? 10 : 0.5 }],
          noBids: [{ priceCents: 51, size: 10 }], observedAt: '2026-08-08T12:00:00.000Z',
        }),
        fetchPmBids: async () => ({ yesBidCents: 42, noBidCents: 57, yesBids: [{ priceCents: 42, size: 10 }], noBids: [{ priceCents: 57, size: 10 }], resolved: false, observedAt: '2026-08-08T12:00:00.000Z' }),
        fetchFeeConfig: async () => ({
          kalshi: { feeType: 'quadratic', feeMultiplierPpm: 1_000_000, source: 'kalshi-series', observedAt: '2026-08-08T12:00:00.000Z', version: 'v1' },
          polymarket: { tokenId: 'pm-no-token', feeRateBps: 400, source: 'pm-fee', observedAt: '2026-08-08T12:00:00.000Z', version: 'v1' }, pmTheta: 0.04,
        }),
      });
      expect(result.updated).toBe(1);
      expect(result.errors).toEqual([{ id: first.id, error: expect.stringMatching(/insufficient.*Kalshi/i) }]);
      const read = new BotPositionStore(dbUrl);
      const rows = await read.list({ status: 'open' });
      expect(rows.find((row) => row.id === first.id)?.valuationFailureReason).toMatch(/insufficient.*Kalshi/i);
      expect(rows.find((row) => row.id === second.id)?.currentValueCents).not.toBeNull();
      read.close();
    } finally {
      process.chdir(previousCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

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
