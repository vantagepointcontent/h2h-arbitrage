import { describe, expect, it } from 'vitest';
import { normalizeKalshiResolution, normalizePolymarketResolution } from './settlement-resolution';

describe('authoritative settlement normalization', () => {
  it('accepts only internally consistent terminal Kalshi metadata', () => {
    expect(normalizeKalshiResolution({ status: 'settled', settlement_value_dollars: '1.0000' })).toMatchObject({ verified: true, outcome: 'yes', yesPayoutCents: 100, noPayoutCents: 0 });
    for (const input of [
      { status: 'settled' },
      { status: 'open', settlement_value_dollars: '1' },
      { status: 'settled', settlement_value_dollars: '0.5' },
      { status: 'settled', settlement_value_dollars: 'NaN' },
      { status: 'settled', settlement_value_dollars: 1 as unknown as string },
    ]) expect(normalizeKalshiResolution(input).verified).toBe(false);
  });

  it('accepts only closed Polymarket metadata with exactly one explicit winner', () => {
    expect(normalizePolymarketResolution({ closed: true, tokens: [
      { outcome: 'Yes', winner: true }, { outcome: 'No', winner: false },
    ] })).toMatchObject({ verified: true, outcome: 'yes', yesPayoutCents: 100, noPayoutCents: 0 });
    for (const input of [
      { closed: false, tokens: [{ outcome: 'Yes', winner: true }, { outcome: 'No', winner: false }] },
      { closed: true, tokens: [{ outcome: 'Yes', winner: true }, { outcome: 'No' }] },
      { closed: true, tokens: [{ outcome: 'Yes', winner: true }, { outcome: 'No', winner: true }] },
      { closed: true, tokens: [{ outcome: 'Yes', winner: false }, { outcome: 'No', winner: false }] },
      { closed: true, tokens: [{ outcome: 'Yes', winner: true }, { outcome: 'Yes', winner: false }] },
    ]) expect(normalizePolymarketResolution(input).verified).toBe(false);
  });
});
