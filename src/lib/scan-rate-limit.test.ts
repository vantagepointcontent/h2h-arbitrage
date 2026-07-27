import { describe, expect, it } from 'vitest';
import { getScanClientKey, ScanRateLimiter } from './scan-rate-limit';

describe('ScanRateLimiter', () => {
  it('allows the configured request budget, then rejects until the window resets', () => {
    let now = 1_000;
    const limiter = new ScanRateLimiter(2, 10_000, () => now);

    expect(limiter.consume('127.0.0.1')).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume('127.0.0.1')).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume('127.0.0.1')).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 10 });

    now += 10_000;
    expect(limiter.consume('127.0.0.1')).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('keeps client budgets independent', () => {
    const limiter = new ScanRateLimiter(1);

    expect(limiter.consume('client-a').allowed).toBe(true);
    expect(limiter.consume('client-b').allowed).toBe(true);
    expect(limiter.consume('client-a').allowed).toBe(false);
  });
});

describe('getScanClientKey', () => {
  it('prefers x-real-ip and otherwise uses the first forwarded client address', () => {
    expect(getScanClientKey(new Headers({ 'x-real-ip': '10.0.0.3', 'x-forwarded-for': '198.51.100.2' }))).toBe('10.0.0.3');
    expect(getScanClientKey(new Headers({ 'x-forwarded-for': '198.51.100.2, 10.0.0.1' }))).toBe('198.51.100.2');
    expect(getScanClientKey(new Headers())).toBe('anonymous');
  });
});
