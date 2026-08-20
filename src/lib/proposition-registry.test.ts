import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import registry from '../../data/proposition-relationships.json';
import {
  appendPropositionRejection,
  buildPropositionRegistryIndex,
  canonicalPropositionRelationshipCount,
  exportPropositionReviewQueue,
  findCanonicalPropositionRelationship,
  findCanonicalPropositionRejection,
  migratePropositionRegistryV1,
  resolveCanonicalPropositionRelationship,
} from './proposition-registry';
import {
  validatePropositionRelationship,
  type PropositionRelationship,
  type PropositionRelationshipV2,
} from './proposition-identity';

const selfAsserted: PropositionRelationship = {
  schemaVersion: 1,
  state: 'verified_complementary',
  verificationSource: 'manually_verified_ids',
  verifiedAt: '2026-08-17T00:00:00.000Z',
  parentEventId: 'event',
  resolutionRuleId: 'rule',
  exhaustivePayoutStates: ['wins', 'loses'],
  humanLabel: 'self asserted',
  legs: {
    kalshi: {
      platform: 'kalshi', platformMarketId: 'KXTEST', parentEventId: 'event', selectedOutcome: 'wins',
      contractSide: 'yes', payoutState: 'wins', eventPayoutStates: ['wins', 'loses'], resolutionRuleId: 'rule',
      humanLabel: 'Kalshi YES', marketQuestion: 'Will it win?', tokenId: null,
    },
    polymarket: {
      platform: 'polymarket', platformMarketId: '0xcondition', parentEventId: 'event', selectedOutcome: 'wins',
      contractSide: 'no', payoutState: 'loses', eventPayoutStates: ['wins', 'loses'], resolutionRuleId: 'rule',
      humanLabel: 'Polymarket NO', marketQuestion: 'Will it win?', tokenId: 'no-token',
    },
  },
};

const reviewedRelationship: PropositionRelationshipV2 = {
  ...selfAsserted,
  schemaVersion: 2,
  reviewedBy: ['reviewer-a', 'reviewer-b'],
  reviewedAt: '2026-08-20T10:10:04.864Z',
  reviewTask: 'RES-849',
  evidenceRevision: 'authority-v1',
  resolutionRuleRevision: 'rule-v1',
  evidence: [{ uri: 'artifacts/authority.json', sha256: 'a'.repeat(64), observedAt: '2026-08-20T10:00:00.000Z' }],
};

