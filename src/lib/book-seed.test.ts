import { describe, expect, it } from 'vitest';
import { parseKalshiSeedLevels } from './book-seed';

describe('parseKalshiSeedLevels', () => {
  it('keeps only complete finite binary prices with known positive depth', () => {
    expect(parseKalshiSeedLevels([
      ['0.42', '12.5'],
      ['0.42junk', '10'],
      ['0x4', '10'],
      ['0.51', 'Infinity'],
      ['0.51', '5 contracts'],
      ['1', '4'],
      ['0.60', '8'],
    ])).toEqual([
      { price: 0.42, quantity: 12.5 },
      { price: 0.6, quantity: 8 },
    ]);
  });

  it('fails closed for malformed orderbook payload shapes', () => {
    expect(parseKalshiSeedLevels(null)).toEqual([]);
    expect(parseKalshiSeedLevels([null, ['0.4'], ['0.4', -2]])).toEqual([]);
  });
});