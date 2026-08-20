import { describe, expect, it } from 'vitest';
import { evaluateLogsDataQuality, type LogsQualityBatchInput } from './logs-data-quality';

function row(overrides: Partial<LogsQualityBatchInput['rows'][number]> = {}): LogsQualityBatchInput['rows'][number] {
  return {
    id: 1,
    scanStatus: 'completed',
    positiveArbCount: 1,
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

    expect(quality.fields.profit).toEqual({
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
});
