import { describe, expect, it, vi } from 'vitest';
import {
  applyLegacyExposureReconciliation,
  classifyLegacyExposure,
  type LegacyExposurePositionEvidence,
} from './bot-legacy-exposure-reconciliation';

function evidence(overrides: Partial<LegacyExposurePositionEvidence> = {}): LegacyExposurePositionEvidence {
  return {
    position: {
      id: 73,
      executionId: 101,
      executionMode: 'paper',
      status: 'open',
      openedAt: '2026-08-11T01:37:02.445Z',
      kalshiTicker: 'HOUSECO8-26-R',
      pmConditionId: '0xco08',
      pmEntryTokenId: null,
      kalshiSide: 'yes',
      pmSide: 'yes',
      sharesKalshi: 1,
      sharesPm: 1,
      outcomeIdentityStatus: 'unresolved',
      propositionRelationshipState: 'unknown',
      legacyExposureRevision: null,
    },
    execution: {
      id: 101,
      timestamp: '2026-08-11T01:37:02.445Z',
      dryRun: true,
      success: true,
      kalshiOrder: { marketId: 'HOUSECO8-26-R', ticker: 'HOUSECO8-26-R', outcome: 'yes', contracts: 1 },
      polymarketOrder: { marketId: '68021205636604056509276509067526372089338487160185591169779941190006739682906', outcome: 'yes', contracts: 1 },
      result: {
        success: true,
        rollbackExecuted: false,
        unhedged: false,
        kalshiResult: { status: 'filled', filledContracts: 1, orderId: 'dry-k' },
        polymarketResult: { status: 'filled', filledContracts: 1, orderId: 'dry-p' },
      },
    },
    relationshipAuthority: {
      verdict: 'confirmed_invalid',
      source: 'bot-proposition-audit-v1',
      sourceRevision: 'sha256:audit',
      capturedAt: '2026-08-19T14:57:00.000Z',
      kalshiMarketQuestion: 'Will Republican win CO-08?',
      pmMarketQuestion: 'Will the Republican Party win CO-08?',
      kalshiOutcomeLabel: 'Republican',
      pmOutcomeLabel: 'Republican',
    },
    pmTokenAuthority: {
      tokenId: '68021205636604056509276509067526372089338487160185591169779941190006739682906',
      marketId: '0xco08',
      side: 'yes',
      source: 'immutable-venue-metadata-v1',
      sourceRevision: 'sha256:token-binding',
      capturedAt: '2026-08-19T12:00:00.000Z',
    },
    ...overrides,
  };
}

