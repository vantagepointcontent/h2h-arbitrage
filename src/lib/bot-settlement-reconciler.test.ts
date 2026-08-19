import { describe, expect, it, vi } from 'vitest';
import type { BotPosition } from './bot-positions';
import {
  buildSettlementExecutionEvidence,
  normalizeKalshiSettlementCredit,
  normalizePolymarketRedeemablePosition,
  normalizePolymarketRedemptionCredit,
  reconcileBotPositionSettlements,
  settlementCandidateKind,
  type SettlementExecutionRecord,
} from './bot-settlement-reconciler';

const position = {
  id: 46, executionId: 68, executionMode: 'paper', marketTitle: 'Where will Rodri transfer?',
  kalshiTicker: 'KXJOINCLUB-26OCT02RODRI-BAR',
  pmConditionId: '0x598d0c3d015afb9092434b82913046b272c41e11479b3d64ed4447f3699045c1',
  pmEntryTokenId: '56156713560137973218753489429118977730121367668470521575762096245892997672262',
  kalshiSide: 'yes', pmSide: 'no', sharesKalshi: 1, sharesPm: 1,
  remainingSharesKalshi: 1, remainingSharesPm: 1, totalCostCents: 96,
  remainingOpenCostCents: 96, realizedPnlCents: null, openedAt: '2026-08-10T03:22:11.567Z',
  expiryDate: null, status: 'open',
} as BotPosition;

const execution: SettlementExecutionRecord = {
  id: 68,
  dryRun: true,
  success: true,
  kalshiOrder: { marketId: position.kalshiTicker, ticker: position.kalshiTicker, outcome: 'yes', contracts: 1 },
  polymarketOrder: { marketId: position.pmConditionId, conditionId: position.pmConditionId, outcome: 'no', contracts: 1 },
  result: {
    success: true,
    rollbackExecuted: false,
    kalshiResult: { status: 'filled', filledContracts: 1, orderId: 'dry-k' },
    polymarketResult: { status: 'filled', filledContracts: 1, orderId: 'dry-p' },
  },
  botEntryEvidence: null,
};

describe('buildSettlementExecutionEvidence', () => {
  it('reconstructs a successful paper exposure only when exact durable identifiers agree', () => {
    expect(buildSettlementExecutionEvidence(position, execution)).toEqual([
      expect.objectContaining({
        venue: 'kalshi', marketId: position.kalshiTicker, outcomeId: `${position.kalshiTicker}:YES`,
        side: 'yes', requestedQuantity: 1, filledQuantity: 1, orderId: 'dry-k',
        fillIds: ['dry-k:simulated-fill'], exposureState: 'filled', mode: 'paper',
      }),
      expect.objectContaining({
        venue: 'polymarket', marketId: position.pmConditionId, outcomeId: position.pmEntryTokenId,
        side: 'no', requestedQuantity: 1, filledQuantity: 1, orderId: 'dry-p',
        fillIds: ['dry-p:simulated-fill'], exposureState: 'filled', mode: 'paper',
      }),
    ]);
  });

  it('preserves missing legacy token evidence instead of deriving it from the current market', () => {
    const [kalshi, polymarket] = buildSettlementExecutionEvidence({ ...position, pmEntryTokenId: null }, execution);
    expect(kalshi.exposureState).toBe('filled');
    expect(polymarket).toMatchObject({ outcomeId: null, exposureState: 'unknown' });
  });

  it('does not treat a failed, zero-fill, rolled-back, or live evidence-incomplete result as a fill', () => {
    const failed = buildSettlementExecutionEvidence(position, {
      ...execution,
      success: false,
      result: {
        ...execution.result,
        success: false,
        kalshiResult: { status: 'failed', filledContracts: 0, orderId: 'k-fail' },
        polymarketResult: { status: 'partial', filledContracts: null, orderId: 'p-unknown' },
      },
    });
    expect(failed.map((leg) => leg.exposureState)).toEqual(['unknown', 'unknown']);

    const provenNoExposure = buildSettlementExecutionEvidence({
      ...position,
      remainingSharesKalshi: 0,
    }, {
      ...execution,
      success: false,
      result: {
        ...execution.result,
        success: false,
        kalshiResult: { status: 'failed', filledContracts: 0, orderId: 'k-fail' },
      },
    });
    expect(provenNoExposure[0].exposureState).toBe('failed');

    const live = buildSettlementExecutionEvidence({ ...position, executionMode: 'live' }, { ...execution, dryRun: false });
    expect(live.every((leg) => leg.exposureState === 'unknown')).toBe(true);
  });
});

