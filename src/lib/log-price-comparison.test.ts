import { describe, expect, it } from 'vitest';
import { buildHistoricalLegs, calculatePriceChange } from './log-price-comparison';

const captured = {
  strategy: 'Buy YES Kalshi + NO PM',
  kalshiTicker: 'KX-EXACT-YES',
  pmConditionId: '0xexact',
  kalshiYesAsk: 0.42,
  kalshiNoAsk: 0.6,
  pmYesPrice: 0.61,
  pmNoPrice: 0.4,
  pmBestAsk: 0.61,
};

describe('buildHistoricalLegs', () => {
  it('uses the exact captured identifiers, outcomes, and executable scan prices', () => {
    expect(buildHistoricalLegs(captured)).toEqual([
      { platform: 'kalshi', marketId: 'KX-EXACT-YES', outcome: 'yes', priceThen: 0.42 },
      { platform: 'polymarket', marketId: '0xexact', outcome: 'no', priceThen: 0.4 },
    ]);
  });

  it('maps the opposite direct strategy without drifting to sibling outcomes', () => {
    expect(buildHistoricalLegs({ ...captured, strategy: 'Buy YES PM + NO Kalshi' })).toEqual([
      { platform: 'kalshi', marketId: 'KX-EXACT-YES', outcome: 'no', priceThen: 0.6 },
      { platform: 'polymarket', marketId: '0xexact', outcome: 'yes', priceThen: 0.61 },
    ]);
  });

  it('keeps missing historical quotes unavailable instead of fabricating zero', () => {
    const legs = buildHistoricalLegs({ ...captured, kalshiYesAsk: undefined });
    expect(legs[0].priceThen).toBeNull();
  });
});

  it('keeps missing polymarket quotes unavailable instead of fabricating zero', () => {
    const legs = buildHistoricalLegs({ ...captured, pmNoPrice: undefined });
    expect(legs[1].priceThen).toBeNull();
  });

  it('treats non-finite historical prices as unavailable', () => {
    const legs = buildHistoricalLegs({ ...captured, kalshiYesAsk: NaN });
    expect(legs[0].priceThen).toBeNull();
  });

describe('calculatePriceChange', () => {
  it.each([
    [0.4, 0.5, 0.1, 25, 'up'],
    [0.5, 0.4, -0.1, -20, 'down'],
    [0.5, 0.5, 0, 0, 'unchanged'],
  ] as const)('calculates signed absolute and percentage change', (then, now, absolute, percentage, direction) => {
    expect(calculatePriceChange(then, now)).toEqual({ absolute, percentage, direction });
  });

  it('does not invent a percentage when the historical price is unavailable', () => {
    expect(calculatePriceChange(null, 0.5)).toBeNull();
  });
});
