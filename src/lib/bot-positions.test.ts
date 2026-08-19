import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => vi.unstubAllGlobals());

function openPosition(overrides: Partial<BotPosition> = {}): BotPosition {
  const position: BotPosition = {
    id: 1,
    executionId: 7,
    marketId: 'pair-1',
    marketTitle: 'Test market',
    kalshiTicker: 'KXTEST',
    pmConditionId: '0xabc',
    strategy: 'Buy YES Kalshi + NO PM',
    kalshiMarketQuestion: null,
    pmMarketQuestion: null,
    kalshiOutcomeLabel: null,
    pmOutcomeLabel: null,
    outcomeIdentityStatus: 'unresolved',
    outcomeIdentitySource: 'test_exact_identity_audit_v1',
    outcomeIdentityRecordedAt: '2026-08-08T12:00:00.000Z',
    outcomeIdentityFailureReason: 'Canonical relationship unavailable',
    kalshiSide: 'yes',
    pmSide: 'no',
    buyPriceKalshiCents: 45,
    buyPricePmCents: 50,
    sharesKalshi: 10,
    sharesPm: 10,
    remainingSharesKalshi: 10,
    remainingSharesPm: 10,
    remainingOpenPrincipalCents: 950,
    remainingOpenFeesCents: 28,
    remainingOpenCostCents: 978,
    totalCostCents: 978,
    entryCostStatus: 'available',
    entryCostFailureReason: null,
    kalshiEntryGrossMicrocents: 450_000_000,
    pmEntryGrossMicrocents: 500_000_000,
    entryCostRoundingDeltaMicrocents: 0,
    kalshiEntryFillCount: 1,
    pmEntryFillCount: 1,
    expectedPayoutCents: 1000,
    expectedProfitCents: 22,
    expectedRoiBps: 225,
    expectedApyBps: null,
    unitId: 'execution:7',
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
    pmEntryFeesEnabled: true,
    pmEntryFeeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
    pmEntryOrderBaseFeeBps: 1000,
    pmEntryOrderFeeSource: 'https://clob.polymarket.com/fee-rate?token_id=pm-no-token',
    pmEntryOrderFeeVersion: 'token-order-base-fee:1000',
    pmEntryFeeSource: 'https://gamma-api.polymarket.com/markets?condition_ids=0xabc',
    pmEntryFeeObservedAt: '2026-08-01T00:00:00.000Z',
    pmEntryFeeVersion: 'gamma-fee-schedule:400:1:true:0.25',
    kalshiEntryFeeCents: 18,
    kalshiEntryCalculatedFeeCents: 18,
    kalshiEntryChargedFeeCents: null,
    pmEntryFeeCents: 10,
    unallocatedEntryFeeCents: 0,
    entryRecordVersion: 1,
    entryRecordSource: 'bot_position_create',
    entryRecordedAt: '2026-08-01T00:00:00.000Z',
    kalshiExitFeeType: 'quadratic',
    kalshiExitFeeMultiplierPpm: 1_000_000,
    kalshiExitFeeSource: 'kalshi-series:KXTEST',
    kalshiExitFeeObservedAt: '2026-08-08T12:00:00.000Z',
    kalshiExitFeeVersion: 'series-v1',
    pmExitTokenId: 'pm-no-token',
    pmExitFeeRateBps: 400,
    pmExitFeesEnabled: true,
    pmExitFeeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
    pmExitOrderBaseFeeBps: 1000,
    pmExitOrderFeeSource: 'https://clob.polymarket.com/fee-rate?token_id=pm-no-token',
    pmExitOrderFeeVersion: 'token-order-base-fee:1000',
    pmExitFeeSource: 'https://gamma-api.polymarket.com/markets?condition_ids=0xabc',
    pmExitFeeObservedAt: '2026-08-08T12:00:00.000Z',
    pmExitFeeVersion: 'gamma-fee-schedule:400:1:true:0.25',
    status: 'open',
    openedAt: '2026-08-01T00:00:00.000Z',
    expiryDate: '2026-08-10T00:00:00.000Z',
    settledAt: null,
    closedAt: null,
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
    valuationStatus: 'current',
    valuationFailureReason: null,
    valuationFailureAt: null,
    kalshiValuationDepth: 10,
    pmValuationDepth: 10,
    kalshiLiquidationValueCents: 450,
    pmLiquidationValueCents: 550,
    kalshiQuoteTimestamp: '2026-08-01T00:00:00.000Z',
    pmQuoteTimestamp: '2026-08-01T00:00:00.000Z',
    kalshiQuoteSource: 'test',
    pmQuoteSource: 'test',
    realizedPnlBeforeSettlementCents: null,
    realizedPnlCents: null,
    settlementSide: null,
    executionMode: 'paper',
    dryRun: true,
    ...overrides,
  };
  if (overrides.remainingSharesKalshi === undefined) position.remainingSharesKalshi = position.sharesKalshi;
  if (overrides.remainingSharesPm === undefined) position.remainingSharesPm = position.sharesPm;
  if (overrides.remainingOpenFeesCents === undefined) position.remainingOpenFeesCents = position.feesCents;
  if (overrides.remainingOpenCostCents === undefined) position.remainingOpenCostCents = position.totalCostCents;
  if (overrides.remainingOpenPrincipalCents === undefined) {
    position.remainingOpenPrincipalCents = position.remainingOpenCostCents - position.remainingOpenFeesCents;
  }
  if (overrides.pmEntryFeeRateBps === 0 && overrides.pmEntryFeeSchedule === undefined) {
    position.pmEntryFeesEnabled = false;
    position.pmEntryFeeSchedule = null;
  }
  if (overrides.pmExitFeeRateBps === 0 && overrides.pmExitFeeSchedule === undefined) {
    position.pmExitFeesEnabled = false;
    position.pmExitFeeSchedule = null;
  }
  return position;
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
  it('includes stale indicative marks in portfolio totals while retaining stale coverage', () => {
    const result = summarizeBotPerformance([
      openPosition({
        totalCostCents: 97,
        currentValueCents: 100,
        lastValuationAt: '2026-08-17T10:00:00.000Z',
      }),
    ], new Date('2026-08-17T12:00:00.000Z'));

    expect(result.capital).toMatchObject({ currentCents: 100, excludedOpenCostCents: 0 });
    expect(result.pnl).toEqual({ realizedCents: 0, unrealizedCents: 3, totalCents: 3, roiBps: 309 });
    expect(result.valuation).toMatchObject({ fresh: 0, stale: 1, unavailable: 0 });
    expect(result.entryCohorts[0]).toMatchObject({ currentCents: 100, unrealizedCents: 3 });
  });

  it('does not treat a legacy position with unavailable authoritative entry cost as zero deployed capital', () => {
    const result = summarizeBotPerformance([
      openPosition({
        currentValueCents: 1022,
        lastValuationAt: '2026-08-11T13:55:00.000Z',
        entryCostStatus: 'unavailable',
        entryCostFailureReason: 'Legacy position lacks authoritative entry fill breakdown',
      }),
    ], new Date('2026-08-11T14:00:00.000Z'));

    expect(result.capital.deployedCents).toBeNull();
    expect(result.capital.currentCents).toBe(1022);
    expect(result.capital.excludedOpenCostCents).toBe(978);
    expect(result.entryCost).toEqual({ available: 0, unavailable: 1 });
    expect(result.pnl).toEqual({ realizedCents: 0, unrealizedCents: null, totalCents: null, roiBps: null });
    expect(result.entryCohorts[0].deployedCents).toBeNull();
    expect(result.entryCohorts[0].currentCents).toBe(1022);
    expect(result.entryCohorts[0].unrealizedCents).toBeNull();
  });

  it('uses one fee-inclusive population for cards and chart while retaining stale indicative marks', () => {
    const rows = [
      openPosition({ id: 1, openedAt: '2026-08-10T13:00:00.000Z', totalCostCents: 978, currentValueCents: 1022, lastValuationAt: '2026-08-11T13:55:00.000Z', expectedPayoutCents: 1000 }),
      openPosition({ id: 2, openedAt: '2026-08-10T14:00:00.000Z', totalCostCents: 900, currentValueCents: 950, lastValuationAt: '2026-08-11T13:00:00.000Z', expectedPayoutCents: 1000 }),
      openPosition({ id: 3, status: 'settled', openedAt: '2026-08-11T12:00:00.000Z', settledAt: '2026-08-11T13:00:00.000Z', totalCostCents: 950, currentValueCents: 1000, realizedPnlCents: 50, resolutionPayoutCents: 1000, resolutionValidationStatus: 'verified' }),
    ];

    const result = summarizeBotPerformance(rows, new Date('2026-08-11T14:00:00.000Z'));
    expect(result.capital).toEqual({ deployedCents: 2828, currentCents: 2972, heldToResolutionCents: 2000, excludedOpenCostCents: 0 });
    expect(result.pnl).toEqual({ realizedCents: 50, unrealizedCents: 94, totalCents: 144, roiBps: 509 });
    expect(result.valuation).toEqual({ fresh: 1, stale: 1, unavailable: 0, pendingSettlement: 0, asOf: '2026-08-11T13:00:00.000Z' });
    expect(result.entryCohorts).toEqual([
      { date: '2026-08-10', deployedCents: 1878, currentCents: 1972, heldToResolutionCents: 2000, realizedCents: 0, unrealizedCents: 94, trades: 2 },
      { date: '2026-08-11', deployedCents: 950, currentCents: 1000, heldToResolutionCents: 0, realizedCents: 50, unrealizedCents: 0, trades: 1 },
    ]);
  });

  it('rounds indicative portfolio and cohort totals only after aggregating exact marks', () => {
    const rows = [1, 2].map((id) => openPosition({
      id,
      openedAt: '2026-08-10T13:00:00.000Z',
      totalCostCents: 97,
      currentValueCents: 99,
      indicativeValueMicrocents: 99_490_000,
      indicativeBuyCostMicrocents: 97_000_000,
      indicativePnlMicrocents: 2_490_000,
      lastValuationAt: '2026-08-11T13:55:00.000Z',
    }));

    const result = summarizeBotPerformance(rows, new Date('2026-08-11T14:00:00.000Z'));
    expect(result.capital.currentCents).toBe(199);
    expect(result.pnl).toMatchObject({ unrealizedCents: 5, totalCents: 5, roiBps: 257 });
    expect(result.entryCohorts[0]).toMatchObject({ currentCents: 199, unrealizedCents: 5 });
  });

  it('reconciles a reduced open position from immutable Buy Cost across row, cards, ROI, and cohort', () => {
    const result = summarizeBotPerformance([
      openPosition({
        totalCostCents: 300,
        remainingOpenCostCents: 100,
        realizedPnlCents: 5,
        currentValueCents: 110,
        indicativeValueMicrocents: 110_000_000,
        indicativeBuyCostMicrocents: 300_000_000,
        indicativePnlMicrocents: -190_000_000,
        lastValuationAt: '2026-08-11T13:55:00.000Z',
      }),
    ], new Date('2026-08-11T14:00:00.000Z'));

    expect(result.capital).toMatchObject({ deployedCents: 300, currentCents: 110 });
    expect(result.pnl).toEqual({
      realizedCents: 0,
      unrealizedCents: -190,
      totalCents: -190,
      roiBps: -6333,
    });
    expect(result.entryCohorts[0]).toMatchObject({
      deployedCents: 300,
      currentCents: 110,
      realizedCents: 0,
      unrealizedCents: -190,
    });
  });

  it('distinguishes unavailable marks and does not treat unverified settlement as realized', () => {
    const result = summarizeBotPerformance([
      openPosition({ currentValueCents: null, lastValuationAt: null }),
      openPosition({ id: 2, status: 'settled', realizedPnlCents: 40, resolutionValidationStatus: 'pending' }),
    ], new Date('2026-08-11T14:00:00.000Z'));

    expect(result.valuation).toMatchObject({ fresh: 0, stale: 0, unavailable: 1, pendingSettlement: 1 });
    expect(result.capital.excludedOpenCostCents).toBe(978);
    expect(result.pnl).toEqual({ realizedCents: 0, unrealizedCents: null, totalCents: null, roiBps: null });
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
  it.each([
    ['within the freshness budget', '2026-08-08T11:59:00.001Z', false],
    ['at the freshness boundary', '2026-08-08T11:59:00.000Z', false],
    ['beyond the freshness boundary', '2026-08-08T11:58:59.999Z', true],
  ])('%s for both venue fee authorities', (_label, feeObservedAt, shouldThrow) => {
    const run = () => calculatePositionValuation(openPosition({
      kalshiExitFeeObservedAt: feeObservedAt,
      pmExitFeeObservedAt: feeObservedAt,
    }), {
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
    });
    if (shouldThrow) expect(run).toThrow(/stale authoritative.*fee configuration/i);
    else expect(run).not.toThrow();
  });

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
    })).toThrow(/Polymarket theta/i);
  });

  it.each([
    { field: 'kalshiExitFeeMultiplierPpm', value: null, error: /Kalshi fee configuration/i },
    { field: 'pmExitFeeRateBps', value: null, error: /Polymarket fee configuration/i },
    { field: 'pmExitFeeRateBps', value: 500, error: /conflicting Polymarket fee configuration/i },
  ])('fails valuation closed for missing or conflicting authority: $field', ({ field, value, error }) => {
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

  it('fails settlement closed when legacy entry fill or fee evidence is unavailable', () => {
    expect(() => calculatePositionValuation(openPosition({
      entryCostStatus: 'unavailable',
      entryCostFailureReason: 'Legacy position lacks authoritative entry fill and fee data',
      kalshiEntryFeeMultiplierPpm: null,
    }), {
      kalshiYesBidCents: 100,
      kalshiNoBidCents: 0,
      pmYesBidCents: 100,
      pmNoBidCents: 0,
      observedAt: '2026-08-11T12:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      kalshiResolved: true,
      pmResolved: true,
    })).toThrow(/authoritative entry fill and fee data/i);
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
    expect(result.kalshiEntryCalculatedFeeCents).toBe(1);
    expect(result.kalshiEntryChargedFeeCents).toBe(7);
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

  it('uses the authoritative flat fee type instead of defaulting to quadratic', () => {
    const result = calculateBotPositionEntryCost({
      buyPriceKalshiCents: 50, buyPricePmCents: 40,
      sharesKalshi: 100, sharesPm: 100,
      pmTheta: 0, kalshiFeeMultiplierPpm: 1_000_000,
      kalshiFeeType: 'flat', pmFeeRateBps: 0,
    });
    expect(result.kalshiEntryCalculatedFeeCents).toBe(200);
    expect(result.kalshiEntryChargedFeeCents).toBeNull();
    expect(result.kalshiEntryFeeCents).toBe(200);
  });

  it('preserves Polymarket estimates and charged-fee overrides to five decimal USDC precision', () => {
    const estimated = calculateBotPositionEntryCost({
      buyPriceKalshiCents: 10,
      buyPricePmCents: 70,
      sharesKalshi: 1,
      sharesPm: 1,
      pmTheta: 0.04,
      kalshiFeeMultiplierPpm: 0,
      pmFeeRateBps: 400,
    });
    expect(estimated.pmEntryFeeMicrousd).toBe(8_400);
    expect(estimated.totalCostMicrousd).toBe(808_400);

    const charged = calculateBotPositionEntryCost({
      buyPriceKalshiCents: 10,
      buyPricePmCents: 70,
      sharesKalshi: 1,
      sharesPm: 1,
      pmTheta: 0.04,
      kalshiFeeMultiplierPpm: 0,
      pmFeeRateBps: 400,
      pmChargedFeeMicrousd: 12_340,
    });
    expect(charged.pmEntryFeeMicrousd).toBe(12_340);
    expect(charged.pmEntryFeeCents).toBe(1);

    const consistentVenueEvidence = calculateBotPositionEntryCost({
      buyPriceKalshiCents: 10,
      buyPricePmCents: 70,
      sharesKalshi: 1,
      sharesPm: 1,
      pmTheta: 0.04,
      kalshiFeeMultiplierPpm: 0,
      pmFeeRateBps: 400,
      pmChargedFeeCents: 1,
      pmChargedFeeMicrousd: 8_400,
    });
    expect(consistentVenueEvidence.pmEntryFeeMicrousd).toBe(8_400);
    expect(consistentVenueEvidence.totalCostMicrousd).toBe(808_400);

    expect(() => calculateBotPositionEntryCost({
      buyPriceKalshiCents: 10,
      buyPricePmCents: 70,
      sharesKalshi: 1,
      sharesPm: 1,
      pmTheta: 0.04,
      kalshiFeeMultiplierPpm: 0,
      pmFeeRateBps: 400,
      pmChargedFeeCents: 2,
      pmChargedFeeMicrousd: 8_400,
    })).toThrow('Conflicting authoritative Polymarket charged fee representations');
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
      fetchPmMarketDetails: async () => ({ conditionId: '0xcondition', feesEnabled: false }),
    });

    expect(result).toEqual({
      kalshi: {
        authority: {
          marketTicker: 'KXTEST-YES', eventTicker: 'KXTEST-EVENT', seriesTicker: 'KXTEST',
          feeType: 'quadratic', feeMultiplierPpm: 500_000,
          source: 'https://external-api.kalshi.com/trade-api/v2/series/KXTEST',
          observedAt: '2026-08-08T12:00:00.000Z', version: 'quadratic:500000:series-v2',
        },
        feeType: 'quadratic',
        feeMultiplierPpm: 500_000,
        source: 'https://external-api.kalshi.com/trade-api/v2/series/KXTEST',
        observedAt: '2026-08-08T12:00:00.000Z',
        version: 'quadratic:500000:series-v2',
      },
      polymarket: {
        tokenId: 'no-token',
        feeRateBps: 0,
        feesEnabled: false,
        feeSchedule: null,
        orderBaseFeeBps: 0,
        orderSource: 'https://clob.polymarket.com/fee-rate?token_id=no-token',
        orderVersion: 'token-order-base-fee:0',
        source: 'https://gamma-api.polymarket.com/markets?condition_ids=0xcondition',
        observedAt: '2026-08-08T12:00:00.000Z',
        version: 'gamma-fee-schedule:disabled',
      },
      pmTheta: 0,
    });
  });

  it('separates the observed politics economic schedule from token order-signing base_fee', async () => {
    const conditionId = '0x66bbf6d55e0296278858b3147689f3df9259374f158f9f028b608baa322a639c';
    const noTokenId = '6136336712352911156426560180855478229745540927722899997193789497766196705020';
    const result = await fetchAuthoritativeBotFeeConfig({
      kalshiTicker: 'KXTEST-YES',
      pmConditionId: conditionId,
      pmSide: 'no',
      category: 'Politics',
      observedAt: '2026-08-08T12:00:00.000Z',
    }, {
      fetchJson: async (url) => {
        if (url.includes('/markets/')) return { market: { event_ticker: 'KXTEST-EVENT' } };
        if (url.includes('/events/')) return { event: { series_ticker: 'KXTEST' } };
        if (url.includes('/series/')) return { series: { fee_type: 'quadratic', fee_multiplier: 1 } };
        if (url.includes('/fee-rate')) return { base_fee: 1000 };
        throw new Error(`Unexpected URL ${url}`);
      },
      fetchPmMarket: async () => ({ tokens: [{ token_id: noTokenId, outcome: 'No' }] }),
      fetchPmMarketDetails: async () => ({
        conditionId,
        feesEnabled: true,
        feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
      }),
    });
    expect(result.pmTheta).toBe(0.04);
    expect(result.polymarket).toMatchObject({
      tokenId: noTokenId,
      orderBaseFeeBps: 1000,
      feesEnabled: true,
      feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
      feeRateBps: 400,
    });
  });

  it('accepts an explicitly fee-free market without inventing a schedule', async () => {
    const result = await fetchAuthoritativeBotFeeConfig({
      kalshiTicker: 'KXTEST-YES', pmConditionId: '0xfree', pmSide: 'yes',
    }, {
      fetchJson: async (url) => {
        if (url.includes('/markets/')) return { market: { event_ticker: 'KXTEST-EVENT' } };
        if (url.includes('/events/')) return { event: { series_ticker: 'KXTEST' } };
        if (url.includes('/series/')) return { series: { fee_type: 'quadratic', fee_multiplier: 1 } };
        if (url.includes('/fee-rate')) return { base_fee: 0 };
        throw new Error(`Unexpected URL ${url}`);
      },
      fetchPmMarket: async () => ({ tokens: [{ token_id: 'yes-token', outcome: 'Yes' }] }),
      fetchPmMarketDetails: async () => ({ conditionId: '0xfree', feesEnabled: false }),
    });
    expect(result.polymarket).toMatchObject({ feesEnabled: false, feeSchedule: null, feeRateBps: 0 });
    expect(result.pmTheta).toBe(0);
  });

  it.each([
    { conditionId: '0xcondition' },
    { conditionId: '0xcondition', feesEnabled: true },
    { conditionId: '0xcondition', feesEnabled: true, feeSchedule: { rate: 0.04, exponent: 2, takerOnly: true, rebateRate: 0.25 } },
  ])('fails closed when economic fee authority is missing or unsupported: %o', async (marketDetails) => {
    await expect(fetchAuthoritativeBotFeeConfig({
      kalshiTicker: 'KXTEST-YES', pmConditionId: '0xcondition', pmSide: 'no',
    }, {
      fetchJson: async (url) => {
        if (url.includes('/markets/')) return { market: { event_ticker: 'KXTEST-EVENT' } };
        if (url.includes('/events/')) return { event: { series_ticker: 'KXTEST' } };
        if (url.includes('/series/')) return { series: { fee_type: 'quadratic', fee_multiplier: 1 } };
        if (url.includes('/fee-rate')) return { base_fee: 1000 };
        throw new Error(`Unexpected URL ${url}`);
      },
      fetchPmMarket: async () => ({ tokens: [{ token_id: 'no-token', outcome: 'No' }] }),
      fetchPmMarketDetails: async () => marketDetails,
    })).rejects.toThrow(/Polymarket.*fee/i);
  });

  it('accepts Kalshi quadratic taker fees when the series also supports maker fees', async () => {
    const result = await fetchAuthoritativeBotFeeConfig({
      kalshiTicker: 'KXMARMAD-27-ORE', pmConditionId: '0xcondition', pmSide: 'no',
    }, {
      fetchJson: async (url) => {
        if (url.includes('/markets/')) return { market: { event_ticker: 'KXMARMAD-27' } };
        if (url.includes('/events/')) return { event: { series_ticker: 'KXMARMAD' } };
        if (url.includes('/series/')) return { series: { fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 } };
        return { base_fee: 0 };
      },
      fetchPmMarket: async () => ({ tokens: [{ token_id: 'no-token', outcome: 'No' }] }),
      fetchPmMarketDetails: async () => ({ conditionId: '0xcondition', feesEnabled: false }),
    });
    expect(result.kalshi).toMatchObject({ feeType: 'quadratic_with_maker_fees', feeMultiplierPpm: 1_000_000 });
    expect(result.kalshi.version).toContain('quadratic_with_maker_fees');
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
      kalshiMarketQuestion: null,
      pmMarketQuestion: null,
      kalshiOutcomeLabel: null,
      pmOutcomeLabel: null,
      outcomeIdentityStatus: 'unresolved',
      outcomeIdentitySource: 'test_exact_identity_audit_v1',
      outcomeIdentityRecordedAt: '2026-08-08T12:00:00.000Z',
      outcomeIdentityFailureReason: 'Canonical relationship unavailable',
      kalshiSide: 'yes',
      pmSide: 'no',
      buyPriceKalshiCents: 45,
      buyPricePmCents: 50,
      sharesKalshi: 10,
      sharesPm: 10,
      totalCostCents: 978,
      totalCostMicrousd: 9_780_000,
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
      pmEntryFeesEnabled: true,
      pmEntryFeeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
      pmEntryOrderBaseFeeBps: 1000,
      pmEntryOrderFeeSource: 'https://clob.polymarket.com/fee-rate?token_id=pm-no-token',
      pmEntryOrderFeeVersion: 'token-order-base-fee:1000',
      pmEntryFeeSource: 'polymarket-gamma:0xabc',
      pmEntryFeeObservedAt: '2026-08-08T12:00:00.000Z',
      pmEntryFeeVersion: 'clob-v1',
      kalshiEntryFeeCents: 18,
      pmEntryFeeCents: 10,
      pmEntryFeeMicrousd: 100_000,
      kalshiExitFeeType: 'quadratic',
      kalshiExitFeeMultiplierPpm: 1_000_000,
      kalshiExitFeeSource: 'kalshi-series:KXTEST',
      kalshiExitFeeObservedAt: '2026-08-08T12:00:00.000Z',
      kalshiExitFeeVersion: 'series-v1',
      pmExitTokenId: 'pm-no-token',
      pmExitFeeRateBps: 400,
      pmExitFeesEnabled: true,
      pmExitFeeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
      pmExitOrderBaseFeeBps: 1000,
      pmExitOrderFeeSource: 'https://clob.polymarket.com/fee-rate?token_id=pm-no-token',
      pmExitOrderFeeVersion: 'token-order-base-fee:1000',
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
    expect(created).toMatchObject({
      kalshiMarketQuestion: null,
      pmMarketQuestion: null,
      kalshiOutcomeLabel: null,
      pmOutcomeLabel: null,
      outcomeIdentityStatus: 'unresolved',
      outcomeIdentitySource: 'test_exact_identity_audit_v1',
    });
    expect(created.pmEntryFeesEnabled).toBe(true);
    expect(created.pmEntryFeeSchedule).toEqual({ rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 });
    expect(created.pmEntryOrderBaseFeeBps).toBe(1000);
    expect(created.pmEntryOrderFeeSource).toContain('/fee-rate?token_id=pm-no-token');
    expect(created.pmExitFeeSchedule).toEqual(created.pmEntryFeeSchedule);
    expect(created.pmExitOrderBaseFeeBps).toBe(1000);
    expect(created.pmEntryFeeMicrousd).toBe(100_000);
    expect(created.totalCostMicrousd).toBe(9_780_000);
    expect(created).toMatchObject({
      unallocatedEntryFeeCents: 0,
      entryRecordVersion: 1,
      entryRecordSource: 'bot_position_create',
      entryRecordedAt: '2026-08-08T12:00:00.000Z',
    });
    await expect(store.create({ ...created, id: undefined, feesCents: 29 } as never))
      .rejects.toThrow(/entry economics conflict/i);
    await expect(store.create({
      ...created, id: undefined, executionId: 8, executionMode: 'live',
      kalshiTicker: 'KX-FORGED', pmConditionId: '0xforged',
      kalshiOutcomeLabel: 'Republicans', pmOutcomeLabel: 'Republicans',
      outcomeIdentityStatus: 'verified', outcomeIdentitySource: 'canonical_proposition_relationship_v1',
      outcomeIdentityFailureReason: null,
    } as never)).rejects.toThrow(/not canonically bound/i);
    await expect(store.hasOpenPair('KXTEST', '0xabc', 'paper')).resolves.toBe(true);
    await expect(store.hasOpenPair('KXTEST', '0xabc', 'live')).resolves.toBe(false);
    await expect(store.create({ ...created, id: undefined } as never)).rejects.toThrow(/open bot position/i);
    await expect(store.create({
      ...created,
      id: undefined,
      executionId: 88,
      executionMode: 'live',
      kalshiTicker: 'KXTEST-LIVE-MISSING-FILLS',
      pmConditionId: '0xlive-missing-fills',
      kalshiEntryGrossMicrocents: undefined,
      pmEntryGrossMicrocents: undefined,
      kalshiEntryFills: undefined,
      pmEntryFills: undefined,
    } as never)).rejects.toThrow(/immutable.*fill evidence/i);
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
      totalCostMicrousd: 2_060_000,
      kalshiEntryGrossMicrocents: 12_000_000,
      pmEntryGrossMicrocents: 184_000_000,
      kalshiEntryFills: [
        { priceMicrocents: 5_500_000, sizeMicrounits: 1_000_000 },
        { priceMicrocents: 6_500_000, sizeMicrounits: 1_000_000 },
      ],
      pmEntryFills: [
        { priceMicrocents: 91_250_000, sizeMicrounits: 1_000_000 },
        { priceMicrocents: 92_750_000, sizeMicrounits: 1_000_000 },
      ],
      entryCostRoundingDeltaMicrocents: 0,
      kalshiEntryFillCount: 2,
      pmEntryFillCount: 2,
      expectedPayoutCents: 200,
      expectedProfitCents: -6,
      feesCents: 10,
      kalshiEntryFeeCents: 7,
      pmEntryFeeCents: 3,
      pmEntryFeeMicrousd: 30_000,
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
      'pm_entry_fees_enabled', 'pm_entry_fee_exponent', 'pm_entry_fee_taker_only',
      'pm_entry_fee_rebate_rate_ppm', 'pm_entry_order_base_fee_bps',
      'pm_entry_order_fee_source', 'pm_entry_order_fee_version',
      'pm_exit_fees_enabled', 'pm_exit_fee_exponent', 'pm_exit_fee_taker_only',
      'pm_exit_fee_rebate_rate_ppm', 'pm_exit_order_base_fee_bps',
      'pm_exit_order_fee_source', 'pm_exit_order_fee_version',
      'entry_fee_unallocated', 'entry_record_version', 'entry_record_source', 'entry_recorded_at',
      'kalshi_market_question', 'pm_market_question', 'kalshi_outcome_label', 'pm_outcome_label',
      'outcome_identity_status', 'outcome_identity_source', 'outcome_identity_recorded_at', 'outcome_identity_failure_reason',
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
    })).toThrow(/authoritative entry fill and fee data/i);
    store.close();
  });

  it('does not trust a raw verified identity when exact identifiers are absent from the canonical registry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-forged-identity-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute('CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)');
    await client.execute('INSERT INTO executions (id, dry_run) VALUES (7, 1)');
    await client.execute(`CREATE TABLE bot_positions (
      id INTEGER PRIMARY KEY, execution_id INTEGER, status TEXT, opened_at TEXT,
      kalshi_ticker TEXT, pm_condition_id TEXT, pm_entry_token_id TEXT,
      kalshi_side TEXT, pm_side TEXT, kalshi_market_question TEXT, pm_market_question TEXT,
      kalshi_outcome_label TEXT, pm_outcome_label TEXT, outcome_identity_status TEXT,
      proposition_relationship_state TEXT, proposition_relationship_json TEXT
    )`);
    await client.execute(`INSERT INTO bot_positions VALUES (
      1, 7, 'open', '2026-08-19T00:00:00Z', 'KX-FORGED', '0xforged', 'unrelated-token',
      'yes', 'no', 'Forged K question', 'Forged PM question', 'Republicans', 'Republicans',
      'verified', 'verified_complementary', NULL
    )`);
    client.close();

    const store = new BotPositionStore(dbUrl);
    const [mapped] = await store.list({ status: 'all' });
    expect(mapped).toMatchObject({
      outcomeIdentityStatus: 'unresolved',
      kalshiOutcomeLabel: null,
      pmOutcomeLabel: null,
      propositionRelationship: null,
      propositionRelationshipState: 'invalid_metadata',
    });
    store.close();
  });

  it('fails closed instead of promoting rounded legacy prices and fee metadata to authoritative entry evidence', async () => {
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

  it('publishes execution principal and per-leg gross from authoritative fills rather than rounded Buy Price columns', () => {
    const [market] = BotPositionStore.groupForAnalytics([openPosition({
      buyPriceKalshiCents: 45,
      buyPricePmCents: 52,
      sharesKalshi: 3,
      sharesPm: 1,
      kalshiEntryGrossMicrocents: 12_345_679,
      pmEntryGrossMicrocents: 85_012_344,
      kalshiEntryFeeCents: 1,
      pmEntryFeeCents: 0,
      feesCents: 1,
      totalCostCents: 99,
      remainingOpenPrincipalCents: 98,
      remainingOpenFeesCents: 1,
      remainingOpenCostCents: 99,
    })]);

    expect(market.executions[0].executionPrincipalCents).toBe(98);
    expect(market.executions[0].executionFeesCents).toBe(1);
    expect(market.executions[0].executionBuyCostCents).toBe(99);
    expect(market.executions[0].legs.map((leg) => leg.originalGrossMicrocents)).toEqual([
      12_345_679,
      85_012_344,
    ]);
  });

  it('keeps authoritative fractional fill accounting reconciled through a partial exposure reduction', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-reduction-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1)`);
    client.close();
    const store = new BotPositionStore(dbUrl);
    const created = await store.create({
      ...openPosition(), id: undefined, dryRun: undefined,
      buyPriceKalshiCents: 45,
      buyPricePmCents: 52,
      sharesKalshi: 3,
      sharesPm: 1,
      kalshiEntryGrossMicrocents: 12_345_679,
      pmEntryGrossMicrocents: 85_012_344,
      kalshiEntryFills: [
        { priceMicrocents: 4_000_000, sizeMicrounits: 1_000_000 },
        { priceMicrocents: 4_345_679, sizeMicrounits: 1_000_000 },
        { priceMicrocents: 4_000_000, sizeMicrounits: 1_000_000 },
      ],
      pmEntryFills: [{ priceMicrocents: 85_012_344, sizeMicrounits: 1_000_000 }],
      entryCostRoundingDeltaMicrocents: -358_023,
      kalshiEntryFillCount: 3,
      pmEntryFillCount: 1,
      kalshiEntryFeeMultiplierPpm: 0,
      kalshiExitFeeMultiplierPpm: 0,
      kalshiExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
      pmTheta: 0,
      pmEntryFeeRateBps: 0,
      pmEntryFeesEnabled: false,
      pmEntryFeeSchedule: null,
      pmExitFeeRateBps: 0,
      pmExitFeesEnabled: false,
      pmExitFeeSchedule: null,
      pmExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
      kalshiEntryFeeCents: 1,
      pmEntryFeeCents: 0,
      pmEntryFeeMicrousd: 0,
      feesCents: 1,
      totalCostCents: 98,
      totalCostMicrousd: 983_580,
      expectedPayoutCents: 100,
      expectedProfitCents: 2,
    } as never);
    expect(created.kalshiEntryFills).toEqual([
      { priceMicrocents: 4_000_000, sizeMicrounits: 1_000_000 },
      { priceMicrocents: 4_345_679, sizeMicrounits: 1_000_000 },
      { priceMicrocents: 4_000_000, sizeMicrounits: 1_000_000 },
    ]);
    expect(created.pmEntryFills).toEqual([
      { priceMicrocents: 85_012_344, sizeMicrounits: 1_000_000 },
    ]);

    await store.updateValuation(created.id, {
      status: 'open',
      currentPriceKalshiCents: 10,
      currentPricePmCents: 90,
      currentValueCents: 120,
      kalshiGrossProceedsMicrocents: 30_000_000,
      pmGrossProceedsMicrocents: 90_000_000,
      kalshiNetProceedsCents: 30,
      pmNetProceedsCents: 90,
      kalshiExitFeeCents: 0,
      pmExitFeeCents: 0,
      unrealizedPnlCents: 22,
      unrealizedRoiBps: 2245,
      lastValuationAt: '2026-08-08T12:00:00.000Z',
      settledAt: null,
      realizedPnlCents: null,
      settlementSide: null,
    });
    const reduced = await store.reduceExposure(created.id, {
      expectedRemainingSharesKalshi: 3,
      expectedRemainingSharesPm: 1,
      expectedLastValuationAt: '2026-08-08T12:00:00.000Z',
      remainingSharesKalshi: 1,
      remainingSharesPm: 1,
      realizedPnlCents: 4,
      observedAt: '2026-08-08T12:01:00.000Z',
    });

    expect(reduced.remainingOpenPrincipalCents).toBe(89);
    expect(reduced.remainingOpenFeesCents).toBe(0);
    expect(reduced.remainingOpenCostCents).toBe(89);
    expect(reduced.currentValueCents).toBe(100);
    expect(reduced.unrealizedPnlCents).toBe(11);
    expect(reduced.unrealizedRoiBps).toBe(1236);
    const revalued = calculatePositionValuation({
      ...reduced,
      kalshiExitFeeMultiplierPpm: 0,
      kalshiExitFeeObservedAt: '2026-08-08T12:00:30.000Z',
      pmExitFeeObservedAt: '2026-08-08T12:00:30.000Z',
    }, {
      kalshiYesBidCents: 10,
      kalshiNoBidCents: 90,
      pmYesBidCents: 10,
      pmNoBidCents: 90,
      kalshiYesBids: [{ priceCents: 10, size: 1 }],
      pmNoBids: [{ priceCents: 90, size: 1 }],
      observedAt: '2026-08-08T12:01:00.000Z',
      expiryDate: null,
    });
    expect(revalued.currentValueCents).toBe(100);
    expect(revalued.unrealizedPnlCents).toBe(11);
    expect(revalued.unrealizedRoiBps).toBe(1236);
    expect(revalued.kalshiGrossProceedsMicrocents).toBe(10_000_000);
    expect(revalued.pmGrossProceedsMicrocents).toBe(90_000_000);
    const settled = calculatePositionValuation(reduced, {
      kalshiYesBidCents: 100,
      kalshiNoBidCents: 0,
      pmYesBidCents: 100,
      pmNoBidCents: 0,
      observedAt: '2026-08-11T00:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      kalshiResolved: true,
      pmResolved: true,
    });
    expect(settled.currentValueCents).toBe(100);
    expect(settled.realizedPnlCents).toBe(15);
    expect(summarizeBotPerformance([reduced], new Date('2026-08-08T12:02:00.000Z'))).toMatchObject({
      capital: { deployedCents: 89, currentCents: 100, heldToResolutionCents: 100 },
      pnl: { realizedCents: 4, unrealizedCents: 11, totalCents: 15, roiBps: 1685 },
    });
    const result = await store.listMarkets();
    expect(result.markets[0].currentLiveStakeCents).toBe(89);
    expect(result.markets[0].unrealizedPnlCents).toBe(11);
    expect(result.positions[0].executionPrincipalCents).toBe(97);
    expect(result.positions[0].legs.map((leg) => leg.originalPrincipalCents)).toEqual([12, 85]);
    expect(result.positions[0].legs.map((leg) => leg.remainingOpenPrincipalCents)).toEqual([4, 85]);
    expect(result.positions[0].legs.map((leg) => leg.currentLiquidationValueCents)).toEqual([10, 90]);
    expect(result.positions[0].legs.map((leg) => leg.executableDepthUsed)).toEqual([null, null]);
    await store.updateValuation(created.id, settled);
    const [terminal] = await store.list({ status: 'settled' });
    expect(terminal.realizedPnlBeforeSettlementCents).toBe(4);
    expect(terminal.realizedPnlCents).toBe(15);
    expect(summarizeBotPerformance([terminal], new Date('2026-08-11T00:01:00.000Z'))).toMatchObject({
      pnl: { realizedCents: 15, unrealizedCents: 0, totalCents: 15 },
      valuation: { pendingSettlement: 0 },
    });
    store.close();
  });

  it('preserves a recovered aggregate entry fee through reduction, restart, and settlement', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-aggregate-fee-reduction-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);
    await client.execute(`INSERT INTO executions (id, dry_run) VALUES (7, 1)`);
    client.close();

    let store = new BotPositionStore(dbUrl);
    const created = await store.create({
      ...openPosition(), id: undefined, dryRun: undefined,
      sharesKalshi: 2,
      sharesPm: 2,
      buyPriceKalshiCents: 40,
      buyPricePmCents: 55,
      kalshiEntryGrossMicrocents: 80_000_000,
      pmEntryGrossMicrocents: 110_000_000,
      kalshiEntryFills: [{ priceMicrocents: 40_000_000, sizeMicrounits: 2_000_000 }],
      pmEntryFills: [{ priceMicrocents: 55_000_000, sizeMicrounits: 2_000_000 }],
      kalshiEntryFillCount: 1,
      pmEntryFillCount: 1,
      kalshiEntryFeeCents: 1,
      pmEntryFeeCents: 2,
      feesCents: 3,
      totalCostCents: 193,
      expectedPayoutCents: 200,
      expectedProfitCents: 7,
      kalshiExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
      pmExitFeeObservedAt: '2026-08-01T00:00:00.000Z',
    } as never);
    store.close();

    const recoveryClient = createClient({ url: dbUrl });
    await recoveryClient.execute({
      sql: `UPDATE bot_positions SET kalshi_entry_fee=0,pm_entry_fee=0,entry_fee_unallocated=3,
        entry_record_source='persisted_position' WHERE id=?`,
      args: [created.id],
    });
    recoveryClient.close();

    store = new BotPositionStore(dbUrl);
    await store.updateValuation(created.id, {
      status: 'open',
      currentPriceKalshiCents: 50,
      currentPricePmCents: 50,
      currentValueCents: 200,
      kalshiGrossProceedsMicrocents: 100_000_000,
      pmGrossProceedsMicrocents: 100_000_000,
      kalshiNetProceedsCents: 100,
      pmNetProceedsCents: 100,
      kalshiExitFeeCents: 0,
      pmExitFeeCents: 0,
      unrealizedPnlCents: 7,
      unrealizedRoiBps: 363,
      lastValuationAt: '2026-08-08T12:00:00.000Z',
      settledAt: null,
      realizedPnlCents: null,
      settlementSide: null,
    });
    const reduced = await store.reduceExposure(created.id, {
      expectedRemainingSharesKalshi: 2,
      expectedRemainingSharesPm: 2,
      expectedLastValuationAt: '2026-08-08T12:00:00.000Z',
      remainingSharesKalshi: 1,
      remainingSharesPm: 1,
      realizedPnlCents: 0,
      observedAt: '2026-08-08T12:01:00.000Z',
    });
    expect(reduced.remainingOpenPrincipalCents).toBe(95);
    expect(reduced.remainingOpenFeesCents).toBe(2);
    expect(reduced.remainingOpenCostCents).toBe(97);
    store.close();

    store = new BotPositionStore(dbUrl);
    const restarted = await store.getById(created.id);
    expect(restarted).toMatchObject({
      unallocatedEntryFeeCents: 3,
      remainingOpenPrincipalCents: 95,
      remainingOpenFeesCents: 2,
      remainingOpenCostCents: 97,
    });
    const settlement = calculatePositionValuation(restarted!, {
      kalshiYesBidCents: 100,
      kalshiNoBidCents: 0,
      pmYesBidCents: 100,
      pmNoBidCents: 0,
      observedAt: '2026-08-11T00:00:00.000Z',
      expiryDate: '2026-08-10T00:00:00.000Z',
      kalshiResolved: true,
      pmResolved: true,
    });
    await store.updateValuation(created.id, settlement);
    const settled = await store.getById(created.id);
    expect(settled).toMatchObject({
      status: 'settled',
      unallocatedEntryFeeCents: 3,
      remainingOpenFeesCents: 2,
      remainingOpenCostCents: 97,
      realizedPnlCents: 3,
    });
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

  it('creates canonical entry-record columns through the checked-in migration', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-position-migration-entry-record-'));
    dirs.push(dir);
    const dbUrl = `file:${path.join(dir, 'test.db')}`;
    const client = createClient({ url: dbUrl });
    await client.execute(`CREATE TABLE executions (id INTEGER PRIMARY KEY, dry_run INTEGER NOT NULL)`);

    const migration = await readFile('src/migrations/20260808_001_create_bot_positions.sql', 'utf8');
    await client.executeMultiple(migration);
    const columns = await client.execute('PRAGMA table_info(bot_positions)');

    expect(columns.rows.map((row) => String(row.name))).toEqual(expect.arrayContaining([
      'entry_fee_unallocated', 'entry_record_version', 'entry_record_source', 'entry_recorded_at',
    ]));
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
      kalshiEntryFills: [{ priceMicrocents: 45_000_000, sizeMicrounits: 10_000_000 }],
      pmEntryFills: [{ priceMicrocents: 50_000_000, sizeMicrounits: 10_000_000 }],
    } as never);
    const currentKalshiFee = {
      feeType: 'quadratic',
      feeMultiplierPpm: 1_000_000,
      source: 'kalshi-series:KXTEST',
      observedAt: '2026-08-08T12:00:00.000Z',
      version: 'series-v1',
    } as const;
    const currentPmFee = authoritativePmFee(400, '2026-08-08T12:00:00.000Z');
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
    expect(stored.pmExitFeeSource).toContain('gamma-api.polymarket.com');
    expect(stored.pmExitFeeSchedule).toEqual({ rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 });
    expect(stored.pmExitOrderBaseFeeBps).toBe(1000);
    expect(stored.pmExitOrderFeeSource).toContain('/fee-rate?token_id=pm-no-token');
    expect(stored.dryRun).toBe(false);
  });
});

function authoritativePmFee(rateBps: number, observedAt: string) {
  const enabled = rateBps > 0;
  return {
    tokenId: 'pm-no-token', feeRateBps: rateBps, feesEnabled: enabled,
    feeSchedule: enabled ? { rate: rateBps / 10_000, exponent: 1, takerOnly: true, rebateRate: 0.25 } : null,
    orderBaseFeeBps: 1_000,
    orderSource: 'https://clob.polymarket.com/fee-rate?token_id=pm-no-token',
    orderVersion: 'token-order-base-fee:1000',
    source: 'https://gamma-api.polymarket.com/markets?condition_ids=condition-example',
    observedAt,
    version: enabled ? `gamma-fee-schedule:${rateBps}:1:true:0.25` : 'gamma-fee-schedule:disabled',
  } as const;
}

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
      fetchPmBids: async () => ({ yesBidCents: 42, noBidCents: 57, yesBids: [{ priceCents: 42, size: 10 }], noBids: [{ priceCents: 57, size: 10 }], resolved: false, noTokenId: 'pm-no-token', observedAt: '2026-08-08T12:00:00.000Z' }),
      fetchFeeConfig: async () => ({
        kalshi: { feeType: 'quadratic', feeMultiplierPpm: 1_000_000, source: 'kalshi-series', observedAt: '2026-08-08T12:00:00.000Z', version: 'v1' },
        polymarket: authoritativePmFee(400, '2026-08-08T12:00:00.000Z'), pmTheta: 0.04,
      }),
    });
    expect(peak).toBeLessThanOrEqual(8);
    expect(result).toEqual({ updated: 60, settled: 0, errors: [] });
  });

  it('rejects an opposite current token even when parent market and side still match', async () => {
    const clearOpenValuation = vi.fn(async () => undefined);
    const positionStore = {
      listAllOpen: async () => [openPosition({ id: 180, pmEntryTokenId: 'republican-no-token', pmExitTokenId: 'republican-no-token' })],
      updateValuationWithFeeConfig: vi.fn(async () => undefined),
      updateValuation: vi.fn(async () => undefined),
      clearOpenValuation,
    } as unknown as BotPositionStore;
    const result = await pollOpenBotPositions({
      positionStore,
      observedAt: '2026-08-19T12:00:00.000Z',
      fetchKalshi: async () => ({ yes_bid_dollars: '0.70', no_bid_dollars: '0.29', status: 'open' }),
      fetchKalshiBids: async () => ({ yesBids: [{ priceCents: 70, size: 10 }], noBids: [{ priceCents: 29, size: 10 }], observedAt: '2026-08-19T12:00:00.000Z' }),
      fetchPmBids: async () => ({
        yesBidCents: 90, noBidCents: 9, yesBids: [{ priceCents: 90, size: 10 }],
        noBids: [{ priceCents: 9, size: 10 }], resolved: false,
        noTokenId: 'democratic-no-token', observedAt: '2026-08-19T12:00:00.000Z',
      }),
    });
    expect(result.errors).toEqual([{ id: 180, error: expect.stringMatching(/immutable entry token/i) }]);
    expect(clearOpenValuation).toHaveBeenCalledWith(180, '2026-08-19T12:00:00.000Z', expect.stringMatching(/immutable entry token/i));
  });

  it('reuses persisted exit fee authority instead of refetching it for every valuation', async () => {
    const feeFetch = vi.fn(async () => { throw new Error('fee authority network should not be called'); });
    vi.stubGlobal('fetch', feeFetch);
    const positionStore = {
      listAllOpen: async () => [openPosition({ id: 1 })],
      updateValuationWithFeeConfig: async () => undefined,
      updateValuation: async () => undefined,
      clearOpenValuation: async () => undefined,
    } as unknown as BotPositionStore;
    const result = await pollOpenBotPositions({
      positionStore,
      observedAt: '2026-08-08T12:00:00.000Z',
      fetchKalshi: async () => ({ yes_bid_dollars: '0.48', no_bid_dollars: '0.51', status: 'open', close_time: '2026-08-10T00:00:00.000Z' }),
      fetchKalshiBids: async () => ({ yesBids: [{ priceCents: 48, size: 10 }], noBids: [{ priceCents: 51, size: 10 }], observedAt: '2026-08-08T12:00:00.000Z' }),
      fetchPmBids: async () => ({ yesBidCents: 42, noBidCents: 57, yesBids: [{ priceCents: 42, size: 10 }], noBids: [{ priceCents: 57, size: 10 }], resolved: false, noTokenId: 'pm-no-token', observedAt: '2026-08-08T12:00:00.000Z' }),
    });
    expect(result).toEqual({ updated: 1, settled: 0, errors: [] });
    expect(feeFetch).not.toHaveBeenCalled();
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
      fetchPmBids: async () => ({ yesBidCents: 42, noBidCents: 57, yesBids: [{ priceCents: 42, size: 10 }], noBids: [{ priceCents: 57, size: 10 }], resolved: false, noTokenId: 'pm-no-token', observedAt: '2026-08-08T12:00:03.000Z' }),
      fetchFeeConfig: async () => ({
        kalshi: { feeType: 'quadratic', feeMultiplierPpm: 1_000_000, source: 'kalshi-series', observedAt: '2026-08-08T12:00:10.000Z', version: 'v1' },
        polymarket: authoritativePmFee(400, '2026-08-08T12:00:10.000Z'), pmTheta: 0.04,
      }),
    });
    expect(result).toEqual({ updated: 1, settled: 0, errors: [] });
    expect(persistedAt).toBe('2026-08-08T12:00:03.000Z');
  });

  it('fails a legacy paper valuation closed when its immutable entry token is missing', async () => {
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
          pm_entry_fee_rate_bps = NULL, pm_entry_fees_enabled = NULL,
          pm_entry_fee_exponent = NULL, pm_entry_fee_taker_only = NULL,
          pm_entry_fee_rebate_rate_ppm = NULL, pm_entry_order_base_fee_bps = NULL,
          pm_entry_order_fee_source = NULL, pm_entry_order_fee_version = NULL,
          pm_entry_fee_source = NULL,
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
          resolved: false, noTokenId: 'pm-no-token', observedAt: '2026-08-08T12:00:00.000Z',
        }),
        fetchFeeConfig: async () => ({
          kalshi: { feeType: 'quadratic', feeMultiplierPpm: 1_000_000, source: 'kalshi-series', observedAt: '2026-08-08T12:00:00.000Z', version: 'v1' },
          polymarket: authoritativePmFee(400, '2026-08-08T12:00:00.000Z'),
          pmTheta: 0.04,
        }),
      })).resolves.toEqual({ updated: 0, settled: 0, errors: [{ id: created.id, error: expect.stringMatching(/immutable entry token/i) }] });

      const read = new BotPositionStore(dbUrl);
      const [valued] = await read.list({ status: 'open' });
      expect(valued.currentValueCents).toBeNull();
      expect(valued.unrealizedPnlCents).toBeNull();
      expect(valued.valuationFailureReason).toMatch(/immutable entry token/i);
      expect(valued.pmExitTokenId).toBe('pm-no-token');
      read.close();
    } finally {
      process.chdir(previousCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not reconstruct a missing entry token from current exit-fee authority', async () => {
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
          pm_entry_token_id = NULL, pm_entry_fee_rate_bps = NULL, pm_entry_fees_enabled = NULL,
          pm_entry_fee_exponent = NULL, pm_entry_fee_taker_only = NULL,
          pm_entry_fee_rebate_rate_ppm = NULL, pm_entry_order_base_fee_bps = NULL,
          pm_entry_order_fee_source = NULL, pm_entry_order_fee_version = NULL, pm_entry_fee_source = NULL,
          pm_entry_fee_observed_at = NULL, pm_entry_fee_version = NULL, category = NULL WHERE id = ?`,
        args: [created.id],
      });
      legacy.close();
      store.close();
      const result = await pollOpenBotPositions({
        positionStore: new BotPositionStore(dbUrl), observedAt: '2026-08-08T12:00:00.000Z',
        fetchKalshi: async () => ({ yes_bid_dollars: '0.48', no_bid_dollars: '0.51', status: 'open', close_time: '2026-08-10T00:00:00.000Z' }),
        fetchKalshiBids: async () => ({ yesBids: [{ priceCents: 48, size: 10 }], noBids: [{ priceCents: 51, size: 10 }], observedAt: '2026-08-08T12:00:00.000Z' }),
        fetchPmBids: async () => ({ yesBidCents: 42, noBidCents: 57, yesBids: [{ priceCents: 42, size: 10 }], noBids: [{ priceCents: 57, size: 10 }], resolved: false, noTokenId: 'pm-no-token', observedAt: '2026-08-08T12:00:00.000Z' }),
        fetchFeeConfig: async () => ({
          kalshi: { feeType: 'quadratic', feeMultiplierPpm: 1_000_000, source: 'kalshi-series', observedAt: '2026-08-08T12:00:00.000Z', version: 'v1' },
          polymarket: authoritativePmFee(0, '2026-08-08T12:00:00.000Z'), pmTheta: 0,
        }),
      });
      expect(result).toEqual({ updated: 0, settled: 0, errors: [{ id: created.id, error: expect.stringMatching(/immutable entry token/i) }] });
      const read = new BotPositionStore(dbUrl);
      const [valued] = await read.list({ status: 'open' });
      expect(valued.currentValueCents).toBeNull();
      expect(valued.pmTheta).toBe(0.04);
      expect(valued.pmExitFeeRateBps).toBe(400);
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
        fetchPmBids: async () => ({ yesBidCents: 42, noBidCents: 57, yesBids: [{ priceCents: 42, size: 10 }], noBids: [{ priceCents: 57, size: 10 }], resolved: false, noTokenId: 'pm-no-token', observedAt: '2026-08-08T12:00:00.000Z' }),
        fetchFeeConfig: async () => ({
          kalshi: { feeType: 'quadratic', feeMultiplierPpm: 1_000_000, source: 'kalshi-series', observedAt: '2026-08-08T12:00:00.000Z', version: 'v1' },
          polymarket: authoritativePmFee(400, '2026-08-08T12:00:00.000Z'), pmTheta: 0.04,
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

  it('preserves prior marks and timestamps when later depth observations fail', async () => {
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
          noTokenId: 'pm-no-token',
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
          polymarket: authoritativePmFee(400, attemptedAt),
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
      const expectPreservedAt = async (attemptedAt: string) => {
        const db = createClient({ url: dbUrl });
        const row = (await db.execute({ sql: 'SELECT * FROM bot_positions WHERE id = ?', args: [created.id] })).rows[0];
        db.close();
        expect(row.current_price_kalshi).toBe(48);
        expect(row.current_price_pm).toBe(57);
        expect(row.current_value).toBe(1000);
        expect(row.kalshi_gross_proceeds_microcents).toBe(480000000);
        expect(row.pm_gross_proceeds_microcents).toBe(570000000);
        expect(row.kalshi_net_proceeds).toBe(480);
        expect(row.pm_net_proceeds).toBe(520);
        expect(row.unrealized_pnl).toBe(50);
        expect(row.unrealized_roi_pct).toBe(526);
        expect(row.last_valuation_at).toBeNull();
        expect(row.valuation_failure_at).toBe(attemptedAt);
      };

      await setPriorMark();
      await expect(runAttempt('2026-08-08T12:00:00.000Z', [
        { priceCents: 48, size: 10 },
        { priceCents: Number.NaN, size: 1 },
      ])).resolves.toMatchObject({ updated: 0, errors: [{ id: created.id }] });
      await expectPreservedAt('2026-08-08T12:00:00.000Z');

      await setPriorMark();
      await expect(runAttempt('2026-08-08T12:01:00.000Z', [{ priceCents: 48, size: 9 }]))
        .resolves.toMatchObject({ updated: 0, errors: [{ id: created.id }] });
      await expectPreservedAt('2026-08-08T12:01:00.000Z');

      await setPriorMark();
      await expect(runAttempt(
        '2026-08-08T12:02:00.000Z',
        [{ priceCents: 48, size: 10 }],
        '2026-08-08T12:00:00.000Z',
      )).resolves.toMatchObject({ updated: 0, errors: [{ id: created.id }] });
      await expectPreservedAt('2026-08-08T12:02:00.000Z');

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
          noTokenId: 'pm-no-token',
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
