import { describe, expect, it } from 'vitest';
import { resolvePairFromLinks } from './pair-resolver';

describe('resolvePairFromLinks', () => {
  it('rejects a link set with no Kalshi link before any network resolution', async () => {
    await expect(resolvePairFromLinks([
      { platform: 'polymarket', url: 'https://polymarket.com/event/example' },
    ], 1000)).rejects.toMatchObject({ code: 'bad_kalshi_url' });
  });

  it('rejects a link set with no Polymarket link before any network resolution', async () => {
    await expect(resolvePairFromLinks([
      { platform: 'kalshi', url: 'https://kalshi.com/markets/KXEXAMPLE' },
    ], 1000)).rejects.toMatchObject({ code: 'bad_pm_url' });
  });
});
