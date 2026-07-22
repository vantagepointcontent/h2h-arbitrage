import { describe, expect, it } from 'vitest';
import { getUnavailableScanPlatforms, resolveScanLinks } from './scan-links';

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

  it('preserves an IBKR link while retaining the Kalshi and Polymarket scan pair', () => {
    const links = resolveScanLinks({
      platformLinks: [
        { platform: 'kalshi', url: 'https://kalshi.com/markets/KXTEST' },
        { platform: 'polymarket', url: 'https://polymarket.com/event/test-market' },
        { platform: 'ibkr', url: 'https://www.interactivebrokers.com/predictionmarkets/app/market/123' },
      ],
    });

    expect(links.platformLinks).toHaveLength(3);
    expect(links.platformLinks[2]).toEqual({ platform: 'ibkr', url: 'https://www.interactivebrokers.com/predictionmarkets/app/market/123' });
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

  it('resolves Kalshi and Polymarket by their platform rather than link order', () => {
    const links = resolveScanLinks({
      platformLinks: [
        { platform: 'polymarket', url: 'https://polymarket.com/event/first-link' },
        { platform: 'kalshi', url: 'https://kalshi.com/markets/KXSECOND' },
      ],
    });

    expect(links.kalshiUrl).toBe('https://kalshi.com/markets/KXSECOND');
    expect(links.polymarketUrl).toBe('https://polymarket.com/event/first-link');
  });

  it('uses the detected platform instead of a stale input-row platform', () => {
    const links = resolveScanLinks({
      platformLinks: [{ platform: 'kalshi', url: 'https://www.interactivebrokers.com/predictionmarkets/app/market/123' }],
    });

    expect(links.platformLinks).toEqual([
      { platform: 'ibkr', url: 'https://www.interactivebrokers.com/predictionmarkets/app/market/123' },
    ]);
  });

  it('identifies links for registered adapters that are not available yet', () => {
    const links = resolveScanLinks({
      platformLinks: [{ platform: 'ibkr', url: 'https://www.interactivebrokers.com/predictionmarkets/app/market/123' }],
    });

    expect(getUnavailableScanPlatforms(links.platformLinks)).toEqual([
      { platform: 'ibkr', name: 'Interactive Brokers' },
    ]);
  });
});
