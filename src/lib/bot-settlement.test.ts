import { describe, expect, it } from 'vitest';
import {
  reconcileSettlementLifecycle,
  type SettlementExecutionLegEvidence,
  type SettlementResolutionObservation,
} from './bot-settlement';

const paperLegs = (): SettlementExecutionLegEvidence[] => [
  {
    venue: 'kalshi', marketId: 'KX-RODRI-BAR', outcomeId: 'KX-RODRI-BAR:YES', side: 'yes',
    requestedQuantity: 1, filledQuantity: 1, orderId: 'dry-k', fillIds: ['dry-k:fill'],
    exposureState: 'filled', mode: 'paper',
  },
  {
    venue: 'polymarket', marketId: '0xbarcelona', outcomeId: 'pm-barcelona-no', side: 'no',
    requestedQuantity: 1, filledQuantity: 1, orderId: 'dry-p', fillIds: ['dry-p:fill'],
    exposureState: 'filled', mode: 'paper',
  },
];

const resolutions = (winner: 'kalshi' | 'polymarket'): SettlementResolutionObservation[] => [
  {
    venue: 'kalshi', marketId: 'KX-RODRI-BAR', outcomeId: 'KX-RODRI-BAR:YES',
    winningSide: winner === 'kalshi' ? 'yes' : 'no', resolvedAt: '2026-08-19T12:00:00.000Z',
    source: 'kalshi_market_settlement', sourceVersion: `kalshi:${winner}`,
  },
  {
    venue: 'polymarket', marketId: '0xbarcelona', outcomeId: 'pm-barcelona-no',
    winningSide: winner === 'polymarket' ? 'no' : 'yes', resolvedAt: '2026-08-19T12:00:01.000Z',
    source: 'polymarket_clob_market', sourceVersion: `pm:${winner}`,
  },
];

