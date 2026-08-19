import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { BotSettlementStore, applySettlementProjection } from './bot-settlement-store';
import { reconcileSettlementLifecycle, type SettlementExecutionLegEvidence } from './bot-settlement';
import type { BotPosition } from './bot-positions';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const legs: SettlementExecutionLegEvidence[] = [
  {
    venue: 'kalshi', marketId: 'KXTEST', outcomeId: 'KXTEST:YES', side: 'yes',
    requestedQuantity: 1, filledQuantity: 1, orderId: 'k-1', fillIds: ['k-fill-1'],
    exposureState: 'filled', mode: 'paper',
  },
  {
    venue: 'polymarket', marketId: '0x1', outcomeId: 'pm-no', side: 'no',
    requestedQuantity: 1, filledQuantity: 1, orderId: 'p-1', fillIds: ['p-fill-1'],
    exposureState: 'filled', mode: 'paper',
  },
];

function settlement(positionId = 1) {
  return reconcileSettlementLifecycle({
    positionId, executionMode: 'paper', buyCostCents: 96, realizedPnlBeforeSettlementCents: 0,
    legs, observedAt: '2026-08-19T12:00:02.000Z',
    resolutions: [
      { venue: 'kalshi', marketId: 'KXTEST', outcomeId: 'KXTEST:YES', winningSide: 'yes', resolvedAt: '2026-08-19T12:00:00.000Z', source: 'kalshi_market_settlement', sourceVersion: 'k:v1' },
      { venue: 'polymarket', marketId: '0x1', outcomeId: 'pm-no', winningSide: 'yes', resolvedAt: '2026-08-19T12:00:01.000Z', source: 'polymarket_clob_market', sourceVersion: 'p:v1' },
    ],
  });
}

describe('BotSettlementStore', () => {
  it('persists one typed summary and exactly one row per leg idempotently', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-settlement-store-'));
    dirs.push(dir);
    const store = new BotSettlementStore(`file:${path.join(dir, 'test.db')}`);
    await store.persist(1, settlement());
    await store.persist(1, settlement());

    await expect(store.getByPositionIds([1])).resolves.toEqual(new Map([[1, settlement()]]));
    await expect(store.countRows()).resolves.toEqual({ positions: 1, legs: 2 });
    store.close();
  });

  it('does not let an older reconciliation overwrite a newer ledger revision', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-settlement-fence-'));
    dirs.push(dir);
    const store = new BotSettlementStore(`file:${path.join(dir, 'test.db')}`);
    await store.persist(1, settlement());
    const older = { ...settlement(), reconciledAt: '2026-08-19T11:59:59.000Z' };
    await expect(store.persist(1, older)).resolves.toBe(false);
    expect((await store.getByPositionIds([1])).get(1)?.reconciledAt).toBe('2026-08-19T12:00:02.000Z');
    store.close();
  });

  it('serializes concurrent ledger writers on one SQLite client', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bot-settlement-concurrent-'));
    dirs.push(dir);
    const store = new BotSettlementStore(`file:${path.join(dir, 'test.db')}`);
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.persist(index + 1, settlement(index + 1))));
    await expect(store.countRows()).resolves.toEqual({ positions: 20, legs: 40 });
    store.close();
  });
});

describe('applySettlementProjection', () => {
  const position = {
    id: 1, status: 'open', executionMode: 'paper', totalCostCents: 96,
    remainingOpenCostCents: 96, currentValueCents: 0, unrealizedPnlCents: -96,
    unrealizedRoiBps: -10_000, currentPriceKalshiCents: 0, currentPricePmCents: 0,
    realizedPnlCents: null, resolutionPayoutCents: null, resolutionValidationStatus: 'pending',
  } as BotPosition;

  it('projects authoritative paper settlement without exposing a false current mark', () => {
    expect(applySettlementProjection(position, settlement())).toMatchObject({
      status: 'settled', settlementState: 'settled', currentValueCents: null,
      unrealizedPnlCents: null, unrealizedRoiBps: null,
      settlementGrossProceedsCents: 100, settlementNetProceedsCents: 100,
      realizedPnlCents: 4, realizedRoiBps: 417, resolutionPayoutCents: 100,
      resolutionValidationStatus: 'verified', settlementFailureReason: null,
    });
  });

  it('quarantines unresolved legacy settlement from open and realized totals', () => {
    const unresolved = reconcileSettlementLifecycle({
      positionId: 1, executionMode: 'paper', buyCostCents: 96, realizedPnlBeforeSettlementCents: 0,
      legs: [legs[0], { ...legs[1], outcomeId: null, fillIds: [] }],
      resolutions: [], observedAt: '2026-08-19T12:00:02.000Z',
    });
    expect(applySettlementProjection(position, unresolved)).toMatchObject({
      status: 'open', settlementState: 'settlement_unresolved', currentValueCents: null,
      unrealizedPnlCents: null, unrealizedRoiBps: null, realizedPnlCents: null,
      settlementFailureReason: 'Settlement unresolved — exact legacy leg evidence missing',
      valuationFailureReason: 'Settlement unresolved — exact legacy leg evidence missing',
    });
  });

  it('values only the still-open leg beside terminal proceeds for partial settlement', () => {
    const partial = reconcileSettlementLifecycle({
      positionId: 1, executionMode: 'paper', buyCostCents: 96, realizedPnlBeforeSettlementCents: 0,
      legs, resolutions: [{ venue: 'kalshi', marketId: 'KXTEST', outcomeId: 'KXTEST:YES', winningSide: 'yes', resolvedAt: '2026-08-19T12:00:00.000Z', source: 'kalshi_market_settlement', sourceVersion: 'k:v1' }],
      observedAt: '2026-08-19T12:00:02.000Z',
    });
    const projected = applySettlementProjection({ ...position, currentPricePmCents: 37 }, partial);
    expect(projected).toMatchObject({
      settlementState: 'partially_settled', currentValueCents: 137,
      unrealizedPnlCents: 41, unrealizedRoiBps: 4271,
    });
  });
});
