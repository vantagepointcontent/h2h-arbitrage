import { describe, expect, it } from 'vitest';
import { parseKalshiCount } from './kalshi-orders';

describe('parseKalshiCount', () => {
  it('preserves missing cumulative fills as unknown', () => {
    expect(parseKalshiCount(undefined)).toBeUndefined();
    expect(parseKalshiCount(null)).toBeUndefined();
    expect(parseKalshiCount('')).toBeUndefined();
  });

  it('distinguishes explicit zero from unknown', () => {
    expect(parseKalshiCount(0)).toBe(0);
    expect(parseKalshiCount('0')).toBe(0);
  });

  it('accepts positive venue-reported fills', () => {
    expect(parseKalshiCount(12)).toBe(12);
    expect(parseKalshiCount('7')).toBe(7);
  });

  it('fails closed for malformed or negative counts', () => {
    expect(parseKalshiCount('bad')).toBeUndefined();
    expect(parseKalshiCount(-1)).toBeUndefined();
  });
});