describe('live settlement credit normalization', () => {
  it('accepts an exact Kalshi settlement credit and rejects aggregate exposure that cannot be allocated', () => {
    const leg = { ...buildSettlementExecutionEvidence(position, execution)[0], mode: 'live' as const };
    expect(normalizeKalshiSettlementCredit({ settlements: [{
      ticker: position.kalshiTicker,
      market_result: 'yes',
      yes_count_fp: '1.00',
      yes_total_cost_dollars: '0.4400',
      no_count_fp: '0.00',
      no_total_cost_dollars: '0.0000',
      revenue: 100,
      settled_time: '2026-08-20T09:00:00.000Z',
      fee_cost: '0.0000',
    }] }, leg, 'yes')).toEqual({
      creditState: 'credited',
      creditedAt: '2026-08-20T09:00:00.000Z',
      settlementFeeCents: 0,
      sourceVersion: 'settlement:2026-08-20T09:00:00.000Z:yes:1.00:0.00:100:0.0000',
    });
    expect(normalizeKalshiSettlementCredit({ settlements: [{
      ticker: position.kalshiTicker,
      market_result: 'yes', yes_count_fp: '2.00', no_count_fp: '0.00',
      revenue: 200, settled_time: '2026-08-20T09:00:00.000Z', fee_cost: '0.0000',
    }] }, leg, 'yes')).toBeNull();
  });

  it('accepts only an exact Polymarket redemption cash flow for the held token', () => {
    const leg = { ...buildSettlementExecutionEvidence(position, execution)[1], mode: 'live' as const };
    expect(normalizePolymarketRedemptionCredit([{
      proxyWallet: '0x0000000000000000000000000000000000000001',
      timestamp: 1_776_931_200,
      conditionId: position.pmConditionId,
      type: 'REDEEM',
      size: 1,
      usdcSize: 1,
      transactionHash: '0xredeem',
      asset: position.pmEntryTokenId,
    }], leg, 'no')).toEqual({
      creditState: 'credited',
      creditedAt: '2026-04-23T08:00:00.000Z',
      settlementFeeCents: 0,
      sourceVersion: 'redeem:0xredeem:1776931200:1:1',
    });
    expect(normalizePolymarketRedemptionCredit([{
      timestamp: 1_776_931_200, conditionId: position.pmConditionId, type: 'REDEEM',
      size: 1, usdcSize: 1, transactionHash: '0xwrong', asset: 'other-token',
    }], leg, 'no')).toBeNull();
  });

  it('keeps an exact resolved Polymarket token separate while it is only redeemable', () => {
    const leg = { ...buildSettlementExecutionEvidence(position, execution)[1], mode: 'live' as const };
    expect(normalizePolymarketRedeemablePosition([{
      asset: position.pmEntryTokenId,
      conditionId: position.pmConditionId,
      size: 1,
      redeemable: true,
    }], leg)).toEqual({
      creditState: 'redeemable',
      settlementFeeCents: 0,
      sourceVersion: `redeemable:${position.pmConditionId}:${position.pmEntryTokenId}:1`,
    });
  });
});

