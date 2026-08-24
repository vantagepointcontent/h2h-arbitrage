import { describe, expect, it } from 'vitest';
import { buildBasicSavedMarketList } from './saved-markets-list';
import type { SavedMarket } from './persistence';

describe('buildBasicSavedMarketList expiry provenance', () => {
  it('projects persisted expiry provenance without venue requests', () => {
    const market = {
      id: 'market-1',
      eventTitle: 'Who will be arrested before 2027?',
      kalshiUrl: 'https://kalshi.com/markets/kxarrest/arrests/kxarrest-27jan',
      polymarketUrl: 'https://polymarket.com/event/who-will-be-arrested-before-2027',
      expiryDate: '2027-01-01T04:59:00Z',
      expirySource: 'kalshi_market_close_time',
      expirySourceId: 'KXARREST-27JAN',
      expiryObservedAt: '2026-08-24T23:05:20.392Z',
      category: 'Politics',
      archived: false,
      createdAt: '2026-08-01T00:00:00Z',
      lastScanResult: null,
      liveResult: null,
    } as unknown as SavedMarket;

    expect(buildBasicSavedMarketList([market], {})[0]).toMatchObject({
      expiryDate: '2027-01-01T04:59:00Z',
      expirySource: 'kalshi_market_close_time',
      expirySourceId: 'KXARREST-27JAN',
      expiryObservedAt: '2026-08-24T23:05:20.392Z',
    });
  });
});
