import registry from '../../data/proposition-relationships.json';
import {
  validatePropositionRelationship,
  type PropositionRelationship,
} from './proposition-identity';

interface PropositionRegistryFile {
  schemaVersion: 1;
  relationships: PropositionRelationship[];
}

const parsedRegistry = registry as PropositionRegistryFile;

function canonicalJson(value: PropositionRelationship): string {
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
    schemaVersion: value.schemaVersion,
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

const canonicalRelationships = new Map<string, PropositionRelationship>();
const executionRelationships = new Map<string, PropositionRelationship>();
function executionKey(
  kalshiTicker: string,
  pmConditionId: string,
  pmTokenId: string,
  kalshiSide: 'yes' | 'no',
  pmSide: 'yes' | 'no',
): string {
  return [kalshiTicker, pmConditionId, pmTokenId, kalshiSide, pmSide]
    .map((value) => value.trim().toLowerCase())
    .join('\u0000');
}
for (const relationship of parsedRegistry.relationships) {
  const validation = validatePropositionRelationship(relationship);
  if (!validation.valid) {
    throw new Error(`Invalid canonical proposition registry entry: ${validation.reason}`);
  }
  const key = canonicalJson(relationship);
  if (canonicalRelationships.has(key)) {
    throw new Error(`Duplicate canonical proposition registry entry: ${relationship.humanLabel}`);
  }
  canonicalRelationships.set(key, relationship);
  const executionIdentity = executionKey(
    relationship.legs.kalshi.platformMarketId,
    relationship.legs.polymarket.platformMarketId,
    relationship.legs.polymarket.tokenId!,
    relationship.legs.kalshi.contractSide,
    relationship.legs.polymarket.contractSide,
  );
  if (executionRelationships.has(executionIdentity)) {
    throw new Error(`Conflicting canonical proposition registry execution identity: ${relationship.humanLabel}`);
  }
  executionRelationships.set(executionIdentity, relationship);
}

/**
 * Resolve a proposed relationship against the server-owned, human-reviewed
 * exact-ID registry. Candidate payloads cannot make themselves authoritative.
 */
export function resolveCanonicalPropositionRelationship(
  proposed: PropositionRelationship | null | undefined,
): PropositionRelationship | null {
  if (!validatePropositionRelationship(proposed).valid) return null;
  return canonicalRelationships.get(canonicalJson(proposed!)) ?? null;
}

export function canonicalPropositionRelationshipCount(): number {
  return canonicalRelationships.size;
}

/** Construct canonical metadata from the exact selected venue contracts. */
export function findCanonicalPropositionRelationship(input: {
  kalshiTicker: string | null | undefined;
  pmConditionId: string | null | undefined;
  pmTokenId: string | null | undefined;
  kalshiSide: 'yes' | 'no';
  pmSide: 'yes' | 'no';
}): PropositionRelationship | null {
  if (!input.kalshiTicker || !input.pmConditionId || !input.pmTokenId) return null;
  return executionRelationships.get(executionKey(
    input.kalshiTicker,
    input.pmConditionId,
    input.pmTokenId,
    input.kalshiSide,
    input.pmSide,
  )) ?? null;
}
