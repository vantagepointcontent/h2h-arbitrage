import { describe, expect, it } from 'vitest';
import { auditArbClassification, classifyArbType } from './arb-types';

describe('canonical arb classification', () => {
  it('recognizes same-platform YES+NO as Internal', () => {
    expect(classifyArbType('Same-platform YES+NO Kalshi: Proposition')).toBe('internal');
    expect(auditArbClassification('Same-platform YES+NO Polymarket: Proposition', 'internal')).toEqual({
      valid: true,
      canonicalType: 'internal',
      reason: null,
    });
  });

  it.each([
    'Same-platform YES+YES Kalshi: A + B',
    'Same-platform YES+YES Polymarket: A + B',
    'Same-platform YES+YES: Kalshi A + Kalshi B',
  ])('invalidates legacy duplicated directional exposure %s', (strategy) => {
    expect(classifyArbType(strategy)).toBeNull();
    expect(auditArbClassification(strategy, 'internal')).toEqual({
      valid: false,
      canonicalType: null,
      reason: 'legacy_internal_yes_yes_directional_duplication',
    });
  });

  it('rejects an explicit type that conflicts with the canonical strategy', () => {
    expect(auditArbClassification('Buy YES Kalshi + NO PM', 'internal')).toEqual({
      valid: false,
      canonicalType: null,
      reason: 'arb_type_strategy_mismatch',
    });
  });

  it.each([
    'both sides maybe',
    'Buy YES both sides: Kalshi Same + Kalshi Same',
    'Buy YES both sides: PM A + PM B',
  ])('does not absorb malformed directional pairs into Cross: %s', (strategy) => {
    expect(auditArbClassification(strategy)).toMatchObject({
      valid: false,
      canonicalType: null,
      reason: 'unrecognized_arbitrage_strategy',
    });
  });
});