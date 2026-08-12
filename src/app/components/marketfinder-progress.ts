import type { SyncProgress } from '@/lib/catalog-progress';

export type SyncStepState = 'pending' | 'active' | 'done' | 'error';

export function getSyncProgressPercent(progress: SyncProgress): number {
  if (progress.step === 'complete') return 100;
  if (progress.step === 'error') return Math.min(100, Math.max(0, (progress.stepIndex / progress.totalSteps) * 100));

  let withinStep = 0;
  if (progress.step === 'verifying' && progress.verifiedTotal > 0) {
    withinStep = progress.verified / progress.verifiedTotal;
  }
  return Math.round(Math.min(1, Math.max(0, (progress.stepIndex + withinStep) / progress.totalSteps)) * 100);
}

export function getSyncStepState(stepIndex: number, progress: SyncProgress): SyncStepState {
  if (progress.step === 'error' && stepIndex === Math.min(progress.stepIndex, progress.totalSteps)) return 'error';
  if (progress.step === 'complete' || stepIndex < progress.stepIndex) return 'done';
  if (stepIndex === progress.stepIndex) return 'active';
  return 'pending';
}