describe('reconcileBotPositionSettlements', () => {
  it('does not quarantine evidence-incomplete positions before expiry without terminal venue evidence', () => {
    expect(settlementCandidateKind({ ...position, expiryDate: '2026-10-01T00:00:00.000Z' }, null, Date.parse('2026-08-19T12:00:00.000Z')))
      .toBe('skip');
    expect(settlementCandidateKind({ ...position, expiryDate: '2026-08-01T00:00:00.000Z' }, null, Date.parse('2026-08-19T12:00:00.000Z')))
      .toBe('immediate');
    expect(settlementCandidateKind({ ...position, expiryDate: null }, null, Date.parse('2026-08-19T12:00:00.000Z')))
      .toBe('probe');
    expect(settlementCandidateKind(position, 'settlement_unresolved', Date.parse('2026-08-19T12:00:00.000Z')))
      .toBe('immediate');
  });

  it('persists fail-closed legacy backfill without making venue calls', async () => {
    const persist = vi.fn(async () => true);
    const fetchKalshiResolution = vi.fn();
    const fetchPmResolution = vi.fn();
    const result = await reconcileBotPositionSettlements({
      positions: [{ ...position, pmEntryTokenId: null }],
      loadExecution: async () => execution,
      fetchKalshiResolution,
      fetchPmResolution,
      persist,
      observedAt: '2026-08-19T12:00:02.000Z',
    });

    expect(result).toEqual({ scanned: 1, persisted: 1, settled: 0, unresolved: 1, errors: [] });
    expect(fetchKalshiResolution).not.toHaveBeenCalled();
    expect(fetchPmResolution).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledWith(46, expect.objectContaining({
      positionState: 'settlement_unresolved', realizedPnlCents: null,
      failureReason: 'Settlement unresolved — exact legacy leg evidence missing',
    }));
  });

  it('persists authoritative two-venue paper settlement and remains idempotent', async () => {
    const persisted = new Map<number, unknown>();
    const persist = vi.fn(async (id: number, value: unknown) => {
      persisted.set(id, value);
      return true;
    });
    const deps = {
      positions: [position],
      loadExecution: async () => execution,
      fetchKalshiResolution: async () => ({
        venue: 'kalshi' as const, marketId: position.kalshiTicker!, outcomeId: `${position.kalshiTicker}:YES`,
        winningSide: 'yes' as const, resolvedAt: '2026-08-19T12:00:00.000Z',
        source: 'kalshi_market_settlement', sourceVersion: 'settled:1',
      }),
      fetchPmResolution: async () => ({
        venue: 'polymarket' as const, marketId: position.pmConditionId!, outcomeId: position.pmEntryTokenId!,
        winningSide: 'yes' as const, resolvedAt: '2026-08-19T12:00:01.000Z',
        source: 'polymarket_clob_market', sourceVersion: 'closed:true:yes',
      }),
      persist,
      observedAt: '2026-08-19T12:00:02.000Z',
    };
    await expect(reconcileBotPositionSettlements(deps)).resolves.toEqual({
      scanned: 1, persisted: 1, settled: 1, unresolved: 0, errors: [],
    });
    await expect(reconcileBotPositionSettlements(deps)).resolves.toEqual({
      scanned: 1, persisted: 1, settled: 1, unresolved: 0, errors: [],
    });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persisted.get(46)).toMatchObject({
      positionState: 'settled', grossSettlementProceedsCents: 100,
      netSettlementProceedsCents: 100, realizedPnlCents: 4,
    });
  });

  it('bounds each venue reconciliation lookup', async () => {
    const result = await reconcileBotPositionSettlements({
      positions: [position], loadExecution: async () => execution,
      fetchKalshiResolution: async () => new Promise(() => undefined),
      fetchPmResolution: async () => null,
      persist: async () => true,
      observedAt: '2026-08-19T12:00:02.000Z', venueTimeoutMs: 5,
    });
    expect(result.errors).toEqual([{ id: 46, error: 'Kalshi settlement lookup timed out' }]);
  });

  it('settles only the authoritative remaining exposure after an early partial close', async () => {
    const reduced = {
      ...position,
      sharesKalshi: 3,
      sharesPm: 3,
      remainingSharesKalshi: 1,
      remainingSharesPm: 1,
      totalCostCents: 288,
      remainingOpenCostCents: 96,
      realizedPnlCents: 5,
    };
    const filledThree = {
      ...execution,
      kalshiOrder: { ...execution.kalshiOrder, contracts: 3 },
      polymarketOrder: { ...execution.polymarketOrder, contracts: 3 },
      result: {
        ...execution.result,
        kalshiResult: { status: 'filled', filledContracts: 3, orderId: 'dry-k' },
        polymarketResult: { status: 'filled', filledContracts: 3, orderId: 'dry-p' },
      },
    };
    const persist = vi.fn(async () => true);
    await reconcileBotPositionSettlements({
      positions: [reduced],
      loadExecution: async () => filledThree,
      fetchKalshiResolution: async () => ({
        venue: 'kalshi', marketId: position.kalshiTicker!, outcomeId: `${position.kalshiTicker}:YES`,
        winningSide: 'yes', resolvedAt: '2026-08-19T12:00:00.000Z',
        source: 'kalshi_market_settlement', sourceVersion: 'settled:1',
      }),
      fetchPmResolution: async () => ({
        venue: 'polymarket', marketId: position.pmConditionId!, outcomeId: position.pmEntryTokenId!,
        winningSide: 'yes', resolvedAt: '2026-08-19T12:00:01.000Z',
        source: 'polymarket_clob_market', sourceVersion: 'closed:true:yes',
      }),
      persist,
      observedAt: '2026-08-19T12:00:02.000Z',
    });

    expect(persist).toHaveBeenCalledWith(46, expect.objectContaining({
      positionState: 'settled', grossSettlementProceedsCents: 100,
      netSettlementProceedsCents: 100, realizedPnlCents: 9,
    }));
  });
});
