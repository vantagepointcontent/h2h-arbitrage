import { describe, expect, it, vi } from 'vitest';

describe('auto-discovery module lifecycle', () => {
  it('does not start the scheduler as an import side effect', async () => {
    vi.resetModules();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    await import('./auto-discovery');

    expect(setIntervalSpy.mock.calls.some(([, delay]) => delay === 10 * 60 * 1000)).toBe(false);
    setIntervalSpy.mockRestore();
  });
});
