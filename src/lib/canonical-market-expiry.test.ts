import { describe, expect, it } from 'vitest';
import { resolveCanonicalMarketExpiry } from './canonical-market-expiry';

describe('BUG-187 canonical linked-market expiry', () => {
  it('recovers a missing Polymarket event end date from one coherent Kalshi event close time', () => {
    expect(resolveCanonicalMarketExpiry({
      polymarketEndDate: null,
      polymarketEventSlug: 'who-will-be-arrested-before-2027',
      kalshiMarkets: [
        { event_ticker: 'KXARREST-27JAN', ticker: 'KXARREST-27JAN-AFAU', close_time: '2027-01-01T04:59:00Z' },
        { event_ticker: 'KXARREST-27JAN', ticker: 'KXARREST-27JAN-JBRE', close_time: '2027-01-01T04:59:00Z' },
      ],
    })).toEqual({
      expiryAt: '2027-01-01T04:59:00Z',
      source: 'kalshi_market_close_time',
      sourceId: 'KXARREST-27JAN',
    });
  });

  it('prefers the canonical Polymarket event end date when present', () => {
    expect(resolveCanonicalMarketExpiry({
      polymarketEndDate: '2026-12-31T23:59:00Z',
      polymarketEventSlug: 'event-slug',
      kalshiMarkets: [
        { event_ticker: 'KXEVENT', ticker: 'KXEVENT-A', close_time: '2027-01-01T04:59:00Z' },
      ],
    })).toEqual({
      expiryAt: '2026-12-31T23:59:00Z',
      source: 'polymarket_event_end_date',
      sourceId: 'event-slug',
    });
  });

  it('recovers from coherent Polymarket child-market end dates before consulting Kalshi', () => {
    expect(resolveCanonicalMarketExpiry({
      polymarketEndDate: null,
      polymarketEventSlug: 'where-will-rodri-transfer',
      polymarketMarkets: [
        { endDate: '2026-09-02T03:59:00Z' },
        { endDate: '2026-09-02T03:59:00Z' },
      ],
      kalshiMarkets: [
        { event_ticker: 'KXJOINCLUB', ticker: 'KXJOINCLUB-A', close_time: '2026-10-03T00:00:00Z' },
      ],
    })).toEqual({
      expiryAt: '2026-09-02T03:59:00Z',
      source: 'polymarket_market_end_date',
      sourceId: 'where-will-rodri-transfer',
    });
  });

  it('fails closed when linked Kalshi outcomes disagree on close time', () => {
    expect(resolveCanonicalMarketExpiry({
      polymarketEndDate: null,
      polymarketEventSlug: 'event-slug',
      kalshiMarkets: [
        { event_ticker: 'KXEVENT', ticker: 'KXEVENT-A', close_time: '2027-01-01T04:59:00Z' },
        { event_ticker: 'KXEVENT', ticker: 'KXEVENT-B', close_time: '2027-01-02T04:59:00Z' },
      ],
    })).toBeNull();
  });

  it('uses a coherent scheduled Kalshi expiration when finalized outcomes have different early-close times', () => {
    expect(resolveCanonicalMarketExpiry({
      polymarketEndDate: null,
      polymarketEventSlug: 'event-slug',
      kalshiMarkets: [
        { event_ticker: 'KXEVENT', ticker: 'KXEVENT-A', close_time: '2026-08-20T17:05:09Z', expected_expiration_time: '2026-08-24T02:00:00Z' },
        { event_ticker: 'KXEVENT', ticker: 'KXEVENT-B', close_time: '2026-08-24T14:45:13Z', expected_expiration_time: '2026-08-24T02:00:00Z' },
      ],
    })).toEqual({
      expiryAt: '2026-08-24T02:00:00Z',
      source: 'kalshi_expected_expiration_time',
      sourceId: 'KXEVENT',
    });
  });

  it('does not promote malformed or absent source dates', () => {
    expect(resolveCanonicalMarketExpiry({
      polymarketEndDate: 'not-a-date',
      polymarketEventSlug: 'event-slug',
      kalshiMarkets: [{ event_ticker: 'KXEVENT', ticker: 'KXEVENT-A', close_time: undefined }],
    })).toBeNull();
  });
});
