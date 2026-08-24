import { describe, expect, it } from 'vitest';
import { evaluateLogsDataQuality, type LogsQualityBatchInput } from './logs-data-quality';

function row(overrides: Partial<LogsQualityBatchInput['rows'][number]> = {}): LogsQualityBatchInput['rows'][number] {
  return {
    id: 1,
    scanStatus: 'completed',
    positiveArbCount: 1,
    hasSelectedCandidate: true,
    arbValid: true,
    roiPct: 2.5,
    profitUsd: 5,
    apyPct: 25,
    apyEligible: true,
    state: 'completed',
    exactMarketIdentity: true,
    currentRoiPct: 2.5,
    reasons: {},
    ...overrides,
  };
}

describe('evaluateLogsDataQuality', () => {
  it('reports denominator, unavailable percentage, and reasons for every required metric', () => {
    const quality = evaluateLogsDataQuality({ batchId: 'b-1', rows: [
      row(),
      row({ id: 2, profitUsd: null, reasons: { profit: 'historical_profit_not_persisted' } }),
    ], previousBatch: null });

    expect(quality.fields.profit).toMatchObject({
      denominator: 2,
      available: 1,
      unavailable: 1,
      unavailablePct: 50,
      reasons: { historical_profit_not_persisted: 1 },
    });
    expect(quality.fields.roi.unavailablePct).toBe(0);
    expect(quality.fields.apy.denominator).toBe(2);
    expect(quality.fields.state.unavailablePct).toBe(0);
    expect(quality.fields.currentRoi.unavailablePct).toBe(0);
  });

  it('degrades immediately above fifty percent and requests bounded reconciliation', () => {
    const quality = evaluateLogsDataQuality({ batchId: 'b-2', rows: [
      row({ profitUsd: null, reasons: { profit: 'source_input_unavailable' } }),
    ], previousBatch: null });

    expect(quality.state).toBe('degraded');
    expect(quality.breaches).toEqual([expect.objectContaining({ field: 'profit', trigger: 'single_batch_over_50pct' })]);
    expect(quality.reconciliation).toEqual({ requested: true, maxAttempts: 2 });
  });

  it('degrades after two consecutive batches above five percent and clears only after a verified batch', () => {
    const first = evaluateLogsDataQuality({ batchId: 'b-3', rows: Array.from({ length: 10 }, (_, id) => row({
      id,
      roiPct: id === 0 ? null : 2.5,
      reasons: id === 0 ? { roi: 'source_input_unavailable' } : {},
    })), previousBatch: null });
    expect(first.state).toBe('warning');

    const second = evaluateLogsDataQuality({ batchId: 'b-4', rows: Array.from({ length: 10 }, (_, id) => row({
      id,
      roiPct: id === 0 ? null : 2.5,
      reasons: id === 0 ? { roi: 'source_input_unavailable' } : {},
    })), previousBatch: first });
    expect(second.state).toBe('degraded');
    expect(second.breaches).toEqual([expect.objectContaining({ field: 'roi', trigger: 'two_consecutive_batches_over_5pct' })]);

    const recovered = evaluateLogsDataQuality({ batchId: 'b-5', rows: [row()], previousBatch: second });
    expect(recovered.state).toBe('healthy');
    expect(recovered.recoveryVerified).toBe(true);
  });

  it('enforces the 95% availability floor at the exact contract boundary', () => {
    const rows = Array.from({ length: 20 }, (_, id) => row({
      id,
      roiPct: id === 0 ? null : 2.5,
      reasons: id === 0 ? { roi: 'source_input_unavailable' } : {},
    }));
    const atFloor = evaluateLogsDataQuality({ batchId: 'availability-95', rows, previousBatch: null });

    expect(atFloor.fields.roi).toMatchObject({ denominator: 20, available: 19, unavailable: 1, unavailablePct: 5 });
    expect(atFloor.state).toBe('healthy');
    expect(atFloor.breaches).toEqual([]);

    const belowFloorRows = rows.map((candidate, id) => id === 1
      ? { ...candidate, roiPct: null, reasons: { roi: 'source_input_unavailable' } }
      : candidate);
    const firstBelowFloor = evaluateLogsDataQuality({
      batchId: 'availability-90-first', rows: belowFloorRows, previousBatch: atFloor,
    });
    expect(firstBelowFloor.fields.roi.unavailablePct).toBe(10);
    expect(firstBelowFloor.state).toBe('warning');

    const secondBelowFloor = evaluateLogsDataQuality({
      batchId: 'availability-90-second', rows: belowFloorRows, previousBatch: firstBelowFloor,
    });
    expect(secondBelowFloor.state).toBe('degraded');
    expect(secondBelowFloor.breaches).toContainEqual(expect.objectContaining({
      field: 'roi', trigger: 'two_consecutive_batches_over_5pct', unavailablePct: 10,
    }));
  });

  it('excludes APY without recoverable event-time TTE and current ROI without exact identity from denominators', () => {
    const quality = evaluateLogsDataQuality({ batchId: 'b-6', rows: [row({
      apyPct: null,
      apyEligible: false,
      exactMarketIdentity: false,
      currentRoiPct: null,
      reasons: { apy: 'missing_event_time_tte', currentRoi: 'missing_exact_link_identity' },
    })], previousBatch: null });

    expect(quality.fields.apy.denominator).toBe(0);
    expect(quality.fields.currentRoi.denominator).toBe(0);
    expect(quality.state).toBe('healthy');
  });

  it('excludes completed zero-arb rows from every arb-only metric denominator', () => {
    const quality = evaluateLogsDataQuality({ batchId: 'zero-arb-na', rows: [row({
      positiveArbCount: 0,
      hasSelectedCandidate: true,
      roiPct: null,
      profitUsd: null,
      apyPct: null,
      currentRoiPct: null,
      reasons: {
        roi: 'confirmed_no_arbitrage',
        profit: 'confirmed_no_arbitrage',
        apy: 'confirmed_no_arbitrage',
        currentRoi: 'latest_completed_scan_has_no_arbitrage',
      },
    })], previousBatch: null });

    expect(quality.state).toBe('healthy');
    expect(quality.breaches).toEqual([]);
    expect(quality.fields.state.denominator).toBe(1);
    for (const field of ['roi', 'profit', 'apy', 'currentRoi'] as const) {
      expect(quality.fields[field]).toMatchObject({ denominator: 0, unavailable: 0, unavailablePct: 0 });
    }
  });

  it('fails immediately when every eligible historical ROI is exactly zero after a non-zero population', () => {
    const previous = evaluateLogsDataQuality({ batchId: 'non-zero-baseline', rows: [row({ roiPct: 2.5 })], previousBatch: null });
    const allZero = evaluateLogsDataQuality({
      batchId: 'all-zero-regression',
      rows: Array.from({ length: 20 }, (_, id) => row({ id, roiPct: 0 })),
      previousBatch: previous,
    });

    expect(allZero.state).toBe('degraded');
    expect(allZero.fields.roi).toMatchObject({ denominator: 20, available: 20, exactlyZero: 20, nonZero: 0 });
    expect(allZero.breaches).toContainEqual(expect.objectContaining({ field: 'roi', trigger: 'all_zero_population' }));
    expect(allZero.reconciliation).toEqual({ requested: true, maxAttempts: 2 });
  });

  it('does not treat all-zero non-executable candidates as an applicable population', () => {
    const quality = evaluateLogsDataQuality({
      batchId: 'cold-all-zero',
      rows: Array.from({ length: 20 }, (_, id) => row({
        id, positiveArbCount: 0, hasSelectedCandidate: true,
        roiPct: 0, profitUsd: 0, apyPct: 0, currentRoiPct: 0,
      })),
      previousBatch: null,
    });

    expect(quality.fields.roi).toMatchObject({ denominator: 0, exactlyZero: 0, nonZero: 0 });
    expect(quality.state).toBe('healthy');
    expect(quality.breaches).toEqual([]);
  });

  it('degrades when more than five percent of a recent cohort becomes zero without requiring population shrinkage', () => {
    const baseline = evaluateLogsDataQuality({
      batchId: 'non-zero-94',
      rows: Array.from({ length: 94 }, (_, id) => row({ id, roiPct: 2.5 })),
      previousBatch: null,
    });
    const regressed = evaluateLogsDataQuality({
      batchId: 'six-new-zeros',
      rows: [
        ...Array.from({ length: 94 }, (_, id) => row({ id, roiPct: 2.5 })),
        ...Array.from({ length: 6 }, (_, offset) => row({ id: 94 + offset, roiPct: 0 })),
      ],
      previousBatch: baseline,
    });

    expect(regressed.fields.roi).toMatchObject({ denominator: 100, exactlyZero: 6, nonZero: 94 });
    expect(regressed.state).toBe('degraded');
    expect(regressed.breaches).toContainEqual(expect.objectContaining({
      field: 'roi', trigger: 'zero_regression_over_5pct', unavailablePct: 6,
    }));
  });
});
