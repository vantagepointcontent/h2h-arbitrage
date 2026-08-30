import { describe, expect, it } from 'vitest';
import { resolveKalshiQuoteSourceProvenance } from './kalshi-executable-quote';

describe('Kalshi executable quote freshness authority', () => {
  it('preserves a fresh source observation instead of redating it', () => {
    expect(resolveKalshiQuoteSourceProvenance(
      '2026-08-30T17:34:45.000Z',
      '2026-08-30T17:35:00.000Z',
    )).toEqual({
      status: 'fresh', attemptedAt: '2026-08-30T17:35:00.000Z',
      observedAt: '2026-08-30T17:34:45.000Z', failureKind: null, detail: null,
    });
  });

  it('classifies an old source observation as stale with its exact age', () => {
    expect(resolveKalshiQuoteSourceProvenance(
      '2026-08-30T17:30:00.000Z',
      '2026-08-30T17:35:00.000Z',
    )).toEqual({
      status: 'stale', attemptedAt: '2026-08-30T17:35:00.000Z',
      observedAt: '2026-08-30T17:30:00.000Z', failureKind: 'stale_snapshot',
      detail: 'Kalshi depth is 300000ms old (maximum 30000ms)',
    });
  });

  it.each([null, 'not-a-date', '2026-08-30T17:36:00.000Z'])('fails closed for an invalid source observation: %s', (observedAt) => {
    expect(resolveKalshiQuoteSourceProvenance(observedAt, '2026-08-30T17:35:00.000Z')).toMatchObject({
      status: 'source_unavailable', attemptedAt: '2026-08-30T17:35:00.000Z',
      observedAt: null, failureKind: 'source_error',
    });
  });
});