describe('classifyLegacyExposure', () => {
  it('proves exact simulated same-direction exposure from immutable requests and fills without calling it arbitrage', () => {
    expect(classifyLegacyExposure(evidence())).toMatchObject({
      version: 1,
      relationshipValidity: 'confirmed_invalid',
      exposureIdentity: 'exact_held_legs_proven',
      valuationClass: 'invalid_unverified_exposure',
      executionMode: 'paper',
      exactLegs: {
        kalshi: { marketId: 'HOUSECO8-26-R', side: 'yes', filledQuantity: 1, orderId: 'dry-k', outcomeLabel: 'Republican' },
        polymarket: {
          marketId: '0xco08',
          tokenId: '68021205636604056509276509067526372089338487160185591169779941190006739682906',
          side: 'yes',
          filledQuantity: 1,
          orderId: 'dry-p',
          outcomeLabel: 'Republican',
        },
      },
      excludedFromVerifiedTotals: true,
      tradeAuthorization: 'denied',
      closeAuthorization: 'denied',
    });
  });

  it('keeps opposite-proposition YES/YES unresolved when no exact relationship authority exists', () => {
    const result = classifyLegacyExposure(evidence({ relationshipAuthority: null }));
    expect(result.relationshipValidity).toBe('unresolved_relationship');
    expect(result.exposureIdentity).toBe('exact_held_legs_proven');
    expect(result.valuationClass).toBe('invalid_unverified_exposure');
    expect(result.exactLegs.kalshi.outcomeLabel).toBeNull();
    expect(result.exactLegs.polymarket.outcomeLabel).toBeNull();
  });

  it('refuses an execution request token that is not independently bound to the exact market and side', () => {
    const result = classifyLegacyExposure(evidence({ pmTokenAuthority: null }));
    expect(result.exposureIdentity).toBe('partially_proven');
    expect(result.exactLegs.polymarket.tokenId).toBeNull();
    expect(result.reason).toMatch(/token.*not independently bound/i);
  });

  it('refuses token authority bound to a different market or reordered side', () => {
    for (const pmTokenAuthority of [
      { ...evidence().pmTokenAuthority!, marketId: '0xdifferent' },
      { ...evidence().pmTokenAuthority!, side: 'no' as const },
    ]) {
      const result = classifyLegacyExposure(evidence({ pmTokenAuthority }));
      expect(result.exposureIdentity).toBe('partially_proven');
      expect(result.exactLegs.polymarket.tokenId).toBeNull();
    }
  });

  it('recognizes same-proposition YES/NO only from canonical authority', () => {
    const result = classifyLegacyExposure(evidence({
      position: { ...evidence().position, pmSide: 'no', outcomeIdentityStatus: 'verified', propositionRelationshipState: 'verified_complementary' },
      execution: {
        ...evidence().execution!,
        polymarketOrder: { ...evidence().execution!.polymarketOrder, outcome: 'no' },
      },
      pmTokenAuthority: { ...evidence().pmTokenAuthority!, side: 'no' },
      relationshipAuthority: {
        verdict: 'verified_complementary', source: 'canonical-proposition-relationship-v1', sourceRevision: 'sha256:registry',
        capturedAt: '2026-08-19T10:00:00.000Z', kalshiMarketQuestion: 'Question', pmMarketQuestion: 'Question',
        kalshiOutcomeLabel: 'Outcome A', pmOutcomeLabel: 'Outcome A',
      },
    }));
    expect(result).toMatchObject({
      relationshipValidity: 'verified_complementary', exposureIdentity: 'exact_held_legs_proven',
      valuationClass: 'verified_arbitrage', excludedFromVerifiedTotals: false,
    });
  });

  it.each([
    ['missing entry token', { execution: { ...evidence().execution!, polymarketOrder: { marketId: '0xco08', outcome: 'yes', contracts: 1 } } }, 'partially_proven'],
    ['zero fills', { execution: { ...evidence().execution!, success: false, result: { ...evidence().execution!.result, success: false, kalshiResult: { status: 'cancelled', filledContracts: 0 }, polymarketResult: { status: 'cancelled', filledContracts: 0 } } } }, 'no_fill_rolled_back'],
    ['verified rollback', { execution: { ...evidence().execution!, success: false, result: { ...evidence().execution!.result, success: false, rollbackExecuted: true, unhedged: false } } }, 'no_fill_rolled_back'],
    ['partial fill', { execution: { ...evidence().execution!, success: false, result: { ...evidence().execution!.result, success: false, kalshiResult: { status: 'cancelled', filledContracts: 0 }, polymarketResult: { status: 'partial', filledContracts: 1 } } } }, 'partially_proven'],
  ])('classifies %s without inventing exposure', (_name, overrides, expected) => {
    expect(classifyLegacyExposure(evidence(overrides as never)).exposureIdentity).toBe(expected);
  });

  it('does not use stale scan labels, strategy text, rounded prices, or outcome-array position as relationship authority', () => {
    const result = classifyLegacyExposure(evidence({
      relationshipAuthority: null,
      nonAuthoritativeContext: {
        strategy: 'Buy YES both sides: Kalshi Republican + PM Democratic',
        scanOutcomeLabel: 'Republican',
        roundedPricesCents: [28, 29],
        outcomeArrayIndex: 0,
      },
    }));
    expect(result.relationshipValidity).toBe('unresolved_relationship');
    expect(result.exactLegs.kalshi.outcomeLabel).toBeNull();
  });

  it('classifies explicitly conflicting multi-outcome authority separately', () => {
    const result = classifyLegacyExposure(evidence({ relationshipAuthority: {
      verdict: 'non_exhaustive_conflicting', source: 'immutable-venue-metadata-v1', sourceRevision: 'sha256:multi',
      capturedAt: '2026-08-19T10:00:00.000Z', kalshiMarketQuestion: null, pmMarketQuestion: null,
      kalshiOutcomeLabel: null, pmOutcomeLabel: null,
    } }));
    expect(result.relationshipValidity).toBe('non_exhaustive_conflicting');
    expect(result.valuationClass).toBe('invalid_unverified_exposure');
  });
});

describe('applyLegacyExposureReconciliation', () => {
  it('uses a revision fence and aborts the transaction on any changed row', async () => {
    const execute = vi.fn().mockResolvedValueOnce({ rowsAffected: 1 }).mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(applyLegacyExposureReconciliation([
      { positionId: 1, expectedRevision: 'rev-1', before: null, after: classifyLegacyExposure(evidence()) },
      { positionId: 2, expectedRevision: 'rev-2', before: null, after: classifyLegacyExposure(evidence({ position: { ...evidence().position, id: 2 } })) },
    ], { execute }, 'run-1')).rejects.toThrow(/position 2 changed after forensic planning/i);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0].sql).toContain('legacy_exposure_revision IS ?');
    expect(execute.mock.calls[0][0].sql).not.toContain('pm_entry_token_id');
  });
});
