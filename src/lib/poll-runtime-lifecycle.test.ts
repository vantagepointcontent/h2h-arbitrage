import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('BUG-140 production poller lifecycle evidence', () => {
  it('persists manual-success breaker reset across restart while later linked markets progress', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/bug-140-runtime-evidence.mjs'], {
      cwd: process.cwd(),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const report = JSON.parse(stdout);

    expect(report.processRuns).toBe(10);
    expect(report.restartRecovery).toMatchObject({
      productionPollerSpawnedTwice: true,
      schedulerFileSurvived: true,
      breakerFileSurvived: true,
      staleManualSuccessCooldownRestored: false,
      duplicateConcurrentScans: false,
      overlappingProcessLifetimes: true,
      abandonedOwnerKilled: true,
      crossProcessSchedulerUpdatesMerged: true,
      crossProcessBreakerUpdatesMerged: true,
      liveLeaseFencedSuccessor: true,
      expiredLeaseFencedAtServer: true,
      abandonedLeaseReclaimed: true,
    });
    expect(report.restartRecovery.maxObservedConcurrency).toBeGreaterThan(1);
    expect(report.fairness.laterFinalEntryCompletedEveryCycle).toBe(true);
    expect(report.requestScope.linkedEventUrlsOnly).toBe(true);
    expect(report.requestScope.fields).toEqual(['kalshiUrl', 'polymarketUrl']);
    expect(report.cycles).toHaveLength(2);
  }, 65_000);
});
