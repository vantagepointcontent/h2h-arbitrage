import type { RateLimiterConfig, RateLimiterMetrics, ThrottleSnapshot } from './rate-limiter';
import type { RateLimiterMetricRecord } from './persistence';

export interface RateLimiterCaptureDeps {
  serviceIdentity: 'next-app' | 'full-scan-worker';
  now?: () => Date;
  snapshot: () => Array<{
    label: string;
    metrics: RateLimiterMetrics;
    throttle: ThrottleSnapshot;
    config: RateLimiterConfig;
  }>;
  persist: (records: RateLimiterMetricRecord[]) => Promise<void>;
  resetters: Array<() => void>;
}

type LimiterSnapshot = ReturnType<RateLimiterCaptureDeps['snapshot']>[number];

export function buildRateLimiterMetricRecords(
  serviceIdentity: RateLimiterCaptureDeps['serviceIdentity'],
  snapshots: LimiterSnapshot[],
  now = new Date(),
): RateLimiterMetricRecord[] {
  const timestamp = now.toISOString();
  return snapshots.map((snapshot) => ({
    limiterName: snapshot.label,
    timestamp,
    totalRequests: snapshot.metrics.totalRequests,
    queuedRequests: snapshot.metrics.queuedRequests,
    rejectedRequests: snapshot.metrics.rejectedRequests,
    retry429Count: snapshot.metrics.retry429Count,
    avgQueueWaitMs: snapshot.metrics.avgQueueWaitMs,
    tokensAvailable: snapshot.throttle.tokens,
    isThrottled: snapshot.throttle.isThrottled,
    effectiveRate: snapshot.throttle.effectiveRate,
    refillIntervalMs: snapshot.config.refillIntervalMs,
    serviceIdentity,
  }));
}

/**
 * Persist counters from the process that actually made the upstream calls.
 * Counters are reset only after the durable write succeeds, so a temporary
 * SQLite failure cannot silently erase capacity evidence.
 */
export async function captureAndPersistRateLimiterMetrics(deps: RateLimiterCaptureDeps): Promise<number> {
  const records = buildRateLimiterMetricRecords(
    deps.serviceIdentity,
    deps.snapshot(),
    (deps.now ?? (() => new Date()))(),
  );

  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await deps.persist(records);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/SQLITE_BUSY|database is locked|cannot commit transaction/i.test(message) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
  if (lastError) throw lastError;
  for (const reset of deps.resetters) reset();
  return records.length;
}
