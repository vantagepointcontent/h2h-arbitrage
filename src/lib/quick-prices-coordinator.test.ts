import { describe, expect, it, vi } from 'vitest';
import { QuickPricesCoordinator, QuickPricesCoordinatorError } from './quick-prices-coordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('QuickPricesCoordinator', () => {
  it('deduplicates repeated requests for the same saved market and capital', async () => {
    const work = deferred<string>();
    const task = vi.fn(() => work.promise);
    const coordinator = new QuickPricesCoordinator({ maxConcurrent: 2 });

    const first = coordinator.run('market-1|1000', task);
    const repeated = coordinator.run('market-1|1000', task);
    work.resolve('prices');

    await expect(first).resolves.toMatchObject({ value: 'prices', deduplicated: false });
    await expect(repeated).resolves.toMatchObject({ value: 'prices', deduplicated: true });
    expect(task).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toMatchObject({ activeJobs: 0, completedJobs: 1, deduplicatedJobs: 1 });
  });

  it('rejects distinct work immediately when manual-refresh capacity is saturated', async () => {
    const work = deferred<string>();
    const coordinator = new QuickPricesCoordinator({ maxConcurrent: 1 });
    const first = coordinator.run('market-1|1000', () => work.promise);

    await expect(coordinator.run('market-2|1000', async () => 'other')).rejects.toMatchObject({
      code: 'QUICK_CAPACITY',
    } satisfies Partial<QuickPricesCoordinatorError>);
    expect(coordinator.snapshot()).toMatchObject({ activeJobs: 1, rejectedJobs: 1, queueDepth: 0 });

    work.resolve('prices');
    await first;
  });

  it('releases capacity after a failed refresh', async () => {
    const coordinator = new QuickPricesCoordinator({ maxConcurrent: 1 });
    await expect(coordinator.run('market-1', () => { throw new Error('upstream failed'); })).rejects.toThrow('upstream failed');
    await expect(coordinator.run('market-2', async () => 'ok')).resolves.toMatchObject({ value: 'ok' });
    expect(coordinator.snapshot()).toMatchObject({ activeJobs: 0, failedJobs: 1, completedJobs: 1 });
  });
});
