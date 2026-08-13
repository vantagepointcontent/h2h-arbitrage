import { describe, expect, it } from 'vitest';
import { parseBundledMatchInput } from './bundled-match-request';

const valid = {
  name: 'Vote share hedge', budgetCents: 10_000,
  targetRange: { minBps: null, minInclusive: false, maxBps: null, maxInclusive: false },
  legs: [
    { id: 'k', platform: 'kalshi', marketId: 'KX', title: 'Below 20', originalSide: 'no', orientation: 'same', priceCents: 90, payoutCents: 100, feeBps: 0, quantityStep: 1, minimumQuantity: 1, maximumQuantity: 1000, range: { minBps: null, minInclusive: false, maxBps: 2000, maxInclusive: false } },
    { id: 'p1', platform: 'polymarket', marketId: 'P1', title: '20-25', originalSide: 'yes', orientation: 'inverted', priceCents: 6, payoutCents: 100, feeBps: 0, quantityStep: 1, minimumQuantity: 1, maximumQuantity: 1000, range: { minBps: 2000, minInclusive: true, maxBps: 2500, maxInclusive: false } },
    { id: 'p2', platform: 'polymarket', marketId: 'P2', title: '25+', originalSide: 'yes', orientation: 'same', priceCents: 7, payoutCents: 100, feeBps: 0, quantityStep: 1, minimumQuantity: 1, maximumQuantity: 1000, range: { minBps: 2500, minInclusive: true, maxBps: null, maxInclusive: false } },
  ],
};

describe('parseBundledMatchInput', () => {
  it('accepts one-to-many bundles and retains per-leg orientation', () => {
    const parsed = parseBundledMatchInput(valid);
    expect('error' in parsed).toBe(false);
    if (!('error' in parsed)) expect(parsed.legs.map(leg => leg.orientation)).toEqual(['same', 'inverted', 'same']);
  });

  it('rejects unknown orientation and boundary gaps separately', () => {
    const badOrientation = structuredClone(valid);
    (badOrientation.legs[0] as Record<string, unknown>).orientation = 'sideways';
    expect(parseBundledMatchInput(badOrientation)).toEqual(expect.objectContaining({ error: expect.stringMatching(/orientation/i) }));

    const gap = structuredClone(valid);
    gap.legs[1].range.minInclusive = false;
    expect(parseBundledMatchInput(gap)).toEqual(expect.objectContaining({ error: expect.stringMatching(/gap/i) }));
  });

  it('rejects floating monetary values', () => {
    expect(parseBundledMatchInput({ ...valid, budgetCents: 100.5 })).toEqual(expect.objectContaining({ error: expect.stringMatching(/safe integer/i) }));
  });
});
