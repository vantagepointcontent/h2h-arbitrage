import registry from '../../data/proposition-relationships.json';
import {
  hasDistinctReviewerIdentities,
  validatePropositionRelationship,
  type PropositionEvidenceReference,
  type PropositionRelationship,
  type PropositionRelationshipV2,
} from './proposition-identity';

export interface PropositionExecutionTuple {
  kalshiTicker: string;
  pmConditionId: string;
  pmTokenId: string;
  kalshiSide: 'yes' | 'no';
  pmSide: 'yes' | 'no';
}

export interface PropositionExecutionLookup extends PropositionExecutionTuple {
  /** When either revision is supplied, both must exactly match the approval. */
  evidenceRevision?: string;
  resolutionRuleRevision?: string;
}

export interface PropositionRejection {
  schemaVersion: 1;
  executionTuple: PropositionExecutionTuple;
  evidenceRevision: string;
  resolutionRuleRevision: string;
  rejectedBy: string[];
  rejectedAt: string;
  reviewTask: string;
  code: string;
  reason: string;
  sourceScanIds: number[];
  evidence: PropositionEvidenceReference[];
}

export interface PropositionRegistryFileV1 {
  schemaVersion: 1;
  description?: string;
  relationships: PropositionRelationship[];
}

export interface PropositionRegistryFileV2 {
  schemaVersion: 2;
  description: string;
  relationships: PropositionRelationshipV2[];
  /** Append-only: revisions are added, never rewritten or removed. */
  rejections: PropositionRejection[];
}

export interface PropositionReviewCandidate extends PropositionExecutionTuple {
  evidenceRevision: string;
  resolutionRuleRevision: string;
  sourceScanIds: number[];
}

export type PropositionRegistryMigrationProvenance = Pick<
  PropositionRelationshipV2,
  'reviewedBy' | 'reviewedAt' | 'reviewTask' | 'evidenceRevision' | 'resolutionRuleRevision' | 'evidence'
>;

type PropositionRegistryFile = PropositionRegistryFileV1 | PropositionRegistryFileV2;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function validEvidence(reference: PropositionEvidenceReference): boolean {
  return Boolean(reference)
    && nonEmpty(reference.uri)
    && typeof reference.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(reference.sha256)
    && Number.isFinite(Date.parse(reference.observedAt));
}

function validateTuple(value: PropositionExecutionTuple): void {
  if (!value
      || !nonEmpty(value.kalshiTicker)
      || !nonEmpty(value.pmConditionId)
      || !nonEmpty(value.pmTokenId)
      || (value.kalshiSide !== 'yes' && value.kalshiSide !== 'no')
      || (value.pmSide !== 'yes' && value.pmSide !== 'no')) {
    throw new Error('Invalid canonical proposition registry execution tuple');
  }
}

function validateRejection(value: PropositionRejection): void {
  if (!value || value.schemaVersion !== 1) {
    throw new Error('Unsupported canonical proposition rejection revision');
  }
  validateTuple(value.executionTuple);
  if (!nonEmpty(value.evidenceRevision)
      || !nonEmpty(value.resolutionRuleRevision)
      || !Number.isFinite(Date.parse(value.rejectedAt))
      || !nonEmpty(value.reviewTask)
      || !nonEmpty(value.code)
      || !nonEmpty(value.reason)
      || !Array.isArray(value.sourceScanIds)
      || value.sourceScanIds.length === 0
      || value.sourceScanIds.some((scanId) => !Number.isSafeInteger(scanId) || scanId < 0)) {
    throw new Error('Invalid canonical proposition rejection provenance');
  }
  if (!hasDistinctReviewerIdentities(value.rejectedBy)) {
    throw new Error('Canonical proposition rejection requires two distinct reviewers');
  }
  if (!Array.isArray(value.evidence)
      || value.evidence.length === 0
      || value.evidence.some((reference) => !validEvidence(reference))) {
    throw new Error('Invalid canonical proposition rejection evidence');
  }
}

function relationshipJson(value: PropositionRelationship): string {
  const identity = (leg: PropositionRelationship['legs']['kalshi'] | PropositionRelationship['legs']['polymarket']) => ({
    platform: leg.platform,
    platformMarketId: leg.platformMarketId,
    parentEventId: leg.parentEventId,
    selectedOutcome: leg.selectedOutcome,
    contractSide: leg.contractSide,
    payoutState: leg.payoutState,
    eventPayoutStates: leg.eventPayoutStates,
    resolutionRuleId: leg.resolutionRuleId,
    humanLabel: leg.humanLabel,
    marketQuestion: leg.marketQuestion,
    tokenId: leg.tokenId,
  });
  return JSON.stringify({
    state: value.state,
    verificationSource: value.verificationSource,
    verifiedAt: value.verifiedAt,
    parentEventId: value.parentEventId,
    resolutionRuleId: value.resolutionRuleId,
    exhaustivePayoutStates: value.exhaustivePayoutStates,
    humanLabel: value.humanLabel,
    kalshi: identity(value.legs.kalshi),
    polymarket: identity(value.legs.polymarket),
  });
}

