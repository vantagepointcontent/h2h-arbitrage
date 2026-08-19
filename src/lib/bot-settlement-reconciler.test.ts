import { describe, expect, it, vi } from 'vitest';
import type { BotPosition } from './bot-positions';
import {
  buildSettlementExecutionEvidence,
  reconcileBotPositionSettlements,
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
    expect(failed.map((leg) => leg.exposureState)).toEqual(['failed', 'unknown']);

    const live = buildSettlementExecutionEvidence({ ...position, executionMode: 'live' }, { ...execution, dryRun: false });
    expect(live.every((leg) => leg.exposureState === 'unknown')).toBe(true);
  });
});

describe('reconcileBotPositionSettlements', () => {
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
});
