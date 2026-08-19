import { describe, expect, it } from 'vitest';
import {
  formatScaledMoney,
  legacyUnverifiableEnvelope,
  parseCalculationEnvelope,
  validateCalculationEnvelope,
} from './calculation-envelope';
import { executableEnvelopeFixture } from './test-fixtures/calculation-envelope';

describe('calculation envelope', () => {
  it('validates an executable one-share ledger without losing five-decimal money precision', () => {
    const envelope = validateCalculationEnvelope(executableEnvelopeFixture);

    expect(envelope).toEqual(executableEnvelopeFixture);
    expect(formatScaledMoney(envelope.totals.netPnlMicros)).toBe('-0.00856');
    expect(formatScaledMoney(envelope.legs[1].fee.amountMicros)).toBe('0.00856');
  });

  it('rejects contradictory derived totals instead of publishing an unreproducible result', () => {
    expect(() => validateCalculationEnvelope({
      ...executableEnvelopeFixture,
      totals: { ...executableEnvelopeFixture.totals, netPnlMicros: 0 },
    })).toThrow('netPnlMicros');
  });

  it('rejects self-consistent totals that are not reproduced by the authoritative buy fill ladders', () => {
    expect(() => validateCalculationEnvelope({
      ...executableEnvelopeFixture,
      scope: 'execution',
      totals: {
        ...executableEnvelopeFixture.totals,
        grossCostMicros: 1,
        grossProfitMicros: 999_999,
        netPnlMicros: 971_439,
      },
    })).toThrow('grossCostMicros does not reconcile to buy fill levels');

    expect(() => validateCalculationEnvelope({
      ...executableEnvelopeFixture,
      scope: 'execution',
      totals: {
        ...executableEnvelopeFixture.totals,
        grossPayoutMicros: 1_000_000_001,
        grossProfitMicros: 999_020_001,
        netPnlMicros: 998_991_441,
      },
    })).toThrow('grossPayoutMicros does not reconcile to matched quantity');

    expect(() => validateCalculationEnvelope({
      ...executableEnvelopeFixture,
      scope: 'execution',
      legs: executableEnvelopeFixture.legs.map((leg) => ({
        ...leg,
        fee: { ...leg.fee, amountMicros: 0 },
      })),
      totals: {
        ...executableEnvelopeFixture.totals,
        totalFeesMicros: 0,
        netPnlMicros: 20_000,
      },
    })).toThrow('calculated fee does not reconcile to fill levels and schedule');
  });

  it('rejects quantity and VWAP claims that do not reconcile to the recorded fill ladder', () => {
    expect(() => validateCalculationEnvelope({
      ...executableEnvelopeFixture,
      executableQuantityMicros: 999_999,
    })).toThrow('quantity does not reconcile');
    expect(() => validateCalculationEnvelope({
      ...executableEnvelopeFixture,
      legs: executableEnvelopeFixture.legs.map((leg, index) => index === 0 ? {
        ...leg,
        fillLevels: [{ ...leg.fillLevels[0], priceMicros: 669_999 }],
      } : leg),
    })).toThrow('VWAP does not reconcile');
  });

  it('backfills missing legacy authority as null and unverifiable, never zero', () => {
    const envelope = legacyUnverifiableEnvelope('scan:42');

    expect(envelope.status).toBe('legacy_unverifiable');
    expect(envelope.blocker).toMatchObject({ code: 'legacy_missing_calculation_authority' });
    expect(envelope.totals).toEqual({
      grossCostMicros: null,
      grossPayoutMicros: null,
      grossProfitMicros: null,
      totalFeesMicros: null,
      netPnlMicros: null,
    });
    expect(parseCalculationEnvelope(null, 'scan:42')).toEqual(envelope);
  });

  it('surfaces malformed persisted envelopes as unavailable data quality failures', () => {
    expect(parseCalculationEnvelope('{"version":1,"status":"executable"}', 'scan 9')).toMatchObject({
      status: 'unavailable',
      blocker: { code: 'invalid_calculation_envelope' },
      totals: { totalFeesMicros: null, netPnlMicros: null },
    });
  });
});
