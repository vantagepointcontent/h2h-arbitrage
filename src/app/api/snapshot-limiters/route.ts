import { NextRequest, NextResponse } from 'next/server';
import { snapshotRateLimiterMetrics, rateLimiters } from '@/lib/rate-limiter';
import { persistRateLimiterMetrics } from '@/lib/persistence';

/**
 * POST /api/snapshot-limiters
 *
 * Internal endpoint used by the poller to persist in-memory rate-limiter
 * metrics into the SQLite `rate_limiter_metrics` table. This runs inside
 * the Next.js process so it can import the live singleton limiters directly.
 *
 * Guarded by H2H_API_TOKEN when the env var is set (checks x-h2h-token
 * and x-api-token to stay compatible with poller conventions).
 */
export async function POST(request: NextRequest) {
  const token = process.env.H2H_API_TOKEN;
  if (token) {
    const provided = request.headers.get('x-h2h-token') ?? request.headers.get('x-api-token');
    if (provided !== token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const now = new Date().toISOString();
    const snapshots = snapshotRateLimiterMetrics();
    const records = snapshots.map((s) => ({
      limiterName: s.label,
      timestamp: now,
      totalRequests: s.metrics.totalRequests,
      queuedRequests: s.metrics.queuedRequests,
      rejectedRequests: s.metrics.rejectedRequests,
      retry429Count: s.metrics.retry429Count,
      avgQueueWaitMs: s.metrics.avgQueueWaitMs,
      tokensAvailable: s.throttle.tokens,
      isThrottled: s.throttle.isThrottled,
      effectiveRate: s.throttle.effectiveRate,
      refillIntervalMs: s.config.refillIntervalMs,
    }));

    await persistRateLimiterMetrics(records);

    // Reset cumulative counters after snapshot so each hour's count reflects
    // traffic in that hour, not a forever-growing total.
    for (const limiter of Object.values(rateLimiters)) {
      limiter.resetMetrics();
    }

    return NextResponse.json({ persisted: records.length }, { status: 200 });
  } catch (err: any) {
    console.error('[snapshot-limiters] Failed:', err);
    return NextResponse.json({ error: err.message || 'Snapshot failed' }, { status: 500 });
  }
}
