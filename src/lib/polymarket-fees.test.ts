import { describe, expect, it } from 'vitest';
import {
  calculatePolymarketFeeMicrousd,
  getPolymarketCategoryFeeRateBps,
  resolvePolymarketFeeRateBps,
} from './polymarket-fees';

describe('Polymarket economic fees', () => {
  it.each([
    ['Sports', 500],
    ['Politics', 400],
    ['Finance', 400],
    ['Crypto', 700],
    ['Geopolitics', 0],
    ['Culture', 0],
    ['Weather', 0],
    [undefined, 0],
  ])('uses the current category matrix for %s', (category, expectedRateBps) => {
    expect(getPolymarketCategoryFeeRateBps(category)).toBe(expectedRateBps);
  });

  it('calculates the observed politics fixture independently of order-signing base_fee', () => {
    expect(calculatePolymarketFeeMicrousd(
      [{ priceCents: 70, size: 1 }],
      { rateBps: 400, exponent: 1, takerOnly: true },
    )).toBe(8_400);
  });

  it('prefers complete Gamma authority and fails closed when authority is malformed or absent', () => {
    expect(resolvePolymarketFeeRateBps({
      feesEnabled: true,
      feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
    }, 'Crypto')).toBe(400);
    expect(resolvePolymarketFeeRateBps({ feesEnabled: true, feeSchedule: null }, 'Sports')).toBeNull();
    expect(resolvePolymarketFeeRateBps({})).toBeNull();
    expect(resolvePolymarketFeeRateBps({}, 'Sports')).toBeNull();
  });

  it('rounds once to five decimal USDC precision at the half-unit boundary', () => {
    const schedule = { rateBps: 400, exponent: 1, takerOnly: true } as const;
    expect(calculatePolymarketFeeMicrousd([{ priceCents: 50, size: 0.0004 }], schedule)).toBe(0);
    expect(calculatePolymarketFeeMicrousd([{ priceCents: 50, size: 0.0005 }], schedule)).toBe(10);
  });

  it('returns exact zero for a fee-free market', () => {
    expect(calculatePolymarketFeeMicrousd(
      [{ priceCents: 50, size: 1_000_000 }],
      { rateBps: 0, exponent: 1, takerOnly: true },
    )).toBe(0);
  });

  it('preserves symmetry and five-decimal precision across deterministic random fills', () => {
    let state = 0x5eed1234;
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const schedule = { rateBps: 700, exponent: 1, takerOnly: true } as const;
    for (let index = 0; index < 250; index += 1) {
      const priceMicros = 1 + Math.floor(random() * 999_998);
      const sizeMicros = 1 + Math.floor(random() * 10_000_000);
      const size = sizeMicros / 1_000_000;
      const fee = calculatePolymarketFeeMicrousd(
        [{ priceCents: priceMicros / 10_000, size }], schedule,
      );
      const complementFee = calculatePolymarketFeeMicrousd(
        [{ priceCents: (1_000_000 - priceMicros) / 10_000, size }], schedule,
      );
      expect(fee).toBe(complementFee);
      expect(fee).toBeGreaterThanOrEqual(0);
      expect(fee % 10).toBe(0);
    }
  });

  it.each([null, Number.NaN, -1, 101])('rejects malformed price input %s', (priceCents) => {
    expect(() => calculatePolymarketFeeMicrousd(
      [{ priceCents: priceCents as number, size: 1 }],
      { rateBps: 400, exponent: 1, takerOnly: true },
    )).toThrow(/Polymarket fill price/i);
  });

  it.each([
    { rateBps: 400, exponent: 2, takerOnly: true },
    { rateBps: 400, exponent: 1, takerOnly: false },
    { rateBps: -1, exponent: 1, takerOnly: true },
  ])('fails closed on unsupported or malformed schedules: %o', (schedule) => {
    expect(() => calculatePolymarketFeeMicrousd([{ priceCents: 50, size: 1 }], schedule))
      .toThrow(/Polymarket fee schedule/i);
  });
});