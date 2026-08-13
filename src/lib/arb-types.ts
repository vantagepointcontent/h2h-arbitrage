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
