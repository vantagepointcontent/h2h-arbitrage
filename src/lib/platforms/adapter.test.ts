import { describe, expect, it } from 'vitest';
import { getAdapter, getReadyAdapters } from './adapter';

describe('platform adapter resolution', () => {
  it('resolves every registered adapter and caches each instance', async () => {
    const [polymarket, kalshi, ibkr] = await Promise.all([
      getAdapter('polymarket'),
      getAdapter('kalshi'),
      getAdapter('ibkr'),
    ]);

    expect(polymarket?.platformId).toBe('polymarket');
    expect(kalshi?.platformId).toBe('kalshi');
    expect(ibkr?.platformId).toBe('ibkr');
    await expect(getAdapter('ibkr')).resolves.toBe(ibkr);
  });

  it('exposes only enabled, ready adapters to generic callers', async () => {
    const adapters = await getReadyAdapters();

    expect(adapters.map(adapter => adapter.platformId)).toEqual(['polymarket', 'kalshi']);
    expect(adapters.every(adapter => adapter.isReady())).toBe(true);
  });


});
