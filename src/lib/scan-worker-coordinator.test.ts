import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanWorkerCoordinator, type ScanWorkerHandle } from './scan-worker-coordinator';

class FakeWorker extends EventEmitter implements ScanWorkerHandle {
  terminate = vi.fn(async () => 0);
  postMessage = vi.fn();
}

describe('ScanWorkerCoordinator', () => {
  let workers: FakeWorker[];
  let coordinator: ScanWorkerCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    workers = [];
    coordinator = new ScanWorkerCoordinator({
      maxConcurrent: 1,
      timeoutMs: 1_000,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      now: () => Date.now(),
    });
  });

  it('deduplicates the same market generation onto one worker', async () => {
    const first = coordinator.run('market-a', { body: '{}' });
    const duplicate = coordinator.run('market-a', { body: '{}' });

    expect(workers).toHaveLength(1);
    workers[0].emit('message', { type: 'result', response: { status: 200, headers: {}, body: '{"ok":true}' } });

    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(duplicate).resolves.toMatchObject({ status: 200 });
    expect(coordinator.snapshot().deduplicatedJobs).toBe(1);
  });

  it('preserves overload semantics for a different market at capacity', async () => {
    const active = coordinator.run('market-a', { body: '{}' });

    await expect(coordinator.run('market-b', { body: '{}' })).rejects.toMatchObject({ code: 'SCAN_CAPACITY' });
    workers[0].emit('message', { type: 'result', response: { status: 200, headers: {}, body: '{}' } });
    await active;
    expect(coordinator.snapshot().rejectedJobs).toBe(1);
  });

  it('terminates timed-out computation so it cannot publish late', async () => {
    const pending = coordinator.run('market-a', { body: '{}' });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'SCAN_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(1_001);

    await rejection;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toMatchObject({ activeJobs: 0, timedOutJobs: 1 });
  });

  it('cancels an abandoned sole subscriber but keeps shared work alive', async () => {
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = coordinator.run('market-a', { body: '{}' }, firstAbort.signal);
    const second = coordinator.run('market-a', { body: '{}' }, secondAbort.signal);
    const firstRejection = expect(first).rejects.toMatchObject({ code: 'SCAN_CANCELLED' });

    firstAbort.abort();
    await firstRejection;
    expect(workers[0].terminate).not.toHaveBeenCalled();

    workers[0].emit('message', { type: 'result', response: { status: 200, headers: {}, body: '{}' } });
    await expect(second).resolves.toMatchObject({ status: 200 });
  });

  it('reports queue, duration, cancellation, and active-job instrumentation', async () => {
    const abort = new AbortController();
    const pending = coordinator.run('market-a', { body: '{}' }, abort.signal);
    const rejection = expect(pending).rejects.toMatchObject({ code: 'SCAN_CANCELLED' });
    expect(coordinator.snapshot()).toMatchObject({ queueDepth: 0, activeJobs: 1, completedJobs: 0 });

    abort.abort();
    await rejection;

    expect(coordinator.snapshot()).toMatchObject({ activeJobs: 0, cancelledJobs: 1 });
  });
});