function executionKey(value: PropositionExecutionTuple): string {
  return [value.kalshiTicker, value.pmConditionId, value.pmTokenId, value.kalshiSide, value.pmSide]
    .map(normalized)
    .join('\u0000');
}

function rejectionKey(value: PropositionExecutionTuple & {
  evidenceRevision: string;
  resolutionRuleRevision: string;
}): string {
  return [executionKey(value), normalized(value.evidenceRevision), normalized(value.resolutionRuleRevision)].join('\u0000');
}

function tupleForRelationship(relationship: PropositionRelationship): PropositionExecutionTuple {
  return {
    kalshiTicker: relationship.legs.kalshi.platformMarketId,
    pmConditionId: relationship.legs.polymarket.platformMarketId,
    pmTokenId: relationship.legs.polymarket.tokenId!,
    kalshiSide: relationship.legs.kalshi.contractSide,
    pmSide: relationship.legs.polymarket.contractSide,
  };
}

/** Explicit v1→v2 migration; provenance must be supplied, never fabricated. */
export function migratePropositionRegistryV1(
  value: PropositionRegistryFileV1,
  provenance: PropositionRegistryMigrationProvenance,
): PropositionRegistryFileV2 {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.relationships)) {
    throw new Error('Only canonical proposition registry schema v1 can be migrated');
  }
  const migrated: PropositionRegistryFileV2 = {
    schemaVersion: 2,
    description: value.description ?? 'Human-reviewed exact proposition relationships and append-only rejections.',
    relationships: value.relationships.map((relationship) => {
      if (relationship.schemaVersion !== 1) {
        throw new Error('Registry v1 migration encountered a non-v1 relationship');
      }
      return { ...relationship, schemaVersion: 2, ...provenance };
    }),
    rejections: [],
  };
  buildPropositionRegistryIndex(migrated);
  return migrated;
}

export function buildPropositionRegistryIndex(value: PropositionRegistryFile) {
  if (!value || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new Error('Unsupported canonical proposition registry schema revision');
  }
  if (!Array.isArray(value.relationships)) {
    throw new Error('Canonical proposition registry relationships are malformed');
  }
  if (value.schemaVersion === 2 && !Array.isArray(value.rejections)) {
    throw new Error('Canonical proposition registry rejection ledger is malformed');
  }

  const canonicalRelationships = new Map<string, PropositionRelationship>();
  const executionRelationships = new Map<string, PropositionRelationship>();
  for (const relationship of value.relationships) {
    const validation = validatePropositionRelationship(relationship);
    if (!validation.valid) {
      throw new Error(`Invalid canonical proposition registry entry: ${validation.reason}`);
    }
    if (value.schemaVersion === 2 && relationship.schemaVersion !== 2) {
      throw new Error('Schema v2 canonical proposition registry contains a legacy relationship');
    }
    if (value.schemaVersion === 1 && relationship.schemaVersion !== 1) {
      throw new Error('Schema v1 canonical proposition registry contains a non-v1 relationship');
    }
    const canonicalKey = relationshipJson(relationship);
    if (canonicalRelationships.has(canonicalKey)) {
      throw new Error(`Duplicate canonical proposition registry entry: ${relationship.humanLabel}`);
    }
    canonicalRelationships.set(canonicalKey, relationship);

    const exactKey = executionKey(tupleForRelationship(relationship));
    if (executionRelationships.has(exactKey)) {
      throw new Error(`Conflicting canonical proposition registry execution identity: ${relationship.humanLabel}`);
    }
    executionRelationships.set(exactKey, relationship);
  }

  const rejections = new Map<string, PropositionRejection>();
  for (const rejection of value.schemaVersion === 2 ? value.rejections : []) {
    validateRejection(rejection);
    const key = rejectionKey({
      ...rejection.executionTuple,
      evidenceRevision: rejection.evidenceRevision,
      resolutionRuleRevision: rejection.resolutionRuleRevision,
    });
    if (rejections.has(key)) {
      throw new Error('Duplicate canonical proposition rejection revision');
    }
    const relationship = executionRelationships.get(executionKey(rejection.executionTuple));
    if (relationship?.schemaVersion === 2
        && normalized(relationship.evidenceRevision) === normalized(rejection.evidenceRevision)
        && normalized(relationship.resolutionRuleRevision) === normalized(rejection.resolutionRuleRevision)) {
      throw new Error('Conflicting approval and rejection for the same exact execution tuple');
    }
    rejections.set(key, rejection);
  }

  return {
    count: canonicalRelationships.size,
    resolve(proposed: PropositionRelationship | null | undefined): PropositionRelationship | null {
      if (!validatePropositionRelationship(proposed).valid) return null;
      const approved = canonicalRelationships.get(relationshipJson(proposed!)) ?? null;
      if (proposed?.schemaVersion === 2
          && approved?.schemaVersion === 2
          && (normalized(proposed.evidenceRevision) !== normalized(approved.evidenceRevision)
            || normalized(proposed.resolutionRuleRevision) !== normalized(approved.resolutionRuleRevision))) {
        return null;
      }
      return approved;
    },
    findExact(input: PropositionExecutionLookup): PropositionRelationship | null {
      validateTuple(input);
      const approved = executionRelationships.get(executionKey(input)) ?? null;
      const revisionAware = input.evidenceRevision != null || input.resolutionRuleRevision != null;
      if (!revisionAware) return approved;
      if (!nonEmpty(input.evidenceRevision)
          || !nonEmpty(input.resolutionRuleRevision)
          || approved?.schemaVersion !== 2
          || normalized(input.evidenceRevision) !== normalized(approved.evidenceRevision)
          || normalized(input.resolutionRuleRevision) !== normalized(approved.resolutionRuleRevision)) {
        return null;
      }
      return approved;
    },
    findRejection(input: PropositionExecutionTuple & {
      evidenceRevision: string;
      resolutionRuleRevision: string;
    }): PropositionRejection | null {
      validateTuple(input);
      if (!nonEmpty(input.evidenceRevision) || !nonEmpty(input.resolutionRuleRevision)) return null;
      return rejections.get(rejectionKey(input)) ?? null;
    },
  };
}

