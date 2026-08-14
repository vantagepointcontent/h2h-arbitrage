import { describe, expect, it } from 'vitest';
import { planBotPositionPmIdentityMigration } from './bot-position-pm-identity-migration';

const PARENT = '0xf700d212b47dbd6f262c41bb464e458458d7e8b97569eda06f74fd3f4133b961';
const YES_TOKEN = '42414903704366618249547146570427817032140368369434795263286643567961575256460';
const NO_TOKEN = '38424385756462253442221613485727105608987714090195314133724025202573806948368';

const snapshots = [
  { marketId: PARENT, side: 'yes' as const, tokenId: YES_TOKEN },
  { marketId: PARENT, side: 'no' as const, tokenId: NO_TOKEN },
];

function legacy(overrides: Record<string, unknown> = {}) {
  return {
    id: 141,
    status: 'open',
    pmConditionId: YES_TOKEN,
    pmEntryTokenId: YES_TOKEN,
    pmExitTokenId: YES_TOKEN,
    pmSide: 'no' as const,
    ...overrides,
  };
}

describe('planBotPositionPmIdentityMigration', () => {
  it('derives the parent condition and exact held-side token from persisted snapshots', () => {
    const plan = planBotPositionPmIdentityMigration([legacy()], snapshots);

    expect(plan.unresolved).toEqual([]);
    expect(plan.corrections).toEqual([{
      id: 141,
      oldPmConditionId: YES_TOKEN,
      oldPmEntryTokenId: YES_TOKEN,
      oldPmExitTokenId: YES_TOKEN,
      pmConditionId: PARENT,
      pmEntryTokenId: NO_TOKEN,
      pmExitTokenId: NO_TOKEN,
    }]);
  });

  it('is idempotent once condition and token identifiers are canonical', () => {
    const plan = planBotPositionPmIdentityMigration([legacy({
      pmConditionId: PARENT,
      pmEntryTokenId: NO_TOKEN,
      pmExitTokenId: NO_TOKEN,
    })], snapshots);

    expect(plan).toEqual({ corrections: [], unresolved: [] });
  });

  it('does not fabricate missing legacy fee-authority token fields', () => {
    const plan = planBotPositionPmIdentityMigration([legacy({
      pmConditionId: PARENT,
      pmEntryTokenId: null,
      pmExitTokenId: NO_TOKEN,
    })], snapshots);

    expect(plan).toEqual({ corrections: [], unresolved: [] });
  });

  it('does not fabricate fee authority from whitespace-only legacy token fields', () => {
    const plan = planBotPositionPmIdentityMigration([legacy({
      pmConditionId: PARENT,
      pmEntryTokenId: '   ',
      pmExitTokenId: NO_TOKEN,
    })], snapshots);

    expect(plan.corrections).toEqual([expect.objectContaining({
      pmEntryTokenId: null,
      pmExitTokenId: NO_TOKEN,
    })]);
  });

  it('fails closed when snapshot evidence is ambiguous or lacks the held side', () => {
    const ambiguous = planBotPositionPmIdentityMigration([legacy()], [
      ...snapshots,
      { marketId: `0x${'b'.repeat(64)}`, side: 'yes', tokenId: YES_TOKEN },
    ]);
    const missingHeldSide = planBotPositionPmIdentityMigration([legacy()], snapshots.slice(0, 1));

    expect(ambiguous.corrections).toEqual([]);
    expect(ambiguous.unresolved[0]?.reason).toMatch(/ambiguous/i);
    expect(missingHeldSide.corrections).toEqual([]);
    expect(missingHeldSide.unresolved[0]?.reason).toMatch(/held-side/i);
  });
});
