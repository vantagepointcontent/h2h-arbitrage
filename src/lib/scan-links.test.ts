import { describe, expect, it } from 'vitest';
import { resolveScanLinks } from './scan-links';

describe('resolveScanLinks', () => {
  it('accepts canonical platform links and preserves their URLs', () => {
    const links = resolveScanLinks({
      platformLinks: [
        { platform: 'kalshi', url: 'https://kalshi.com/markets/KXTEST' },
        { platform: 'polymarket', url: 'https://polymarket.com/event/test-market' },
      ],
    });

    expect(links.kalshiUrl).toBe('https://kalshi.com/markets/KXTEST');
    expect(links.polymarketUrl).toBe('https://polymarket.com/event/test-market');
    expect(links.platformLinks).toHaveLength(2);
  });

  it('preserves a third platform link while retaining the Kalshi and Polymarket scan pair', () => {
    const links = resolveScanLinks({
      platformLinks: [
        { platform: 'kalshi', url: 'https://kalshi.com/markets/KXTEST' },
        { platform: 'polymarket', url: 'https://polymarket.com/event/test-market' },
        { platform: 'opinion', url: 'https://opinion.com/market/test-market' },
      ],
    });

    expect(links.platformLinks).toHaveLength(3);
    expect(links.platformLinks[2]).toEqual({ platform: 'opinion', url: 'https://opinion.com/market/test-market' });
    expect(links.kalshiUrl).toContain('KXTEST');
    expect(links.polymarketUrl).toContain('test-market');
  });

  it('keeps legacy named URLs working during migration', () => {
    const links = resolveScanLinks({
      kalshiUrl: 'https://kalshi.com/markets/KXLEGACY',
      polymarketUrl: 'https://polymarket.com/event/legacy-market',
    });

    expect(links.platformLinks).toEqual([]);
    expect(links.kalshiUrl).toContain('KXLEGACY');
    expect(links.polymarketUrl).toContain('legacy-market');
  });

  it('auto-detects a platform when an incoming link does not name one', () => {
    const links = resolveScanLinks({
      platformLinks: [{ url: 'https://polymarket.com/event/detected-market' }],
    });

    expect(links.platformLinks).toEqual([
      { platform: 'polymarket', url: 'https://polymarket.com/event/detected-market' },
    ]);
  });
});
