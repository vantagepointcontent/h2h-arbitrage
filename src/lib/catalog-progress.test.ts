import { describe, expect, it, vi } from 'vitest';
import {
  createSyncRun,
  getSyncProgress,
  subscribeSyncProgress,
  updateSyncProgress,
} from './catalog-progress';

describe('catalog progress lifecycle', () => {
  it('drops listeners after a run reaches a terminal state', () => {
    const runId = `terminal-${crypto.randomUUID()}`;
    createSyncRun(runId);
    const listener = vi.fn();
    subscribeSyncProgress(runId, listener);

    updateSyncProgress(runId, { step: 'complete', finishedAt: new Date().toISOString() });
    updateSyncProgress(runId, { message: 'late update' });

    expect(listener).toHaveBeenCalledTimes(2); // initial snapshot + terminal update
  });

  it('bounds retained sync history and evicts the oldest completed runs', () => {
    const prefix = `retention-${crypto.randomUUID()}`;
    for (let index = 0; index < 101; index += 1) {
      const runId = `${prefix}-${index}`;
      createSyncRun(runId);
      updateSyncProgress(runId, { step: 'complete', finishedAt: new Date().toISOString() });
    }

    expect(getSyncProgress(`${prefix}-0`)).toBeUndefined();
    expect(getSyncProgress(`${prefix}-100`)?.step).toBe('complete');
  });
});
