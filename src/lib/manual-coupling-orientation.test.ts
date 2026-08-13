import { describe, expect, it } from 'vitest';
import { normalizeManualPairPolymarketShape } from './matcher';

const shape = {
  marketId: 'm', conditionId: 'c', yesPrice: 0.2, noPrice: 0.8,
  bestBid: 0.19, bestAsk: 0.21, lastTradePrice: 0.2,
  askDepth: 11, noAskDepth: 22, isExecutable: true,
};

describe('manual coupling orientation normalization', () => {
  it('preserves same-proposition legacy behavior', () => {
    expect(normalizeManualPairPolymarketShape(shape, 'same')).toEqual(shape);
    expect(normalizeManualPairPolymarketShape(shape, undefined)).toEqual(shape);
  });

  it('swaps YES and NO economic fields once and records auditable originals', () => {
    const normalized = normalizeManualPairPolymarketShape(shape, 'inverted');
    expect(normalized).toEqual(expect.objectContaining({
      yesPrice: 0.8, noPrice: 0.2, bestAsk: 0.8, askDepth: 22,
      couplingOrientation: 'inverted',
      couplingAudit: { originalYesPrice: 0.2, originalNoPrice: 0.8, originalSide: 'YES', normalizedSide: 'NO' },
    }));
    expect(normalizeManualPairPolymarketShape(normalized, 'inverted')).toBe(normalized);
    expect(normalizeManualPairPolymarketShape(normalized, 'same')).toBe(normalized);
  });
});
