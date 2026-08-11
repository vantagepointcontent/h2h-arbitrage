import { describe, expect, it } from 'vitest';
import { CurrentPriceRateLimiter } from './current-price-rate-limit';

describe('CurrentPriceRateLimiter', () => {
  it('preserves an exhausted active counter under more than 1,000 unique-key attempts', () => {
    let now = 0;
    const limiter = new CurrentPriceRateLimiter(10, 60_000, 1_000, () => now);

    for (let request = 0; request < 10; request += 1) {
      expect(limiter.consume('exhausted').allowed).toBe(true);
    }

    const pressureResults = Array.from(
      { length: 5_000 },
      (_, index) => limiter.consume(`unique-${index}`),
    );

    expect(pressureResults.slice(999).every((result) => !result.allowed)).toBe(true);
    expect(limiter.getStoredEntryCountForTests()).toBe(1_000);
    expect(limiter.consume('exhausted')).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    });

    now = 59_001;
    expect(limiter.consume('exhausted')).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 1,
    });

    now = 60_000;
    expect(limiter.consume('exhausted')).toEqual({
      allowed: true,
      remaining: 9,
      retryAfterSeconds: 60,
    });
  });

  it('fails closed for unseen keys at capacity until an active window expires', () => {
    let now = 1_000;
    const limiter = new CurrentPriceRateLimiter(10, 60_000, 2, () => now);

    expect(limiter.consume('first').allowed).toBe(true);
    expect(limiter.consume('second').allowed).toBe(true);
    expect(limiter.consume('overflow')).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    });

    now = 61_000;
    expect(limiter.consume('overflow')).toEqual({
      allowed: true,
      remaining: 9,
      retryAfterSeconds: 60,
    });
  });
});
