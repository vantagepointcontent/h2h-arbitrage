export interface QuickPricesCoordinatorMetrics {
  queueDepth: number;
  activeJobs: number;
  completedJobs: number;
  failedJobs: number;
  rejectedJobs: number;
  deduplicatedJobs: number;
  lastDurationMs: number | null;
  maxDurationMs: number;
}

interface QuickPricesCoordinatorOptions {
  maxConcurrent?: number;
  now?: () => number;
}

interface ActiveQuickPricesJob<T = unknown> {
  startedAt: number;
  promise: Promise<T>;
}

export class QuickPricesCoordinatorError extends Error {
  constructor(
    message: string,
    public readonly code: 'QUICK_CAPACITY',
  ) {
    super(message);
    this.name = 'QuickPricesCoordinatorError';
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

/**
 * In-process admission control for manual saved-market price refreshes.
 * Exact repeats share one bounded upstream scan; distinct bursts fail fast
 * rather than queueing behind work the operator can no longer see.
 */
export class QuickPricesCoordinator {
  private readonly active = new Map<string, ActiveQuickPricesJob>();
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private metrics: QuickPricesCoordinatorMetrics = {
    queueDepth: 0,
    activeJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    rejectedJobs: 0,
    deduplicatedJobs: 0,
    lastDurationMs: null,
    maxDurationMs: 0,
  };

  constructor(options: QuickPricesCoordinatorOptions = {}) {
    this.maxConcurrent = positiveInteger(options.maxConcurrent, 2);
    this.now = options.now ?? Date.now;
  }

  async run<T>(
    key: string,
    task: () => Promise<T>,
  ): Promise<{ value: T; deduplicated: boolean; durationMs: number }> {
    const existing = this.active.get(key) as ActiveQuickPricesJob<T> | undefined;
    if (existing) {
      this.metrics.deduplicatedJobs += 1;
      const value = await existing.promise;
      return { value, deduplicated: true, durationMs: Math.max(0, this.now() - existing.startedAt) };
    }
    if (this.active.size >= this.maxConcurrent) {
      this.metrics.rejectedJobs += 1;
      throw new QuickPricesCoordinatorError('Manual price refresh is at capacity', 'QUICK_CAPACITY');
    }

    const startedAt = this.now();
    const promise = Promise.resolve().then(task);
    const job: ActiveQuickPricesJob<T> = { startedAt, promise };
    this.active.set(key, job);
    this.metrics.activeJobs = this.active.size;
    try {
      const value = await promise;
      this.metrics.completedJobs += 1;
      return { value, deduplicated: false, durationMs: Math.max(0, this.now() - startedAt) };
    } catch (error) {
      this.metrics.failedJobs += 1;
      throw error;
    } finally {
      if (this.active.get(key) === job) this.active.delete(key);
      const durationMs = Math.max(0, this.now() - startedAt);
      this.metrics.lastDurationMs = durationMs;
      this.metrics.maxDurationMs = Math.max(this.metrics.maxDurationMs, durationMs);
      this.metrics.activeJobs = this.active.size;
    }
  }

  snapshot(): QuickPricesCoordinatorMetrics {
    return { ...this.metrics, queueDepth: 0, activeJobs: this.active.size };
  }
}

export const quickPricesCoordinator = new QuickPricesCoordinator({
  maxConcurrent: positiveInteger(Number(process.env.H2H_QUICK_PRICES_CONCURRENCY), 2),
});

export function getQuickPricesMetrics(): QuickPricesCoordinatorMetrics {
  return quickPricesCoordinator.snapshot();
}
