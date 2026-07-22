import { describe, expect, it } from 'vitest';
import { calculateShareRatio } from './share-ratio';

describe('calculateShareRatio', () => {
  it('converts dollar stakes to shares and simplifies PM:Kalshi', () => {
    expect(calculateShareRatio(65, 0.65, 32, 0.32)).toMatchObject({
      kalshiShares: 100,
      polymarketShares: 100,
      display: '1:1',
    });
  });

  it('shows a non-even hedge ratio from actual contract amounts', () => {
    expect(calculateShareRatio(100, 0.5, 50, 0.5)?.display).toBe('1:2');
  });

  it('does not invent a ratio for missing or non-positive inputs', () => {
    expect(calculateShareRatio(0, 0.5, 50, 0.5)).toBeNull();
  });
});
