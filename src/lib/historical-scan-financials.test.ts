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
      revision: 3,
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

  it('represents a confirmed no-arb row as unavailable instead of fabricated numeric zero', () => {
    const resolved = resolveHistoricalScanFinancials({
      id: 22,
      positive_arb_count: 0,
      strategy: 'No arb',
      best_roi_pct: 0,
      best_profit: 0,
      apy_pct: 0,
      total_stake: 0,
    });

    expect(resolved.fields.roiPct).toMatchObject({
      status: 'unavailable',
      value: null,
      reasonCode: 'confirmed_no_arbitrage',
    });
    expect(Object.values(resolved.fields).every((field) => field.status === 'unavailable')).toBe(true);
  });

  it('treats every canonical zero-arb scan as not applicable even when it retained an indicative candidate', () => {
    const resolved = resolveHistoricalScanFinancials({
      id: 220,
      positive_arb_count: 0,
      strategy: 'Buy YES Kalshi + NO PM',
      best_roi_pct: 2.5,
      best_profit: 0,
      apy_pct: 45,
      total_stake: 0,
      raw_result: JSON.stringify({ allArbs: [{
        strategy: 'Buy YES Kalshi + NO PM',
        roiPct: 2.5,
        expectedProfit: 0,
        apyPct: 45,
        totalStake: 0,
        executionStatus: 'non_executable',
      }] }),
    });

    expect(Object.values(resolved.fields)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'unavailable', reasonCode: 'confirmed_no_arbitrage' }),
    ]));
    expect(Object.values(resolved.fields).every((field) =>
      field.status === 'unavailable' && field.reasonCode === 'confirmed_no_arbitrage')).toBe(true);
  });

  it('preserves explicitly persisted immutable economics for an applicable arb despite raw execution annotations', () => {
    const resolved = resolveHistoricalScanFinancials({
      id: 221,
      positive_arb_count: 1,
      strategy: 'Buy YES Kalshi + NO PM',
      best_roi_pct: 2.5,
      best_profit: 5,
      apy_pct: 45,
      total_stake: 200,
      historical_financials_revision: 3,
      historical_financials_provenance: JSON.stringify({
        revision: 3,
        fields: {
          roiPct: { status: 'available' }, profitUsd: { status: 'available' },
          apyPct: { status: 'available' }, stakeUsd: { status: 'available' },
        },
      }),
      raw_result: JSON.stringify({ allArbs: [{
        strategy: 'Buy YES Kalshi + NO PM',
        roiPct: 2.5,
        expectedProfit: 5,
        apyPct: 45,
        totalStake: 200,
        executionStatus: 'non_executable',
      }] }),
    });

    expect(resolved.fields).toMatchObject({
      roiPct: { status: 'available', value: 2.5 },
      profitUsd: { status: 'available', value: 5 },
      apyPct: { status: 'available', value: 45 },
      stakeUsd: { status: 'available', value: 200 },
    });
  });

  it('does not render a persisted selected-candidate zero as an applicable arb metric', () => {
    const resolved = resolveHistoricalScanFinancials({
      id: 23,
      positive_arb_count: 0,
      strategy: 'Buy YES Kalshi + NO PM',
      best_roi_pct: 0,
      best_profit: 0,
      apy_pct: 0,
      total_stake: 100,
      historical_financials_revision: 3,
      historical_financials_provenance: JSON.stringify({
        revision: 3,
        fields: {
          roiPct: { status: 'available' }, profitUsd: { status: 'available' },
          apyPct: { status: 'available' }, stakeUsd: { status: 'available' },
        },
      }),
    });

    expect(resolved.fields.roiPct).toMatchObject({
      status: 'unavailable', value: null, reasonCode: 'confirmed_no_arbitrage',
    });
    expect(resolved.fields.profitUsd).toMatchObject({
      status: 'unavailable', value: null, reasonCode: 'confirmed_no_arbitrage',
    });
  });

  it('keeps every canonical zero-arb row not applicable regardless of legacy zero provenance', () => {
    const compatibilityZero = resolveHistoricalScanFinancials({
      id: 24,
      positive_arb_count: 0,
      strategy: 'Buy YES Kalshi + NO PM',
      best_roi_pct: 0,
      best_profit: 0,
      apy_pct: 0,
      total_stake: 0,
      historical_financials_revision: 3,
      historical_financials_provenance: JSON.stringify({
        revision: 3,
        fields: {
          roiPct: { status: 'unavailable', reasonCode: 'historical_roi_not_persisted' },
          profitUsd: { status: 'unavailable', reasonCode: 'historical_profit_not_persisted' },
          apyPct: { status: 'unavailable', reasonCode: 'historical_apy_not_persisted' },
          stakeUsd: { status: 'unavailable', reasonCode: 'historical_stake_not_persisted' },
        },
      }),
    });
    expect(compatibilityZero.fields.roiPct).toMatchObject({
      status: 'unavailable', value: null, reasonCode: 'confirmed_no_arbitrage',
    });
    expect(compatibilityZero.fields.profitUsd.status).toBe('unavailable');

    const genuineZero = resolveHistoricalScanFinancials({
      id: 25,
      positive_arb_count: 0,
      strategy: 'Buy YES Kalshi + NO PM',
      best_roi_pct: 0,
      best_profit: 0,
      apy_pct: 0,
      total_stake: 100,
      historical_financials_revision: 3,
      historical_financials_provenance: JSON.stringify({
        revision: 3,
        fields: {
          roiPct: { status: 'available' }, profitUsd: { status: 'available' },
          apyPct: { status: 'available' }, stakeUsd: { status: 'available' },
        },
      }),
    });
    expect(genuineZero.fields.roiPct).toMatchObject({
      status: 'unavailable', value: null, reasonCode: 'confirmed_no_arbitrage',
    });
    expect(genuineZero.fields.profitUsd).toMatchObject({
      status: 'unavailable', value: null, reasonCode: 'confirmed_no_arbitrage',
    });
  });
});
