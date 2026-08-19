import { mkdir, rm } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', dbPath: '' }));
vi.hoisted(() => {
  state.root = `/tmp/h2h-rate-limiter-persistence-${process.pid}`;
  state.dbPath = `${state.root}/edgefinder.db`;
  process.env.H2H_SQLITE_PATH = state.dbPath;
  process.env.H2H_SAVED_MARKETS_FILE = `${state.root}/saved-markets.json`;
});

import { persistRateLimiterMetrics, type RateLimiterMetricRecord } from './persistence';

const sample: RateLimiterMetricRecord = {
  limiterName: 'kalshi',
  timestamp: '2026-08-19T02:30:00.000Z',
  totalRequests: 3,
  queuedRequests: 0,
  rejectedRequests: 0,
  retry429Count: 0,
  avgQueueWaitMs: 0,
  tokensAvailable: 2,
  isThrottled: false,
  effectiveRate: 5,
  refillIntervalMs: 200,
  serviceIdentity: 'full-scan-worker',
};

beforeAll(async () => {
  await rm(state.root, { recursive: true, force: true });
  await mkdir(state.root, { recursive: true });
});

afterAll(async () => {
  await rm(state.root, { recursive: true, force: true });
});

describe('rate limiter telemetry persistence', () => {
  it('deduplicates replayed snapshots without rewriting historical rows', async () => {
    await Promise.all([
      persistRateLimiterMetrics([sample]),
      persistRateLimiterMetrics([sample]),
    ]);

    const db = createClient({ url: `file:${state.dbPath}` });
    const result = await db.execute(`SELECT COUNT(*) AS count, COUNT(DISTINCT ingest_key) AS keys
      FROM rate_limiter_metrics WHERE limiter_name = 'kalshi'`);
    db.close();
    expect(Number(result.rows[0].count)).toBe(1);
    expect(Number(result.rows[0].keys)).toBe(1);
  });
});
