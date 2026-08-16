import { NextRequest, NextResponse } from 'next/server';
import { getCapacityUtilization, getOperationalTelemetryFreshness } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { parseDashboardRange } from '@/lib/dashboard-request';
import { readWorkerTelemetryWriteHealth } from '@/lib/scan-worker-coordinator';

function freshnessState(timestamp: string | null, staleAfterMs: number, degradedState: string) {
  const ageMs = timestamp == null ? null : Math.max(0, Date.now() - Date.parse(timestamp));
  return {
    state: ageMs == null || ageMs > staleAfterMs ? degradedState : 'healthy',
    lastObservedAt: timestamp,
    ageMs,
    staleAfterMs,
  };
}

/**
 * GET /api/dashboard/capacity
 *
 * Query params:
 *   range — "today" | "7d" | "30d" | "90d" | "all" (default: "30d")
 *
 * Returns hourly capacity utilization % per upstream API. Missing samples are
 * represented as null and never silently converted to confirmed zero usage.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const range = parseDashboardRange(searchParams.get('range'));

    let since: string | undefined;
    const now = new Date();
    switch (range) {
      case 'today':
        since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        break;
      case '7d':
        since = new Date(now.getTime() - 7 * 86400000).toISOString();
        break;
      case '90d':
        since = new Date(now.getTime() - 90 * 86400000).toISOString();
        break;
      case '30d':
        since = new Date(now.getTime() - 30 * 86400000).toISOString();
        break;
      case 'all':
        since = undefined;
        break;
      default:
        since = new Date(now.getTime() - 30 * 86400000).toISOString();
    }

    const [rows, freshness, workerWriteHealth] = await Promise.all([
      getCapacityUtilization(since),
      getOperationalTelemetryFreshness(),
      readWorkerTelemetryWriteHealth(),
    ]);

    const endMs = Date.parse(new Date().toISOString().slice(0, 13) + ':00:00Z');
    const firstObserved = rows.map((row: { hour: string }) => row.hour).sort()[0];
    const startIso = since ?? firstObserved ?? new Date(endMs).toISOString();
    const startMs = Date.parse(startIso.slice(0, 13) + ':00:00Z');
    const hours: string[] = [];
    for (let cursor = startMs; cursor <= endMs; cursor += 3_600_000) {
      hours.push(new Date(cursor).toISOString().slice(0, 19));
    }

    // Limiters we want explicit series for (PredictionHunt intentionally omitted from chart)
    const chartLimiters = ['gamma', 'clob-markets', 'clob-book', 'kalshi'];
    const displayNames: Record<string, string> = {
      gamma: 'Gamma',
      'clob-markets': 'CLOB Markets',
      'clob-book': 'CLOB Book',
      kalshi: 'Kalshi',
      predictionhunt: 'PredictionHunt',
    };

    type CapRow = {
      hour: string;
      limiter: string;
      utilizationPct: number;
      totalRequests: number;
      maxRequests: number;
      isThrottled: number;
      avgQueueWaitMs: number;
      rejectedRequests: number;
      sampleCount: number;
      lastSampleAt: string;
      serviceIdentities: string[];
    };

    const series: Array<{ name: string; data: Array<Record<string, unknown>> }> = [];
    for (const limiter of chartLimiters) {
      const byHour = new Map<string, CapRow>(rows.filter((r: CapRow) => r.limiter === limiter).map((r: CapRow) => [r.hour, r]));
      const data = hours.map((hour: string) => {
        const r = byHour.get(hour);
        return {
          hour,
          limiter,
          utilizationPct: r?.utilizationPct ?? null,
          sampleState: r
            ? (r.totalRequests > 0
              ? 'observed_usage'
              : hour === new Date().toISOString().slice(0, 13) + ':00:00'
              && Date.now() - Date.parse(r.lastSampleAt) > 5 * 60_000
              ? 'stale_last_known_sample'
              : 'confirmed_zero')
            : 'no_samples',
          isThrottled: r?.isThrottled ?? 0,
          avgQueueWaitMs: r?.avgQueueWaitMs ?? 0,
          rejectedRequests: r?.rejectedRequests ?? 0,
          totalRequests: r?.totalRequests ?? 0,
          maxRequests: r?.maxRequests ?? null,
          sampleCount: r?.sampleCount ?? 0,
          lastSampleAt: r?.lastSampleAt ?? null,
          serviceIdentities: r?.serviceIdentities ?? [],
        };
      });
      series.push({ name: displayNames[limiter] ?? limiter, data });
    }

    return NextResponse.json({
      range,
      hours,
      series,
      telemetry: {
        collector: freshnessState(freshness.latestCapacitySampleAt, 5 * 60_000, 'collector_degraded'),
        workerCollector: freshnessState(freshness.latestWorkerCapacitySampleAt, 5 * 60_000, 'worker_collector_degraded'),
        workerWrites: {
          state: workerWriteHealth.error ? 'worker_collector_write_degraded' : 'healthy',
          ...workerWriteHealth,
        },
        scanner: freshnessState(freshness.latestCompletedScanAt, 10 * 60_000, 'scanner_degraded'),
      },
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to fetch capacity data') },
      { status: 500 }
    );
  }
}
