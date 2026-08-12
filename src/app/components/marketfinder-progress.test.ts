import { describe, expect, it } from 'vitest';
import { createSyncRun, updateSyncProgress } from '@/lib/catalog-progress';
import { getSyncProgressPercent, getSyncStepState } from './marketfinder-progress';

const base = {
  runId: 'run-1',
  stepIndex: 4,
  totalSteps: 5,
  kalshiCount: 100,
  polymarketCount: 50,
  candidates: 20,
  verified: 5,
  verifiedTotal: 10,
  newPairs: 3,
  message: 'Verifying',
};

describe('MarketFinder sync progress model', () => {
  it('uses verification counts for real-time percentage', () => {
    expect(getSyncProgressPercent({ ...base, step: 'verifying' })).toBe(90);
  });

  it('reports complete as 100 percent', () => {
    expect(getSyncProgressPercent({ ...base, step: 'complete', stepIndex: 5 })).toBe(100);
  });

  it('never regresses the visible step when parallel fetch updates interleave', () => {
    createSyncRun('parallel-run');
    updateSyncProgress('parallel-run', { step: 'fetching_polymarket', polymarketCount: 500 });
    const progress = updateSyncProgress('parallel-run', { step: 'fetching_kalshi', kalshiCount: 1000 });

    expect(progress.step).toBe('fetching_polymarket');
    expect(progress.stepIndex).toBe(2);
    expect(progress.kalshiCount).toBe(1000);
  });

  it('keeps the last active step when a sync errors', () => {
    createSyncRun('error-run');
    updateSyncProgress('error-run', { step: 'matching' });
    const progress = updateSyncProgress('error-run', { step: 'error', error: 'failed' });

    expect(progress.step).toBe('error');
    expect(progress.stepIndex).toBe(3);
    expect(getSyncProgressPercent(progress)).toBe(60);
  });

  it('marks earlier steps done, current step active, and later steps pending', () => {
    expect(getSyncStepState(1, { ...base, step: 'matching', stepIndex: 3 })).toBe('done');
    expect(getSyncStepState(3, { ...base, step: 'matching', stepIndex: 3 })).toBe('active');
    expect(getSyncStepState(4, { ...base, step: 'matching', stepIndex: 3 })).toBe('pending');
  });
});
