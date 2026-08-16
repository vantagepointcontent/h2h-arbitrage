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
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot().deduplicatedJobs).toBe(1);
  });

  it('durably accepts worker telemetry before completing concurrent scans', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const acceptTelemetry = vi.fn()
      .mockImplementationOnce(async () => firstGate)
      .mockResolvedValueOnce(undefined);
    coordinator = new ScanWorkerCoordinator({
      maxConcurrent: 2,
      timeoutMs: 1_000,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      now: () => Date.now(),
      acceptTelemetry,
    });
    const first = coordinator.run('market-a', { body: '{}' });
    const second = coordinator.run('market-b', { body: '{}' });
    const telemetry = [{ limiterName: 'kalshi', timestamp: '2026-08-16T14:00:00.000Z', totalRequests: 1 }];

    workers[0].emit('message', { type: 'result', response: { status: 200, headers: {}, body: '{}' }, telemetry });
    workers[1].emit('message', { type: 'result', response: { status: 200, headers: {}, body: '{}' }, telemetry });
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.snapshot().completedJobs).toBe(1);
    expect(acceptTelemetry).toHaveBeenCalledTimes(2);

    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(acceptTelemetry).toHaveBeenCalledTimes(2);
  });

  it('does not turn a completed scan into a failed response when telemetry spooling fails', async () => {
    coordinator = new ScanWorkerCoordinator({
      maxConcurrent: 1,
      timeoutMs: 1_000,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      acceptTelemetry: vi.fn(async () => { throw new Error('spool unavailable'); }),
    });
    const pending = coordinator.run('market-a', { body: '{}' });
    workers[0].emit('message', {
      type: 'result',
      response: { status: 200, headers: {}, body: '{"persisted":true}' },
      telemetry: [{ limiterName: 'kalshi' }],
    });
    await expect(pending).resolves.toMatchObject({ status: 200, body: '{"persisted":true}' });
    expect(coordinator.snapshot()).toMatchObject({ completedJobs: 1, failedJobs: 0 });
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
