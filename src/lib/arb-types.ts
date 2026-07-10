/**
 * Arb type classification — shared across all surfaces.
 *
 * Three arb types exist in EdgeFinder:
 * - "cross"     — YES on Kalshi outcome A + YES on Polymarket outcome B (binary, different outcomes across platforms)
 * - "direct"    — YES on platform A + NO on platform B for the SAME outcome (classic cross-platform)
 * - "internal"  — YES on BOTH outcomes on the SAME platform (binary, same platform)
 *
 * The type is derived from the strategy string that the matcher/engine produces,
 * so this module is the single source of truth for the mapping.
 */

export type ArbType = 'cross' | 'direct' | 'internal';

export interface ArbTypeMeta {
  id: ArbType;
  label: string;
  /** Tailwind classes for the badge */
  badgeClass: string;
  /** Dot color for inline indicators */
  dotClass: string;
}

export const ARB_TYPES: Record<ArbType, ArbTypeMeta> = {
  cross: {
    id: 'cross',
    label: 'Cross Arb',
    badgeClass: 'bg-blue-500/15 text-blue-400 border border-blue-500/30',
    dotClass: 'bg-blue-400',
  },
  direct: {
    id: 'direct',
    label: 'Direct Arb',
    badgeClass: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
    dotClass: 'bg-emerald-400',
  },
  internal: {
    id: 'internal',
    label: 'Internal Arb',
    badgeClass: 'bg-purple-500/15 text-purple-400 border border-purple-500/30',
    dotClass: 'bg-purple-400',
  },
};

/**
 * Classify a strategy string into an arb type.
 *
 * Strategy strings produced by matcher.ts and live-arb-engine.ts:
 * - "Buy YES Kalshi + NO PM"                      → direct
 * - "Buy YES PM + NO Kalshi"                      → direct
 * - "Buy YES both sides: Kalshi <A> + PM <B>"     → cross
 * - "Buy YES both sides: Kalshi <A> + Polymarket <B>" → cross
 * - "Same-platform YES+YES Kalshi: <A> + <B>"     → internal
 * - "Same-platform YES+YES Polymarket: <A> + <B>" → internal
 * - "No arb" / anything else                      → null
 */
export function classifyArbType(strategy: string): ArbType | null {
  if (!strategy || strategy === 'No arb') return null;

  // Cross: "Buy YES both sides: ..."
  if (/^Buy YES both sides:/.test(strategy)) return 'cross';

  // Internal: "Same-platform YES+YES ..."
  if (/^Same-platform YES\+YES/.test(strategy)) return 'internal';

  // Direct: "Buy YES Kalshi + NO PM" or "Buy YES PM + NO Kalshi"
  if (
    strategy === 'Buy YES Kalshi + NO PM' ||
    strategy === 'Buy YES PM + NO Kalshi'
  ) {
    return 'direct';
  }

  // Unknown strategy format — try to infer from keywords
  if (/both sides/i.test(strategy)) return 'cross';
  if (/same-platform/i.test(strategy)) return 'internal';
  if (/^Buy YES/i.test(strategy)) return 'direct';

  return null;
}

/** Get the metadata (label, colors) for a strategy string. Returns null for "No arb". */
export function getArbTypeMeta(strategy: string): ArbTypeMeta | null {
  const type = classifyArbType(strategy);
  if (!type) return null;
  return ARB_TYPES[type];
}