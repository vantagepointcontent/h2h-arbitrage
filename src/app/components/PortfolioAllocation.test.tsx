import { describe, expect, it } from 'vitest';
import { buildPortfolioAllocation } from './OpenPositionsPanel';

describe('portfolio allocation', () => {
  it('creates one slice per market plus cash with correct percentages', () => {
    const result = buildPortfolioAllocation([
      { marketTitle: 'Market A', totalValue: 300 },
      { marketTitle: 'Market B', totalValue: 200 },
    ], 500);
    expect(result).toEqual([
      { name: 'Market A', value: 300, kind: 'position', percentage: 30 },
      { name: 'Market B', value: 200, kind: 'position', percentage: 20 },
      { name: 'Cash', value: 500, kind: 'cash', percentage: 50 },
    ]);
    expect(result.reduce((sum, item) => sum + item.percentage, 0)).toBeCloseTo(100);
  });

  it('supports one position and clamps negative cash', () => {
    expect(buildPortfolioAllocation([{ marketTitle: 'Only market', totalValue: 25 }], -10)).toEqual([
      { name: 'Only market', value: 25, kind: 'position', percentage: 100 },
      { name: 'Cash', value: 0, kind: 'cash', percentage: 0 },
    ]);
  });
});
