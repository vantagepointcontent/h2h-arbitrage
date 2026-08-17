export type PropositionPlatform = 'kalshi' | 'polymarket';
export type PropositionContractSide = 'yes' | 'no';
export type PropositionRelationshipState =
  | 'verified_complementary'
  | 'same_direction_invalid'
  | 'invalid_metadata'
  | 'non_exhaustive'
  | 'unknown';

/** Immutable identity of the exact purchased contract and its real-world payout. */
export interface PropositionIdentity {
  platform: PropositionPlatform;
  platformMarketId: string;
  parentEventId: string;
  selectedOutcome: string;
  contractSide: PropositionContractSide;
  payoutState: string;
  /** Exact exhaustive event states. BotTrader currently supports binary events only. */
  eventPayoutStates: string[];
  /** Stable verifier revision for equivalent platform resolution rules. */
  resolutionRuleId: string;
  humanLabel: string;
  marketQuestion: string;
  /** Required for Polymarket, absent for Kalshi. */
  tokenId: string | null;
}

export interface PropositionRelationship {
  schemaVersion: 1;
  state: 'verified_complementary';
  verificationSource: 'authoritative_platform_metadata' | 'manually_verified_ids';
  verifiedAt: string;
  parentEventId: string;
  resolutionRuleId: string;
  exhaustivePayoutStates: string[];
  legs: { kalshi: PropositionIdentity; polymarket: PropositionIdentity };
  humanLabel: string;
}

export type PropositionValidation =
  | { valid: true }
  | { valid: false; state: Exclude<PropositionRelationshipState, 'verified_complementary'>; reason: string };

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sameStates(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = left.map(normalized).sort();
  const b = right.map(normalized).sort();
  return a.every((value, index) => value === b[index]);
}

function invalid(reason: string, state: Exclude<PropositionRelationshipState, 'verified_complementary'> = 'invalid_metadata'): PropositionValidation {
  return { valid: false, state, reason };
}

function validateLeg(leg: PropositionIdentity, platform: PropositionPlatform): PropositionValidation {
  if (!leg || leg.platform !== platform) return invalid(`Missing canonical ${platform} proposition identity`);
  for (const [field, value] of Object.entries({
    platformMarketId: leg.platformMarketId,
    parentEventId: leg.parentEventId,
    selectedOutcome: leg.selectedOutcome,
    payoutState: leg.payoutState,
    resolutionRuleId: leg.resolutionRuleId,
    humanLabel: leg.humanLabel,
    marketQuestion: leg.marketQuestion,
  })) {
    if (!nonEmpty(value)) return invalid(`${platform} ${field} is missing`);
  }
  if (platform === 'polymarket' && !nonEmpty(leg.tokenId)) {
    return invalid('Polymarket proposition token ID is missing');
  }
  if (platform === 'kalshi' && leg.tokenId != null) {
    return invalid('Kalshi proposition must not contain a Polymarket token ID');
  }
  if (!Array.isArray(leg.eventPayoutStates)
      || leg.eventPayoutStates.length !== 2
      || leg.eventPayoutStates.some((state) => !nonEmpty(state))
      || new Set(leg.eventPayoutStates.map(normalized)).size !== 2) {
    return invalid(`${platform} proposition is not an exact binary exhaustive event`, 'non_exhaustive');
  }
  const selectedIndex = leg.eventPayoutStates.findIndex((state) => normalized(state) === normalized(leg.selectedOutcome));
  if (selectedIndex < 0) return invalid(`${platform} selected outcome is absent from its event payout states`);
  const expectedPayoutState = leg.contractSide === 'yes'
    ? leg.eventPayoutStates[selectedIndex]
    : leg.eventPayoutStates[1 - selectedIndex];
  if (normalized(expectedPayoutState) !== normalized(leg.payoutState)) {
    return invalid(`${platform} ${leg.contractSide.toUpperCase()} contract payout state contradicts its selected outcome`);
  }
  return { valid: true };
}

/**
 * Fail-closed proof that two purchased legs cover exactly one payout in every
 * state of the same binary resolution event. Display labels are never evidence.
 */
export function validatePropositionRelationship(value: PropositionRelationship | null | undefined): PropositionValidation {
  if (!value) return invalid('Canonical proposition relationship metadata is unavailable', 'unknown');
  if (value.schemaVersion !== 1 || value.state !== 'verified_complementary') {
    return invalid('Proposition relationship is not a supported verified revision');
  }
  if (!Number.isFinite(Date.parse(value.verifiedAt))) return invalid('Relationship verification timestamp is malformed');
  if (!nonEmpty(value.parentEventId) || !nonEmpty(value.resolutionRuleId) || !nonEmpty(value.humanLabel)) {
    return invalid('Relationship identity or human-readable label is missing');
  }
  if (value.verificationSource !== 'authoritative_platform_metadata'
      && value.verificationSource !== 'manually_verified_ids') {
    return invalid('Relationship verification provenance is unsupported');
  }
  const kalshi = validateLeg(value.legs?.kalshi, 'kalshi');
  if (!kalshi.valid) return kalshi;
  const polymarket = validateLeg(value.legs?.polymarket, 'polymarket');
  if (!polymarket.valid) return polymarket;
  const { legs } = value;
  if (normalized(legs.kalshi.parentEventId) !== normalized(value.parentEventId)
      || normalized(legs.polymarket.parentEventId) !== normalized(value.parentEventId)) {
    return invalid('Legs do not share the exact verified parent event ID');
  }
  if (normalized(legs.kalshi.resolutionRuleId) !== normalized(value.resolutionRuleId)
      || normalized(legs.polymarket.resolutionRuleId) !== normalized(value.resolutionRuleId)) {
    return invalid('Legs do not share equivalent verified resolution rules');
  }
  if (!sameStates(value.exhaustivePayoutStates, legs.kalshi.eventPayoutStates)
      || !sameStates(value.exhaustivePayoutStates, legs.polymarket.eventPayoutStates)
      || value.exhaustivePayoutStates.length !== 2) {
    return invalid('Leg payout states are not the same exact binary exhaustive set', 'non_exhaustive');
  }
  if (normalized(legs.kalshi.payoutState) === normalized(legs.polymarket.payoutState)) {
    return invalid('Both purchased contracts pay on the same real-world outcome', 'same_direction_invalid');
  }
  if (!sameStates(value.exhaustivePayoutStates, [legs.kalshi.payoutState, legs.polymarket.payoutState])) {
    return invalid('Purchased legs do not collectively exhaust the resolution event', 'non_exhaustive');
  }
  return { valid: true };
}
