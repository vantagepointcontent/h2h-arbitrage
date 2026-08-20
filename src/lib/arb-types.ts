/** Canonical arb classification shared by producers and consumers. */
export type ArbType = 'cross' | 'direct' | 'internal';
export type ArbInvalidationReason =
  | 'legacy_internal_yes_yes_directional_duplication'
  | 'arb_type_strategy_mismatch'
  | 'unrecognized_arbitrage_strategy';

export interface ArbClassificationAudit {
  valid: boolean;
  canonicalType: ArbType | null;
  reason: ArbInvalidationReason | null;
}

export interface PersistedArbClassificationInput {
  strategy: unknown;
  arb_type?: unknown;
  arb_valid?: unknown;
  arb_invalidation_reason?: unknown;
  positive_arb_count?: unknown;
}

export interface CanonicalArbProjection {
  arbType: ArbType | null;
  arbValid: 0 | 1;
  arbInvalidationReason: string | null;
  positiveArbCount: number;
}

export interface ArbTypeMeta {
  id: ArbType;
  label: string;
  badgeClass: string;
  dotClass: string;
}

export const ARB_TYPES: Record<ArbType, ArbTypeMeta> = {
  cross: { id: 'cross', label: 'Cross Arb', badgeClass: 'bg-blue-500/15 text-blue-400 border border-blue-500/30', dotClass: 'bg-blue-400' },
  direct: { id: 'direct', label: 'Direct Arb', badgeClass: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30', dotClass: 'bg-emerald-400' },
  internal: { id: 'internal', label: 'Internal Arb', badgeClass: 'bg-purple-500/15 text-purple-400 border border-purple-500/30', dotClass: 'bg-purple-400' },
};

export function classifyArbType(strategy: string): ArbType | null {
  if (!strategy || strategy === 'No arb') return null;
  // Legacy tests/imports stored the already-canonical direct discriminator.
  if (strategy === 'direct') return 'direct';
  if (/^Same-platform YES\+YES/i.test(strategy)) return null;
  if (/^Buy YES both sides: Kalshi .+ \+ (?:PM|Polymarket) .+/.test(strategy)) return 'cross';
  if (/^Same-platform YES\+NO (?:Kalshi|Polymarket): .+/.test(strategy)) return 'internal';
  if (strategy === 'Buy YES Kalshi + NO PM' || strategy === 'Buy YES PM + NO Kalshi') return 'direct';
  return null;
}

export function auditArbClassification(strategy: string, declaredType?: ArbType | null): ArbClassificationAudit {
  if (/^Same-platform YES\+YES/i.test(strategy)) {
    return { valid: false, canonicalType: null, reason: 'legacy_internal_yes_yes_directional_duplication' };
  }
  const canonicalType = classifyArbType(strategy);
  if (!canonicalType) {
    return strategy === 'No arb' || !strategy
      ? { valid: true, canonicalType: null, reason: null }
      : { valid: false, canonicalType: null, reason: 'unrecognized_arbitrage_strategy' };
  }
  if (declaredType && declaredType !== canonicalType) {
    return { valid: false, canonicalType: null, reason: 'arb_type_strategy_mismatch' };
  }
  return { valid: true, canonicalType, reason: null };
}

export function getArbTypeMeta(strategy: string): ArbTypeMeta | null {
  const type = classifyArbType(strategy);
  return type ? ARB_TYPES[type] : null;
}

/**
 * Canonical read projection for persisted Logs evidence. This corrects stale
 * classification columns without rewriting the immutable scan-time payload.
 */
export function projectCanonicalArbClassification(input: PersistedArbClassificationInput): CanonicalArbProjection {
  const strategy = typeof input.strategy === 'string' ? input.strategy : '';
  const declaredType = input.arb_type === 'direct' || input.arb_type === 'cross' || input.arb_type === 'internal'
    ? input.arb_type
    : null;
  const audit = auditArbClassification(strategy, declaredType);
  const persistedReason = typeof input.arb_invalidation_reason === 'string' && input.arb_invalidation_reason.length > 0
    ? input.arb_invalidation_reason
    : null;
  const invalidationReason = persistedReason ?? audit.reason;
  const persistedCanonicalFailure = input.arb_valid === 0 && audit.canonicalType !== null;
  const arbValid = invalidationReason === null && audit.valid && !persistedCanonicalFailure ? 1 : 0;
  const rawCount = typeof input.positive_arb_count === 'number'
    ? input.positive_arb_count
    : Number(input.positive_arb_count);
  const candidateCount = Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 0;
  const arbType = arbValid === 1 && candidateCount > 0 ? audit.canonicalType : null;

  return {
    arbType,
    arbValid,
    arbInvalidationReason: arbValid === 1 ? null : invalidationReason,
    positiveArbCount: arbType === null ? 0 : candidateCount,
  };
}
