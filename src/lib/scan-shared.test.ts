import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from './scan-shared';

describe('withTimeout lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears its timeout when the wrapped promise resolves first', async () => {
    vi.useFakeTimers();

    await expect(withTimeout(Promise.resolve('ok'), 30_000, 'fast operation')).resolves.toBe('ok');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timeout after rejecting a slow operation', async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise<never>(() => {}), 30_000, 'slow operation');
    const assertion = expect(result).rejects.toThrow('slow operation timed out after 30000ms');

    await vi.advanceTimersByTimeAsync(30_000);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
