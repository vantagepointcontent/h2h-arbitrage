import { describe, expect, it } from 'vitest';
import {
  assertFreshKalshiFeeAuthority,
  calculateKalshiFeeQuote,
  resolveKalshiFeeAuthority,
} from './kalshi-fee-quote';

const observedAt = '2026-08-14T12:00:00.000Z';

describe('authoritative Kalshi fee quote service', () => {
  it('resolves market -> event -> series and applies a standard multiplier', async () => {
    const authority = await resolveKalshiFeeAuthority('KXTEST-YES', {
      observedAt,
      fetchJson: async (url) => {
        if (url.includes('/markets/')) return { market: { event_ticker: 'KXTEST-EVENT' } };
        if (url.includes('/events/')) return { event: { series_ticker: 'KXTEST' } };
        if (url.includes('/series/')) return { series: { fee_type: 'quadratic', fee_multiplier: 1, last_updated_ts: 'series-v1' } };
        throw new Error(`unexpected URL ${url}`);
      },
    });

    expect(authority).toEqual({
      marketTicker: 'KXTEST-YES',
      eventTicker: 'KXTEST-EVENT',
      seriesTicker: 'KXTEST',
      feeType: 'quadratic',
      feeMultiplierPpm: 1_000_000,
      source: 'https://external-api.kalshi.com/trade-api/v2/series/KXTEST',
      observedAt,
      version: 'quadratic:1000000:series-v1',
    });
  });

  it('honors complete event overrides and rejects partial overrides', async () => {
    const fetchJson = async (url: string): Promise<Record<string, unknown>> => {
      if (url.includes('/markets/')) return { market: { event_ticker: 'KXTEST-EVENT' } };
      if (url.includes('/events/')) return { event: {
        series_ticker: 'KXTEST', fee_type_override: 'quadratic_with_maker_fees',
        fee_multiplier_override: 0.5, last_updated_ts: 'event-v2',
      } };
      if (url.includes('/series/')) return { series: { fee_type: 'quadratic', fee_multiplier: 1 } };
      throw new Error(`unexpected URL ${url}`);
    };
    const authority = await resolveKalshiFeeAuthority('KXTEST-YES', { observedAt, fetchJson });
    expect(authority).toMatchObject({
      feeType: 'quadratic_with_maker_fees', feeMultiplierPpm: 500_000,
      source: 'https://external-api.kalshi.com/trade-api/v2/events/KXTEST-EVENT',
      version: 'quadratic_with_maker_fees:500000:event-v2',
    });

    await expect(resolveKalshiFeeAuthority('KXTEST-YES', {
      observedAt,
      fetchJson: async (url) => {
        const result = await fetchJson(url);
        if (url.includes('/events/')) return { event: { series_ticker: 'KXTEST', fee_type_override: 'quadratic' } };
        return result;
      },
    })).rejects.toThrow('Conflicting Kalshi event fee override');
  });

  it('distinguishes taker and maker rates and ceilings each actual order', () => {
    const authority = {
      marketTicker: 'KXTEST-YES', eventTicker: 'KXTEST-EVENT', seriesTicker: 'KXTEST',
      feeType: 'quadratic_with_maker_fees' as const, feeMultiplierPpm: 1_000_000,
      source: 'kalshi-series:KXTEST', observedAt, version: 'v1',
    };
    const taker = calculateKalshiFeeQuote(authority, 'taker', [
      { fills: [{ priceCents: 50, contracts: 1 }] },
      { fills: [{ priceCents: 50, contracts: 1 }] },
    ]);
    const maker = calculateKalshiFeeQuote(authority, 'maker', [
      { fills: [{ priceCents: 50, contracts: 2 }] },
    ]);

    expect(taker).toMatchObject({ calculatedFeeCents: 4, chargedFeeCents: null, liquidity: 'taker' });
    expect(maker).toMatchObject({ calculatedFeeCents: 1, chargedFeeCents: null, liquidity: 'maker' });
  });

  it('supports the documented flat two-cent-per-contract schedule and multiplier', () => {
    const flat = {
      marketTicker: 'KXTEST-YES', eventTicker: 'KXTEST-EVENT', seriesTicker: 'KXTEST',
      feeType: 'flat' as const, feeMultiplierPpm: 500_000,
      source: 'kalshi-series:KXTEST', observedAt, version: 'v-flat',
    };
    expect(calculateKalshiFeeQuote(flat, 'taker', [{
      fills: [{ contracts: 7, priceCents: 13 }],
    }]).calculatedFeeCents).toBe(7);
  });

  it('calculates mixed maker and taker fills using each fill liquidity role', () => {
    const authority = {
      marketTicker: 'KXTEST-YES', eventTicker: 'KXTEST-EVENT', seriesTicker: 'KXTEST',
      feeType: 'quadratic_with_maker_fees' as const, feeMultiplierPpm: 1_000_000,
      source: 'kalshi-series:KXTEST', observedAt, version: 'v-mixed',
    };
    const quote = calculateKalshiFeeQuote(authority, 'taker', [{ fills: [
      { contracts: 10, priceCents: 50, liquidityRole: 'maker' },
      { contracts: 10, priceCents: 50, liquidityRole: 'taker' },
    ] }]);
    expect(quote.calculatedFeeCents).toBe(22);
    expect(quote.liquidity).toBe('mixed');
  });

  it('uses charged cents without erasing the calculated amount', () => {
    const quote = calculateKalshiFeeQuote({
      marketTicker: 'KXTEST-YES', eventTicker: 'KXTEST-EVENT', seriesTicker: 'KXTEST',
      feeType: 'quadratic' as const, feeMultiplierPpm: 2_000_000,
      source: 'kalshi-series:KXTEST', observedAt, version: 'v2',
    }, 'taker', [{ fills: [{ priceCents: 40, contracts: 10 }], chargedFeeCents: 30 }]);
    expect(quote.calculatedFeeCents).toBe(34);
    expect(quote.chargedFeeCents).toBe(30);
    expect(quote.effectiveFeeCents).toBe(30);
  });

  it('fails closed for stale authority and upstream failures', async () => {
    expect(() => assertFreshKalshiFeeAuthority({
      marketTicker: 'K', eventTicker: 'E', seriesTicker: 'S', feeType: 'quadratic',
      feeMultiplierPpm: 1_000_000, source: 'source', observedAt, version: 'v1',
    }, '2026-08-14T12:01:00.001Z')).toThrow('Stale authoritative Kalshi fee configuration');

    await expect(resolveKalshiFeeAuthority('K', {
      observedAt,
      fetchJson: async () => { throw new Error('upstream unavailable'); },
    })).rejects.toThrow('upstream unavailable');
  });
});
