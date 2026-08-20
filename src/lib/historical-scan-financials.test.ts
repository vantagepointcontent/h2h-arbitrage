import { describe, expect, it } from 'vitest';
import { executableEnvelopeFixture } from './test-fixtures/calculation-envelope';
import { resolveHistoricalScanFinancials } from './historical-scan-financials';

describe('resolveHistoricalScanFinancials', () => {
  it('keeps legacy immutable scan-time scalars available without an executable envelope', () => {
    const resolved = resolveHistoricalScanFinancials({
      id: 17,
      positive_arb_count: 1,
      best_roi_pct: 2.345678,
      best_profit: 12.34,
      apy_pct: 45.67,
      total_stake: 500,
      calculation_envelope: { status: 'legacy_unverifiable' },
    });

    expect(resolved).toMatchObject({
      revision: 2,
      fields: {
        roiPct: { status: 'available', value: 2.345678, source: 'scan_result_scalar' },
        profitUsd: { status: 'available', value: 12.34, source: 'scan_result_scalar' },
        apyPct: { status: 'available', value: 45.67, source: 'scan_result_scalar' },
        stakeUsd: { status: 'available', value: 500, source: 'scan_result_scalar' },
      },
    });
  });

  it('does not let a newer sparse or invalid envelope erase complete historical scalars', () => {
    const resolved = resolveHistoricalScanFinancials({
      id: 18,
      positive_arb_count: 1,
      best_roi_pct: 3.25,
      best_profit: 6.5,
      apy_pct: 78.9,
      total_stake: 200,
      calculation_envelope: { version: 99, status: 'unavailable' },
    });

    expect(Object.values(resolved.fields).every((field) => field.status === 'available')).toBe(true);
    expect(resolved.envelope.status).toBe('unavailable');
  });

  it('isolates one missing field and never substitutes zero for missing positive-arb evidence', () => {
    const resolved = resolveHistoricalScanFinancials({
      id: 19,
      positive_arb_count: 1,
      best_roi_pct: 4.5,
      best_profit: null,
      apy_pct: 90,
      total_stake: 0,
      calculation_envelope: executableEnvelopeFixture,
    });

    expect(resolved.fields.roiPct).toMatchObject({ status: 'available', value: 4.5 });
    expect(resolved.fields.profitUsd).toMatchObject({
      status: 'unavailable',
      reasonCode: 'historical_profit_not_persisted',
    });
    expect(resolved.fields.apyPct).toMatchObject({ status: 'available', value: 90 });
    expect(resolved.fields.stakeUsd).toMatchObject({
      status: 'unavailable',
      reasonCode: 'historical_stake_not_persisted',
    });
  });

  it('recovers only directly recorded raw-result values when scalar fields are absent', () => {
    const resolved = resolveHistoricalScanFinancials({
      id: 20,
      positive_arb_count: 1,
      best_roi_pct: null,
      best_profit: null,
      apy_pct: null,
      total_stake: null,
      raw_result: JSON.stringify({ allArbs: [{
        roiPct: 1.25,
        expectedProfit: 2.5,
        apyPct: 30,
        totalStake: 200,
      }] }),
    });

    expect(resolved.fields).toEqual({
      roiPct: expect.objectContaining({ status: 'available', value: 1.25, source: 'raw_result_snapshot' }),
      profitUsd: expect.objectContaining({ status: 'available', value: 2.5, source: 'raw_result_snapshot' }),
      apyPct: expect.objectContaining({ status: 'available', value: 30, source: 'raw_result_snapshot' }),
      stakeUsd: expect.objectContaining({ status: 'available', value: 200, source: 'raw_result_snapshot' }),
    });
  });

  it('recovers the exact best historical candidate from a multi-arb raw snapshot', () => {
    const resolved = resolveHistoricalScanFinancials({
      id: 21,
      positive_arb_count: 2,
      best_roi_pct: 4.5,
      best_profit: 0,
      apy_pct: null,
      total_stake: 0,
      strategy: 'Buy YES Kalshi + NO PM',
      raw_result: JSON.stringify({ allArbs: [
        { roiPct: 1.25, expectedProfit: 2.5, apyPct: 30, totalStake: 200, strategy: 'Buy NO Kalshi + YES PM' },
        { roiPct: 4.5, expectedProfit: 9, apyPct: 60, totalStake: 200, strategy: 'Buy YES Kalshi + NO PM' },
      ] }),
    });

    expect(resolved.fields.profitUsd).toMatchObject({ status: 'available', value: 9, source: 'raw_result_snapshot' });
    expect(resolved.fields.apyPct).toMatchObject({ status: 'available', value: 60, source: 'raw_result_snapshot' });
    expect(resolved.fields.stakeUsd).toMatchObject({ status: 'available', value: 200, source: 'raw_result_snapshot' });
  });
});
