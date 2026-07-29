import { describe, expect, it } from 'vitest';
import {
  extractParentEventSlug,
  parseOutcomePrices,
  parseOutcomes,
  type PMMarket,
} from './polymarket';

describe('parseOutcomePrices', () => {
  it('preserves valid binary Gamma prices', () => {
    expect(parseOutcomePrices('["0.42", "0.58"]')).toEqual([0.42, 0.58]);
  });

  it('returns non-executable defaults for malformed JSON or values', () => {
    expect(parseOutcomePrices('not-json')).toEqual([0, 1]);
    expect(parseOutcomePrices('["Infinity", ""]')).toEqual([0, 1]);
    expect(parseOutcomePrices('["0.3oops", "0.7"]')).toEqual([0, 0.7]);
    expect(parseOutcomePrices('["1.5", "-0.1"]')).toEqual([0, 1]);
    expect(parseOutcomePrices('["0x0.4", "0.6"]')).toEqual([0, 0.6]);
    expect(parseOutcomePrices('["0.4", "0.6junk"]')).toEqual([0.4, 1]);
  });

  it('keeps parseOutcomes safe when the price payload is malformed', () => {
    const market = {
      outcomes: '["Yes", "No"]',
      outcomePrices: '{bad json',
    } as PMMarket;

    expect(parseOutcomes(market)).toEqual({ outcomes: ['Yes', 'No'], prices: [0, 1] });
  });
});

describe('extractParentEventSlug', () => {
  it('returns only a non-empty event slug from a Gamma market payload', () => {
    expect(extractParentEventSlug({ events: [{ slug: 'us-house-control' }] })).toBe('us-house-control');
    expect(extractParentEventSlug({ events: [{ slug: '   ' }] })).toBeUndefined();
    expect(extractParentEventSlug({ events: [{ slug: 42 }] })).toBeUndefined();
    expect(extractParentEventSlug({ events: [] })).toBeUndefined();
    expect(extractParentEventSlug(null)).toBeUndefined();
  });
});