describe('canonical proposition registry', () => {
  it('does not trust well-formed candidate metadata that is absent from the server registry', () => {
    expect(canonicalPropositionRelationshipCount()).toBe(2);
    expect(resolveCanonicalPropositionRelationship(selfAsserted)).toBeNull();
    expect(findCanonicalPropositionRelationship({
      kalshiTicker: 'KXTEST', pmConditionId: '0xcondition', pmTokenId: 'no-token', kalshiSide: 'yes', pmSide: 'no',
    })).toBeNull();
  });

  it('resolves the independently verified F1 control identity by exact execution identifiers', () => {
    const relationship = findCanonicalPropositionRelationship({
      kalshiTicker: 'KXF1ACTION-2026-COL',
      pmConditionId: '0xf700d212b47dbd6f262c41bb464e458458d7e8b97569eda06f74fd3f4133b961',
      pmTokenId: '38424385756462253442221613485727105608987714090195314133724025202573806948368',
      kalshiSide: 'yes',
      pmSide: 'no',
    });
    expect(relationship).toMatchObject({
      verificationSource: 'authoritative_platform_metadata',
      legs: {
        kalshi: { selectedOutcome: 'Franco Colapinto wins', payoutState: 'Franco Colapinto wins' },
        polymarket: { selectedOutcome: 'Franco Colapinto wins', payoutState: 'Franco Colapinto does not win' },
      },
    });
  });

  it('does not canonically bless the reported MO-03 or NY-21 rows without immutable outcome proof', () => {
    expect(findCanonicalPropositionRelationship({
      kalshiTicker: 'KXHOUSERACE-MO03-26-D',
      pmConditionId: '0x9041a41d6d08dc9282a5e135b0e2504d7c4950883e772a5942f17b607e354ca4',
      pmTokenId: '27237659461749395126949339507775498287619143517476509888079639110706576460737',
      kalshiSide: 'yes', pmSide: 'yes',
    })).toBeNull();
    expect(findCanonicalPropositionRelationship({
      kalshiTicker: 'KXHOUSERACE-NY21-26-R',
      pmConditionId: '0x4f3d35bc886f93949cf06a73ffdd8d14210a1d06a136ebb506f5aa653514d970',
      pmTokenId: '61536378782761462213691399252544797782501798493464719286188000407153618893171',
      kalshiSide: 'yes', pmSide: 'no',
    })).toBeNull();
  });

  it('resolves the intended MO-03 Democratic YES plus Republican YES pair exactly', () => {
    expect(findCanonicalPropositionRelationship({
      kalshiTicker: 'KXHOUSERACE-MO03-26-D',
      pmConditionId: '0xf32f28247b2a9653f52ee8078e6aa265c0fdc00b0697ef390902d86fdbef35e4',
      pmTokenId: '78731837307763791013205666606889953610367275623708569393097319597715511164419',
      kalshiSide: 'yes', pmSide: 'yes',
    })).toMatchObject({
      state: 'verified_complementary',
      legs: {
        kalshi: { payoutState: 'Democratic Party wins MO-03' },
        polymarket: { payoutState: 'Republican Party wins MO-03' },
      },
    });
  });

  it('keeps an exact rejected tuple untrusted and non-executable for the reviewed revisions', () => {
    const tuple = {
      kalshiTicker: 'KXTEST', pmConditionId: '0xcondition', pmTokenId: 'no-token',
      kalshiSide: 'yes' as const, pmSide: 'no' as const,
    };
    const index = buildPropositionRegistryIndex({
      schemaVersion: 2,
      description: 'test registry',
      relationships: [],
      rejections: [{
        schemaVersion: 1,
        executionTuple: tuple,
        evidenceRevision: 'authority-v1',
        resolutionRuleRevision: 'rule',
        rejectedBy: ['reviewer-a', 'reviewer-b'],
        rejectedAt: '2026-08-20T10:10:04.864Z',
        reviewTask: 'RES-849',
        code: 'resolution_rule_conflict',
        reason: 'The authoritative rules can resolve differently.',
        sourceScanIds: [1],
        evidence: reviewedRelationship.evidence,
      }],
    });

    expect(index.findExact(tuple)).toBeNull();
    expect(index.findRejection({ ...tuple, evidenceRevision: 'authority-v1', resolutionRuleRevision: 'rule' }))
      .toMatchObject({ code: 'resolution_rule_conflict' });
  });

  it('exports only exact tuples whose evidence or rule revision still needs review', () => {
    const rejectedTuple = {
      kalshiTicker: 'KXTEST', pmConditionId: '0xcondition', pmTokenId: 'no-token',
      kalshiSide: 'yes' as const, pmSide: 'no' as const,
    };
    const file = {
      schemaVersion: 2 as const,
      description: 'test registry',
      relationships: [],
      rejections: [{
        schemaVersion: 1 as const,
        executionTuple: rejectedTuple,
        evidenceRevision: 'authority-v1',
        resolutionRuleRevision: 'rule-v1',
        rejectedBy: ['reviewer-a', 'reviewer-b'],
        rejectedAt: '2026-08-20T10:10:04.864Z',
        reviewTask: 'RES-849',
        code: 'resolution_rule_conflict',
        reason: 'The authoritative rules can resolve differently.',
        sourceScanIds: [1],
        evidence: reviewedRelationship.evidence,
      }],
    };
    const candidates = [
      { ...rejectedTuple, evidenceRevision: 'authority-v1', resolutionRuleRevision: 'rule-v1', sourceScanIds: [1] },
      { ...rejectedTuple, evidenceRevision: 'authority-v2', resolutionRuleRevision: 'rule-v2', sourceScanIds: [2] },
      { ...rejectedTuple, pmTokenId: 'different-token', evidenceRevision: 'authority-v1', resolutionRuleRevision: 'rule-v1', sourceScanIds: [3] },
    ];

    expect(exportPropositionReviewQueue(file, candidates)).toEqual([candidates[1], candidates[2]]);
  });

  it('fails closed when a revision-aware execution lookup reports changed authority', () => {
    const index = buildPropositionRegistryIndex({
      schemaVersion: 2,
      description: 'approved registry',
      relationships: [reviewedRelationship],
      rejections: [],
    });
    const tuple = {
      kalshiTicker: 'KXTEST', pmConditionId: '0xcondition', pmTokenId: 'no-token',
      kalshiSide: 'yes' as const, pmSide: 'no' as const,
    };

    expect(index.findExact({ ...tuple, evidenceRevision: 'authority-v1', resolutionRuleRevision: 'rule-v1' }))
      .toBe(reviewedRelationship);
    expect(index.findExact({ ...tuple, evidenceRevision: 'authority-v2', resolutionRuleRevision: 'rule-v2' }))
      .toBeNull();
  });

  it('migrates a source-controlled v1 registry only with explicit review provenance', () => {
    const migrated = migratePropositionRegistryV1({
      schemaVersion: 1,
      description: 'legacy registry',
      relationships: [selfAsserted],
    }, {
      reviewedBy: ['reviewer-a', 'reviewer-b'],
      reviewedAt: '2026-08-20T10:10:04.864Z',
      reviewTask: 'RES-849',
      evidenceRevision: 'migration-authority-v1',
      resolutionRuleRevision: 'rule-v1',
      evidence: reviewedRelationship.evidence,
    });

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      rejections: [],
      relationships: [{
        schemaVersion: 2,
        reviewedBy: ['reviewer-a', 'reviewer-b'],
        evidenceRevision: 'migration-authority-v1',
      }],
    });
    expect(buildPropositionRegistryIndex(migrated).count).toBe(1);
  });

  it('fails closed on unknown registry, relationship, and rejection revisions', () => {
    expect(() => buildPropositionRegistryIndex({ schemaVersion: 99 } as never)).toThrow(/unsupported/i);
    expect(validateUnknownRelationshipRevision()).toMatchObject({ valid: false });

    const file = {
      schemaVersion: 2 as const,
      description: 'test registry',
      relationships: [],
      rejections: [{
        schemaVersion: 99,
        executionTuple: {
          kalshiTicker: 'KXTEST', pmConditionId: '0xcondition', pmTokenId: 'no-token',
          kalshiSide: 'yes' as const, pmSide: 'no' as const,
        },
      }],
    };
    expect(() => buildPropositionRegistryIndex(file as never)).toThrow(/unsupported.*rejection/i);
  });

  it('rejects duplicate decisions and approval/rejection conflicts at the same reviewed revisions', () => {
    const rejection = {
      schemaVersion: 1 as const,
      executionTuple: {
        kalshiTicker: 'KXTEST', pmConditionId: '0xcondition', pmTokenId: 'no-token',
        kalshiSide: 'yes' as const, pmSide: 'no' as const,
      },
      evidenceRevision: 'authority-v1', resolutionRuleRevision: 'rule-v1',
      rejectedBy: ['reviewer-a', 'reviewer-b'], rejectedAt: '2026-08-20T10:10:04.864Z',
      reviewTask: 'RES-849', code: 'conflict', reason: 'Rules conflict.', sourceScanIds: [1],
      evidence: reviewedRelationship.evidence,
    };
    expect(() => buildPropositionRegistryIndex({
      schemaVersion: 2, description: 'duplicate', relationships: [], rejections: [rejection, rejection],
    })).toThrow(/duplicate.*rejection/i);
    expect(() => buildPropositionRegistryIndex({
      schemaVersion: 2, description: 'conflict', relationships: [reviewedRelationship], rejections: [rejection],
    })).toThrow(/conflicting approval and rejection/i);
  });

  it('allows a newly reviewed approval to coexist with an append-only historical rejection', () => {
    const rejection = {
      schemaVersion: 1 as const,
      executionTuple: {
        kalshiTicker: 'KXTEST', pmConditionId: '0xcondition', pmTokenId: 'no-token',
        kalshiSide: 'yes' as const, pmSide: 'no' as const,
      },
      evidenceRevision: 'authority-v0', resolutionRuleRevision: 'rule-v0',
      rejectedBy: ['reviewer-a', 'reviewer-b'], rejectedAt: '2026-08-19T10:10:04.864Z',
      reviewTask: 'RES-848', code: 'conflict', reason: 'Old rules conflicted.', sourceScanIds: [1],
      evidence: reviewedRelationship.evidence,
    };

    const index = buildPropositionRegistryIndex({
      schemaVersion: 2,
      description: 'revision-aware re-review',
      relationships: [reviewedRelationship],
      rejections: [rejection],
    });

    expect(index.findExact({
      ...rejection.executionTuple,
      evidenceRevision: 'authority-v1',
      resolutionRuleRevision: 'rule-v1',
    })).toBe(reviewedRelationship);
    expect(index.findRejection({
      ...rejection.executionTuple,
      evidenceRevision: 'authority-v0',
      resolutionRuleRevision: 'rule-v0',
    })).toBe(rejection);
  });

  it.each([
    ['whitespace aliases', ['alice', ' alice :other']],
    ['empty identity component', [':service', 'h2h-backend']],
  ])('rejects rejection provenance with %s', (_label, rejectedBy) => {
    expect(() => buildPropositionRegistryIndex({
      schemaVersion: 2,
      description: 'invalid reviewer provenance',
      relationships: [],
      rejections: [{
        schemaVersion: 1,
        executionTuple: {
          kalshiTicker: 'KXTEST', pmConditionId: '0xcondition', pmTokenId: 'no-token',
          kalshiSide: 'yes', pmSide: 'no',
        },
        evidenceRevision: 'authority-v1', resolutionRuleRevision: 'rule-v1',
        rejectedBy, rejectedAt: '2026-08-20T10:10:04.864Z',
        reviewTask: 'RES-849', code: 'conflict', reason: 'Rules conflict.', sourceScanIds: [1],
        evidence: reviewedRelationship.evidence,
      }],
    })).toThrow(/distinct reviewers/i);
  });

  it('appends rejection decisions without rewriting prior ledger entries', () => {
    const file = { schemaVersion: 2 as const, description: 'ledger', relationships: [], rejections: [] };
    const rejection = {
      schemaVersion: 1 as const,
      executionTuple: {
        kalshiTicker: 'KXTEST', pmConditionId: '0xcondition', pmTokenId: 'no-token',
        kalshiSide: 'yes' as const, pmSide: 'no' as const,
      },
      evidenceRevision: 'authority-v1', resolutionRuleRevision: 'rule-v1',
      rejectedBy: ['reviewer-a', 'reviewer-b'], rejectedAt: '2026-08-20T10:10:04.864Z',
      reviewTask: 'RES-849', code: 'conflict', reason: 'Rules conflict.', sourceScanIds: [1],
      evidence: reviewedRelationship.evidence,
    };
    const appended = appendPropositionRejection(file, rejection);

    expect(file.rejections).toEqual([]);
    expect(appended.rejections).toEqual([rejection]);
    expect(() => appendPropositionRejection(appended, rejection)).toThrow(/duplicate.*rejection/i);
  });

  it('keeps the checked-in RES-849 rejected tuple absent from canonical execution lookup', () => {
    const tuple = {
      kalshiTicker: 'KXARREST-27JAN-THOM',
      pmConditionId: '0xbe555c50fc49ae7f1a970fbe13f226d179c192d87daa71c7ca082464b71fb8f6',
      pmTokenId: '27705432816847291323925622847687396001932163087018486036209592664496834211156',
      kalshiSide: 'yes' as const,
      pmSide: 'no' as const,
    };
    expect(findCanonicalPropositionRelationship(tuple)).toBeNull();
    expect(findCanonicalPropositionRejection({
      ...tuple,
      evidenceRevision: 'sha256:8d1634bef8c406b44f81ef7c6e4fc8bc1c7b2f781e2893c4d1aaa237fc689203',
      resolutionRuleRevision: 'sha256:40d6f9809707d25b6aad5d28cb4d7b719e8c7f44d0c705c16ab3d2643d7c48f5',
    })).toMatchObject({ code: 'resolution_rule_conflict', sourceScanIds: [815095, 815202, 815301] });
  });

  it('loads all 14 checked-in exact rejection tuples with complete identities and verified evidence', () => {
    expect(registry.schemaVersion).toBe(2);
    expect(registry.relationships).toHaveLength(2);
    expect(registry.rejections).toHaveLength(14);

    const exactTuples = new Set<string>();
    for (const rejection of registry.rejections) {
      const tuple = rejection.executionTuple;
      for (const identity of [
        tuple.kalshiTicker,
        tuple.pmConditionId,
        tuple.pmTokenId,
        tuple.kalshiSide,
        tuple.pmSide,
      ]) {
        expect(identity.trim()).not.toBe('');
      }
      exactTuples.add([
        tuple.kalshiTicker,
        tuple.pmConditionId,
        tuple.pmTokenId,
        tuple.kalshiSide,
        tuple.pmSide,
      ].join('\u0000'));

      expect(findCanonicalPropositionRelationship(tuple)).toBeNull();
      expect(findCanonicalPropositionRejection({
        ...tuple,
        evidenceRevision: rejection.evidenceRevision,
        resolutionRuleRevision: rejection.resolutionRuleRevision,
      })).toEqual(rejection);

      for (const evidence of rejection.evidence) {
        const evidencePath = path.resolve(process.cwd(), evidence.uri);
        const digest = createHash('sha256').update(readFileSync(evidencePath)).digest('hex');
        expect(digest).toBe(evidence.sha256);
      }
    }
    expect(exactTuples.size).toBe(14);
  });
});

function validateUnknownRelationshipRevision() {
  const unknown = { ...selfAsserted, schemaVersion: 99 };
  return validatePropositionRelationship(unknown as never);
}
