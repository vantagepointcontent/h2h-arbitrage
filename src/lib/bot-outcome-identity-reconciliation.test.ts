import { describe, expect, it, vi } from 'vitest';
import type { PropositionRelationship } from './proposition-identity';
import {
  applyBotOutcomeIdentityReconciliation,
  isSqliteIntegrityCheckOk,
  planBotOutcomeIdentityReconciliation,
  prepareBotOutcomeIdentitySchema,
} from './bot-outcome-identity-reconciliation';

const position = {
  id: 180,
  status: 'open',
  openedAt: '2026-08-14T14:05:02.511Z',
  kalshiTicker: 'KX-NY21-R',
  pmConditionId: '0xdemocratic-question',
  pmEntryTokenId: 'democratic-no-token',
  kalshiSide: 'yes' as const,
  pmSide: 'no' as const,
  outcomeIdentityStatus: 'unresolved' as const,
};

function relationship(): PropositionRelationship {
  return {
    schemaVersion: 1,
    state: 'verified_complementary',
    verificationSource: 'manually_verified_ids',
    verifiedAt: '2026-08-19T12:00:00Z',
    parentEventId: 'ny21-2026',
    resolutionRuleId: 'ny21-rules-v1',
    exhaustivePayoutStates: ['Republicans', 'Democrats'],
    humanLabel: 'NY-21 party winner',
    legs: {
      kalshi: {
        platform: 'kalshi', platformMarketId: 'KX-NY21-R', parentEventId: 'ny21-2026',
        selectedOutcome: 'Republicans', contractSide: 'yes', payoutState: 'Republicans',
        eventPayoutStates: ['Republicans', 'Democrats'], resolutionRuleId: 'ny21-rules-v1',
        humanLabel: 'Kalshi YES — Republicans', marketQuestion: 'Will Republicans win NY-21?', tokenId: null,
      },
      polymarket: {
        platform: 'polymarket', platformMarketId: '0xdemocratic-question', parentEventId: 'ny21-2026',
        selectedOutcome: 'Democrats', contractSide: 'no', payoutState: 'Republicans',
        eventPayoutStates: ['Democrats', 'Republicans'], resolutionRuleId: 'ny21-rules-v1',
        humanLabel: 'Polymarket NO — Republicans', marketQuestion: 'Will Democrats win NY-21?', tokenId: 'democratic-no-token',
      },
    },
  };
}

describe('planBotOutcomeIdentityReconciliation', () => {
  it('records the held payout outcome rather than the affirmative proposition label', () => {
    const plan = planBotOutcomeIdentityReconciliation([position], () => relationship());
    expect(plan).toEqual({
      corrections: [expect.objectContaining({
        id: 180,
        kalshiOutcomeLabel: 'Republicans',
        pmOutcomeLabel: 'Republicans',
        pmMarketQuestion: 'Will Democrats win NY-21?',
        outcomeIdentitySource: 'canonical_proposition_relationship_v1',
      })],
      unresolved: [],
    });
  });

  it('fails closed without the immutable entry token and never substitutes an exit token', () => {
    const resolver = vi.fn(() => relationship());
    const plan = planBotOutcomeIdentityReconciliation([{ ...position, pmEntryTokenId: null }], resolver);
    expect(resolver).not.toHaveBeenCalled();
    expect(plan.corrections).toEqual([]);
    expect(plan.unresolved[0]?.reason).toMatch(/entry-token identity is missing/i);
  });

  it('does not infer identity from mutable labels when the exact canonical relationship is absent', () => {
    const plan = planBotOutcomeIdentityReconciliation([position], () => null);
    expect(plan.corrections).toEqual([]);
    expect(plan.unresolved[0]?.reason).toMatch(/canonical relationship/i);
  });

  it('downgrades a raw verified row whose labels are no longer canonically bound', () => {
    const forged = {
      ...position,
      outcomeIdentityStatus: 'verified' as const,
      kalshiMarketQuestion: 'Forged Kalshi question',
      pmMarketQuestion: 'Forged PM question',
      kalshiOutcomeLabel: 'Democrats',
      pmOutcomeLabel: 'Democrats',
    };
    const plan = planBotOutcomeIdentityReconciliation([forged], () => null);
    expect(plan.corrections).toEqual([]);
    expect(plan.unresolved).toEqual([expect.objectContaining({
      id: 180,
      previousOutcomeIdentityStatus: 'verified',
      reason: expect.stringContaining('canonical relationship'),
    })]);
  });

  it('leaves a raw verified row unchanged only when all canonical labels still match', () => {
    const canonical = relationship();
    const verified = {
      ...position,
      outcomeIdentityStatus: 'verified' as const,
      kalshiMarketQuestion: canonical.legs.kalshi.marketQuestion,
      pmMarketQuestion: canonical.legs.polymarket.marketQuestion,
      kalshiOutcomeLabel: canonical.legs.kalshi.payoutState,
      pmOutcomeLabel: canonical.legs.polymarket.payoutState,
    };
    expect(planBotOutcomeIdentityReconciliation([verified], () => canonical)).toEqual({
      corrections: [], unresolved: [],
    });
  });

  it('keeps dry-run schema preparation read-only when required columns are absent', async () => {
    const execute = vi.fn();
    await expect(prepareBotOutcomeIdentitySchema(new Set(['id', 'status']), false, execute))
      .resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an unresolved audit write when the planned identity changed concurrently', async () => {
    const plan = planBotOutcomeIdentityReconciliation([position], () => null);
    const transaction = { execute: vi.fn().mockResolvedValue({ rowsAffected: 0 }) };

    await expect(applyBotOutcomeIdentityReconciliation(
      plan,
      transaction,
      '2026-08-19T13:00:00.000Z',
    )).rejects.toThrow('Position 180 changed after identity planning');
  });

  it('CAS-fences and counts every unresolved audit write', async () => {
    const plan = planBotOutcomeIdentityReconciliation([position], () => null);
    const transaction = { execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };

    await expect(applyBotOutcomeIdentityReconciliation(
      plan,
      transaction,
      '2026-08-19T13:00:00.000Z',
    )).resolves.toEqual({ correctionsApplied: 0, unresolvedAuditsApplied: 1 });
    expect(transaction.execute).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining("outcome_identity_source = 'bug167_exact_identity_audit_v1'"),
      args: expect.arrayContaining(['2026-08-19T13:00:00.000Z', 180, 'democratic-no-token']),
    }));
  });

  it('accepts libsql integrity results regardless of the driver column label', () => {
    expect(isSqliteIntegrityCheckOk({ integrity_check: 'ok' })).toBe(true);
    expect(isSqliteIntegrityCheckOk({ 'integrity_check(1)': 'ok' })).toBe(true);
    expect(isSqliteIntegrityCheckOk({ integrity_check: 'corrupt' })).toBe(false);
  });
});