describe('reconcileSettlementLifecycle', () => {
  it.each(['kalshi', 'polymarket'] as const)('reconciles the same one-share paper payout when %s wins', (winner) => {
    const result = reconcileSettlementLifecycle({
      positionId: 46, executionMode: 'paper', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: paperLegs(), resolutions: resolutions(winner),
      observedAt: '2026-08-19T12:00:02.000Z',
    });

    expect(result.positionState).toBe('settled');
    expect(result.grossSettlementProceedsCents).toBe(100);
    expect(result.netSettlementProceedsCents).toBe(100);
    expect(result.realizedPnlCents).toBe(4);
    expect(result.realizedRoiBps).toBe(417);
    expect(result.legs.map((leg) => [leg.venue, leg.lifecycleState, leg.payoutEntitlementCents, leg.creditState]))
      .toEqual(winner === 'kalshi'
        ? [['kalshi', 'reconciled', 100, 'simulated_credited'], ['polymarket', 'reconciled', 0, 'not_applicable']]
        : [['kalshi', 'reconciled', 0, 'not_applicable'], ['polymarket', 'reconciled', 100, 'simulated_credited']]);
    expect(result.cashAvailableAt).toBe('2026-08-19T12:00:02.000Z');
  });

  it('fails closed when an exposed legacy Polymarket leg lacks the exact token', () => {
    const legs = paperLegs();
    legs[1] = { ...legs[1], outcomeId: null, fillIds: [] };
    const result = reconcileSettlementLifecycle({
      positionId: 46, executionMode: 'paper', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs, resolutions: resolutions('kalshi'),
      observedAt: '2026-08-19T12:00:02.000Z',
    });

    expect(result.positionState).toBe('settlement_unresolved');
    expect(result.realizedPnlCents).toBeNull();
    expect(result.grossSettlementProceedsCents).toBeNull();
    expect(result.failureReason).toBe('Settlement unresolved — exact legacy leg evidence missing');
    expect(result.legs[1]).toMatchObject({ lifecycleState: 'unresolved', payoutEntitlementCents: null });
  });

  it('keeps a resolved leg separate while the other leg remains open', () => {
    const result = reconcileSettlementLifecycle({
      positionId: 8, executionMode: 'paper', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: paperLegs(), resolutions: [resolutions('kalshi')[0]],
      observedAt: '2026-08-19T12:00:02.000Z',
    });

    expect(result.positionState).toBe('partially_settled');
    expect(result.realizedPnlCents).toBeNull();
    expect(result.legs[0]).toMatchObject({ lifecycleState: 'reconciled', payoutEntitlementCents: 100 });
    expect(result.legs[1]).toMatchObject({ lifecycleState: 'open', payoutEntitlementCents: null });
  });

  it('does not call a live winner cash-available until authoritative credit evidence arrives', () => {
    const liveLegs = paperLegs().map((leg) => ({ ...leg, mode: 'live' as const }));
    const pending = reconcileSettlementLifecycle({
      positionId: 9, executionMode: 'live', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: liveLegs, resolutions: resolutions('polymarket'),
      observedAt: '2026-08-19T12:00:02.000Z',
    });
    expect(pending.positionState).toBe('settlement_pending');
    expect(pending.realizedPnlCents).toBeNull();
    expect(pending.cashAvailableAt).toBeNull();
    expect(pending.legs[1]).toMatchObject({ lifecycleState: 'settlement_pending', creditState: 'pending' });

    const creditedResolutions = resolutions('polymarket').map((resolution) => resolution.venue === 'polymarket'
      ? { ...resolution, creditState: 'credited' as const, creditedAt: '2026-08-20T09:00:00.000Z' }
      : resolution);
    const credited = reconcileSettlementLifecycle({
      positionId: 9, executionMode: 'live', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: liveLegs, resolutions: creditedResolutions,
      observedAt: '2026-08-20T09:00:01.000Z',
    });
    expect(credited.positionState).toBe('settled');
    expect(credited.realizedPnlCents).toBe(4);
    expect(credited.cashAvailableAt).toBe('2026-08-20T09:00:00.000Z');
  });

  it.each([
    ['zero_fill', 0], ['failed', null], ['rolled_back', 0], ['closed', 0], ['unknown', null],
  ] as const)('handles %s exposure distinctly', (exposureState, filledQuantity) => {
    const legs = paperLegs();
    legs[1] = { ...legs[1], exposureState, filledQuantity };
    const result = reconcileSettlementLifecycle({
      positionId: 10, executionMode: 'paper', buyCostCents: 85,
      realizedPnlBeforeSettlementCents: exposureState === 'closed' ? 2 : 0,
      legs, resolutions: resolutions('kalshi'), observedAt: '2026-08-19T12:00:02.000Z',
    });
    if (exposureState === 'unknown') {
      expect(result.positionState).toBe('settlement_unresolved');
      expect(result.legs[1].lifecycleState).toBe('unresolved');
    } else {
      expect(result.legs[1].lifecycleState).toBe('reconciled');
      expect(result.legs[1].payoutEntitlementCents).toBe(0);
    }
  });

  it('records conflicting resolution revisions instead of changing a settled winner', () => {
    const prior = reconcileSettlementLifecycle({
      positionId: 11, executionMode: 'paper', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: paperLegs(), resolutions: resolutions('kalshi'),
      observedAt: '2026-08-19T12:00:02.000Z',
    });
    const conflict = reconcileSettlementLifecycle({
      positionId: 11, executionMode: 'paper', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: paperLegs(), resolutions: resolutions('polymarket'),
      priorLegs: prior.legs, observedAt: '2026-08-19T12:01:00.000Z',
    });
    expect(conflict.positionState).toBe('settlement_unresolved');
    expect(conflict.realizedPnlCents).toBeNull();
    expect(conflict.failureReason).toMatch(/conflicting authoritative resolution/i);
    expect(conflict.legs.every((leg) => leg.lifecycleState === 'failed')).toBe(true);
  });

  it('preserves authoritative terminal evidence when a later venue poll is incomplete', () => {
    const settled = reconcileSettlementLifecycle({
      positionId: 11, executionMode: 'paper', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: paperLegs(), resolutions: resolutions('kalshi'),
      observedAt: '2026-08-19T12:00:02.000Z',
    });
    const incomplete = reconcileSettlementLifecycle({
      positionId: 11, executionMode: 'paper', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: paperLegs(), resolutions: [],
      priorLegs: settled.legs, observedAt: '2026-08-19T12:01:00.000Z',
    });

    expect(incomplete).toEqual(settled);
  });

  it('keeps a detected authoritative conflict sticky until explicit reconciliation', () => {
    const settled = reconcileSettlementLifecycle({
      positionId: 11, executionMode: 'paper', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: paperLegs(), resolutions: resolutions('kalshi'),
      observedAt: '2026-08-19T12:00:02.000Z',
    });
    const conflict = reconcileSettlementLifecycle({
      positionId: 11, executionMode: 'paper', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: paperLegs(), resolutions: resolutions('polymarket'),
      priorLegs: settled.legs, observedAt: '2026-08-19T12:01:00.000Z',
    });
    const repeatedOriginal = reconcileSettlementLifecycle({
      positionId: 11, executionMode: 'paper', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: paperLegs(), resolutions: resolutions('kalshi'),
      priorLegs: conflict.legs, observedAt: '2026-08-19T12:02:00.000Z',
    });

    expect(repeatedOriginal.positionState).toBe('settlement_unresolved');
    expect(repeatedOriginal.realizedPnlCents).toBeNull();
    expect(repeatedOriginal.failureReason).toMatch(/conflicting authoritative resolution/i);
  });

  it('is idempotent for duplicate observations', () => {
    const first = reconcileSettlementLifecycle({
      positionId: 12, executionMode: 'paper', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: paperLegs(), resolutions: resolutions('kalshi'),
      observedAt: '2026-08-19T12:00:02.000Z',
    });
    const second = reconcileSettlementLifecycle({
      positionId: 12, executionMode: 'paper', buyCostCents: 96,
      realizedPnlBeforeSettlementCents: 0, legs: paperLegs(), resolutions: resolutions('kalshi'),
      priorLegs: first.legs, observedAt: '2026-08-19T12:05:02.000Z',
    });
    expect(second).toEqual(first);
  });
});
