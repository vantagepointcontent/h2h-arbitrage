// Shared in-memory progress store for the catalog sync + matcher SSE endpoint.
// Progress is keyed by a sync run id. The SSE route writes updates; the
// frontend can also poll GET /api/catalog/sync?runId=... for the latest state.

export type SyncStep =
  | 'idle'
  | 'fetching_kalshi'
  | 'fetching_polymarket'
  | 'matching'
  | 'verifying'
  | 'complete'
  | 'error';

export interface SyncProgress {
  runId: string;
  step: SyncStep;
  stepIndex: number;
  totalSteps: number;
  kalshiCount: number;
  polymarketCount: number;
  candidates: number;
  verified: number;
  verifiedTotal: number;
  newPairs: number;
  message: string;
  error?: string;
  finishedAt?: string;
}

const runs = new Map<string, SyncProgress>();
const listeners = new Map<string, Set<(p: SyncProgress) => void>>();

export function createSyncRun(runId: string): SyncProgress {
  const progress: SyncProgress = {
    runId,
    step: 'idle',
    stepIndex: 0,
    totalSteps: 5,
    kalshiCount: 0,
    polymarketCount: 0,
    candidates: 0,
    verified: 0,
    verifiedTotal: 0,
    newPairs: 0,
    message: 'Starting scan...',
  };
  runs.set(runId, progress);
  listeners.set(runId, new Set());
  return progress;
}

export function getSyncProgress(runId: string): SyncProgress | undefined {
  return runs.get(runId);
}

export function updateSyncProgress(
  runId: string,
  patch: Partial<SyncProgress> & { step?: SyncStep },
): SyncProgress {
  let p = runs.get(runId);
  if (!p) {
    p = createSyncRun(runId);
  }
  const stepOrder: Record<SyncStep, number> = {
    idle: 0,
    fetching_kalshi: 1,
    fetching_polymarket: 2,
    matching: 3,
    verifying: 4,
    complete: 5,
    error: 99,
  };
  const next: SyncProgress = {
    ...p,
    ...patch,
    stepIndex: patch.step ? stepOrder[patch.step] : p.stepIndex,
  };
  runs.set(runId, next);
  listeners.get(runId)?.forEach((cb) => cb(next));
  return next;
}

export function subscribeSyncProgress(
  runId: string,
  cb: (p: SyncProgress) => void,
): () => void {
  let set = listeners.get(runId);
  if (!set) {
    set = new Set();
    listeners.set(runId, set);
  }
  set.add(cb);
  const current = runs.get(runId);
  if (current) cb(current);
  return () => set?.delete(cb);
}
