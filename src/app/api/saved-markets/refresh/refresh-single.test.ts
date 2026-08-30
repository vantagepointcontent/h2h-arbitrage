import { describe, expect, it } from 'vitest';
import { buildKalshiArbShape } from '@/lib/matcher';
import { buildRefreshKalshiExecutableQuote } from './refresh-single';

const OBSERVED_AT = '2026-08-30T17:30:00.000Z';

function market(overrides: Record<string, unknown> = {}) {
  return {
    ticker: 'KXBUG858-TEST',
    event_ticker: 'KXBUG858',
    status: 'active',
    yes_bid_dollars: '0.25',
    yes_bid_size_fp: '72.62',
    yes_ask_dollars: '0.26',
    yes_ask_size_fp: '3.95',
    no_bid_dollars: '0.74',
    no_bid_size_fp: '3.95',
    no_ask_dollars: '0.75',
    no_ask_size_fp: '72.62',
    last_price_dollars: '0.25',
    price_ranges: [{ start: '0.00', end: '1.00', step: '0.01' }],
    ...overrides,
  } as Parameters<typeof buildKalshiArbShape>[0];
}

describe('saved-market refresh Kalshi executable quote parity', () => {
  it('round-trips reciprocal NO ask quantity as exact executable dollar depth', () => {
    const normalized = buildKalshiArbShape(market({ no_ask_size_fp: undefined }));
    const quote = buildRefreshKalshiExecutableQuote(normalized, 'no', OBSERVED_AT);

    expect(normalized.noAskDepth).toBe('54.465000');
    expect(quote).toMatchObject({
      status: 'executable',
      reason: null,
      filledQuantityMicros: 1_000_000,
      totalCostMicroCents: 75_000_000,
      tickSizeMicroCents: 1_000_000,
      depthTimestamp: OBSERVED_AT,
    });
  });

  it('preserves a tapered sub-cent tick instead of hard-coding one cent', () => {
    const normalized = buildKalshiArbShape(market({
      yes_ask_dollars: '0.055',
      no_bid_dollars: '0.945',
      yes_ask_size_fp: undefined,
      no_bid_size_fp: '10',
      price_ranges: [
        { start: '0.000', end: '0.100', step: '0.001' },
        { start: '0.100', end: '1.000', step: '0.010' },
      ],
    }));
    const quote = buildRefreshKalshiExecutableQuote(normalized, 'yes', OBSERVED_AT);

    expect(normalized.yesAskDepth).toBe('0.550000');
    expect(quote).toMatchObject({
      status: 'executable',
      tickSizeMicroCents: 100_000,
      vwapPriceMicroCents: 5_500_000,
      depthTimestamp: OBSERVED_AT,
    });
  });

  it.each([
    [{ yes_ask_size_fp: undefined, no_bid_size_fp: undefined }, 'missing_depth'],
    [{ yes_ask_size_fp: 'bad', no_bid_size_fp: undefined }, 'malformed_depth'],
    [{ status: 'closed' }, 'inactive_market'],
    [{ yes_ask_size_fp: '0', no_bid_size_fp: '0' }, 'authoritative_empty'],
  ] as const)('propagates normalized unavailable-state provenance: %s', (overrides, reason) => {
    const normalized = buildKalshiArbShape(market(overrides));
    const quote = buildRefreshKalshiExecutableQuote(normalized, 'yes', OBSERVED_AT);

    expect(quote).toMatchObject({
      status: 'unavailable',
      reason,
      filledQuantityMicros: 0,
      depthTimestamp: OBSERVED_AT,
    });
  });

  it.each([
    ['rate_limited', 'Kalshi API error: 429'],
    ['timeout', 'Kalshi event markets timed out after 3000ms'],
    ['wrong_ticker', 'Kalshi returned no market matching KXBUG858-TEST'],
  ] as const)('produces auditable source-unavailable quotes for %s failures', (failureKind, detail) => {
    const normalized = buildKalshiArbShape(market());
    const quote = buildRefreshKalshiExecutableQuote(normalized, 'yes', OBSERVED_AT, {
      status: 'source_unavailable',
      attemptedAt: '2026-08-30T17:30:02.000Z',
      observedAt: null,
      failureKind,
      detail,
    });

    expect(quote).toMatchObject({
      status: 'unavailable',
      reason: 'source_unavailable',
      depthTimestamp: null,
      sourceStatus: 'source_unavailable',
      sourceAttemptedAt: '2026-08-30T17:30:02.000Z',
      sourceObservedAt: null,
      sourceFailureKind: failureKind,
      sourceDetail: detail,
    });
  });

  it('produces stale-book provenance without redating the last successful observation', () => {
    const normalized = buildKalshiArbShape(market());
    const quote = buildRefreshKalshiExecutableQuote(normalized, 'no', OBSERVED_AT, {
      status: 'stale',
      attemptedAt: '2026-08-30T17:35:00.000Z',
      observedAt: OBSERVED_AT,
      failureKind: 'stale_snapshot',
      detail: 'Kalshi depth is 300000ms old (maximum 30000ms)',
    });

    expect(quote).toMatchObject({
      status: 'unavailable',
      reason: 'stale_book',
      depthTimestamp: OBSERVED_AT,
      sourceStatus: 'stale',
      sourceObservedAt: OBSERVED_AT,
      sourceAttemptedAt: '2026-08-30T17:35:00.000Z',
      sourceFailureKind: 'stale_snapshot',
    });
  });
});
