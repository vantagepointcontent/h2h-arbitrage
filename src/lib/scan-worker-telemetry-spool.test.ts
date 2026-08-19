import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RateLimiterMetricRecord } from './persistence';
import { WorkerTelemetrySpool } from './scan-worker-telemetry-spool';
import { getSqliteContentionMetrics } from './sqlite-write-retry';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(timestamp: string): RateLimiterMetricRecord {
  return {
    limiterName: 'kalshi', timestamp, totalRequests: 3, queuedRequests: 0,
    rejectedRequests: 0, retry429Count: 0, avgQueueWaitMs: 0,
    tokensAvailable: 2, isThrottled: false, effectiveRate: 5,
    refillIntervalMs: 200, serviceIdentity: 'full-scan-worker',
  };
}

async function paths() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'h2h-telemetry-spool-'));
  roots.push(root);
  return { root, spoolDir: path.join(root, 'spool'), healthPath: path.join(root, 'health.json') };
}

describe('WorkerTelemetrySpool', () => {
  it('reports auxiliary telemetry contention without incrementing canonical exhaustion counters', async () => {
    const p = await paths();
    getSqliteContentionMetrics(true);
    const persist = vi.fn(async () => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });
    const spool = new WorkerTelemetrySpool({ ...p, persist, autoDrain: false, autoRetry: false });
    await spool.accept('job-busy', [record('2026-08-16T18:29:00.000Z')]);

    await spool.drain();

    expect(getSqliteContentionMetrics()).toMatchObject({ busyRetries: 0, exhaustedWrites: 0 });
    expect(await spool.readHealth()).toMatchObject({ pendingSnapshots: 1, writeFailures: 1, error: 'database is locked' });
  });

  it('retains exhausted writes and drains them after a process restart', async () => {
    const p = await paths();
    const blockedPersist = vi.fn(async () => { throw new Error('sustained writer contention'); });
    const first = new WorkerTelemetrySpool({ ...p, persist: blockedPersist, autoDrain: false, autoRetry: false });
    await first.accept('job-1', [record('2026-08-16T18:30:00.000Z')]);

    for (let attempt = 0; attempt < 4; attempt += 1) await first.drain();
    expect(await readdir(p.spoolDir)).toEqual(['job-1.json']);
    expect(await first.readHealth()).toMatchObject({ pendingSnapshots: 1, writeFailures: 4 });

    const recoveredPersist = vi.fn(async () => undefined);
    const restarted = new WorkerTelemetrySpool({ ...p, persist: recoveredPersist, autoDrain: false, autoRetry: false });
    await restarted.readHealth();
    await restarted.drain();

    expect(recoveredPersist).toHaveBeenCalledOnce();
    expect(recoveredPersist).toHaveBeenCalledWith([record('2026-08-16T18:30:00.000Z')]);
    expect(await readdir(p.spoolDir)).toEqual([]);
    expect(await restarted.readHealth()).toMatchObject({ pendingSnapshots: 0, recoveredSnapshots: 1, error: null });
  });

  it('uses the worker job id as an idempotent spool key', async () => {
    const p = await paths();
    const persist = vi.fn(async () => undefined);
    const spool = new WorkerTelemetrySpool({ ...p, persist, autoDrain: false, autoRetry: false });
    const records = [record('2026-08-16T18:31:00.000Z')];
    await spool.accept('same-job', records);
    await spool.accept('same-job', records);
    expect(await readdir(p.spoolDir)).toEqual(['same-job.json']);
    await spool.drain();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('drains a bounded snapshot batch in one idempotent SQLite write', async () => {
    const p = await paths();
    const persist = vi.fn(async () => undefined);
    const spool = new WorkerTelemetrySpool({ ...p, persist, autoDrain: false, autoRetry: false });
    await spool.accept('job-1', [record('2026-08-16T18:31:00.000Z')]);
    await spool.accept('job-2', [record('2026-08-16T18:32:00.000Z')]);
    await spool.accept('job-3', [record('2026-08-16T18:33:00.000Z')]);

    await spool.drain();

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith([
      record('2026-08-16T18:31:00.000Z'),
      record('2026-08-16T18:32:00.000Z'),
      record('2026-08-16T18:33:00.000Z'),
    ]);
    expect(await readdir(p.spoolDir)).toEqual([]);
  });
});