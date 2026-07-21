import { describe, expect, it } from 'vitest';
import { getAdapter, getReadyAdapters } from './adapter';

describe('platform adapter resolution', () => {
  it('resolves every registered adapter and caches each instance', async () => {
    const [polymarket, kalshi, opinion, ibkr] = await Promise.all([
      getAdapter('polymarket'),
      getAdapter('kalshi'),
      getAdapter('opinion'),
      getAdapter('ibkr'),
    ]);

    expect(polymarket?.platformId).toBe('polymarket');
    expect(kalshi?.platformId).toBe('kalshi');
    expect(opinion?.platformId).toBe('opinion');
    expect(ibkr?.platformId).toBe('ibkr');
    await expect(getAdapter('opinion')).resolves.toBe(opinion);
  });

  it('exposes only enabled, ready adapters to generic callers', async () => {
    const adapters = await getReadyAdapters();

    expect(adapters.map(adapter => adapter.platformId)).toEqual(['polymarket', 'kalshi']);
    expect(adapters.every(adapter => adapter.isReady())).toBe(true);
  });

  it('recognizes the live Opinion market domain while keeping its stub disabled', async () => {
    const opinion = await getAdapter('opinion');

    expect(opinion?.isPlatformUrl('https://app.opinion.trade/market/presidential-election')).toBe(true);
    expect(opinion?.extractMarketId('https://app.opinion.trade/market/presidential-election')).toBe('presidential-election');
    expect(opinion?.isReady()).toBe(false);
  });
});
