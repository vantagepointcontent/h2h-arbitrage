import { describe, expect, it } from 'vitest';
import { parseOutcomePrices, parseOutcomes, type PMMarket } from './polymarket';

describe('parseOutcomePrices', () => {
  it('preserves valid binary Gamma prices', () => {
    expect(parseOutcomePrices('["0.42", "0.58"]')).toEqual([0.42, 0.58]);
  });

  it('returns non-executable defaults for malformed JSON or values', () => {
    expect(parseOutcomePrices('not-json')).toEqual([0, 1]);
    expect(parseOutcomePrices('["Infinity", ""]')).toEqual([0, 1]);
    expect(parseOutcomePrices('["0.3oops", "0.7"]')).toEqual([0, 0.7]);
    expect(parseOutcomePrices('["1.5", "-0.1"]')).toEqual([1.5, -0.1]);
  });

  it('keeps parseOutcomes safe when the price payload is malformed', () => {
    const market = {
      outcomes: '["Yes", "No"]',
      outcomePrices: '{bad json',
    } as PMMarket;

    expect(parseOutcomes(market)).toEqual({ outcomes: ['Yes', 'No'], prices: [0, 1] });
  });
});