/**
 * Export the exact-ID review queue. Existing decisions suppress only the same
 * exact tuple and evidence/rule revisions; title similarity is never consulted.
 */
export function exportPropositionReviewQueue(
  value: PropositionRegistryFile,
  candidates: PropositionReviewCandidate[],
): PropositionReviewCandidate[] {
  const index = buildPropositionRegistryIndex(value);
  const queue = new Map<string, PropositionReviewCandidate>();
  for (const candidate of candidates) {
    validateTuple(candidate);
    if (!nonEmpty(candidate.evidenceRevision)
        || !nonEmpty(candidate.resolutionRuleRevision)
        || !Array.isArray(candidate.sourceScanIds)
        || candidate.sourceScanIds.length === 0
        || candidate.sourceScanIds.some((scanId) => !Number.isSafeInteger(scanId) || scanId < 0)) {
      throw new Error('Invalid canonical proposition review candidate');
    }
    if (index.findRejection(candidate)) continue;
    const approved = index.findExact(candidate);
    if (approved?.schemaVersion === 2
        && normalized(approved.evidenceRevision) === normalized(candidate.evidenceRevision)
        && normalized(approved.resolutionRuleRevision) === normalized(candidate.resolutionRuleRevision)) {
      continue;
    }
    const key = rejectionKey(candidate);
    const existing = queue.get(key);
    if (existing) {
      existing.sourceScanIds = [...new Set([...existing.sourceScanIds, ...candidate.sourceScanIds])].sort((a, b) => a - b);
    } else {
      queue.set(key, { ...candidate, sourceScanIds: [...new Set(candidate.sourceScanIds)].sort((a, b) => a - b) });
    }
  }
  return [...queue.values()];
}

/** The only supported ledger mutation: retain every prior entry and append one decision. */
export function appendPropositionRejection(
  value: PropositionRegistryFileV2,
  rejection: PropositionRejection,
): PropositionRegistryFileV2 {
  const appended: PropositionRegistryFileV2 = {
    ...value,
    relationships: [...value.relationships],
    rejections: [...value.rejections, rejection],
  };
  buildPropositionRegistryIndex(appended);
  return appended;
}

const canonicalIndex = buildPropositionRegistryIndex(registry as PropositionRegistryFile);

/** Resolve only against the server-owned, human-reviewed exact registry. */
export function resolveCanonicalPropositionRelationship(
  proposed: PropositionRelationship | null | undefined,
): PropositionRelationship | null {
  return canonicalIndex.resolve(proposed);
}

export function canonicalPropositionRelationshipCount(): number {
  return canonicalIndex.count;
}

/** Look up an immutable rejection decision by exact tuple and reviewed revisions. */
export function findCanonicalPropositionRejection(
  input: PropositionExecutionTuple & { evidenceRevision: string; resolutionRuleRevision: string },
): PropositionRejection | null {
  return canonicalIndex.findRejection(input);
}

/** Export pending review candidates against the server-owned registry. */
export function exportCanonicalPropositionReviewQueue(
  candidates: PropositionReviewCandidate[],
): PropositionReviewCandidate[] {
  return exportPropositionReviewQueue(registry as PropositionRegistryFile, candidates);
}

/** Construct canonical metadata from the exact selected venue contracts. */
export function findCanonicalPropositionRelationship(input: {
  kalshiTicker: string | null | undefined;
  pmConditionId: string | null | undefined;
  pmTokenId: string | null | undefined;
  kalshiSide: 'yes' | 'no';
  pmSide: 'yes' | 'no';
  evidenceRevision?: string;
  resolutionRuleRevision?: string;
}): PropositionRelationship | null {
  if (!input.kalshiTicker || !input.pmConditionId || !input.pmTokenId) return null;
  return canonicalIndex.findExact({
    kalshiTicker: input.kalshiTicker,
    pmConditionId: input.pmConditionId,
    pmTokenId: input.pmTokenId,
    kalshiSide: input.kalshiSide,
    pmSide: input.pmSide,
    evidenceRevision: input.evidenceRevision,
    resolutionRuleRevision: input.resolutionRuleRevision,
  });
}