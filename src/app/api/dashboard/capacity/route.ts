import { NextRequest, NextResponse } from 'next/server';
import { getCapacityUtilization } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { parseDashboardRange } from '@/lib/dashboard-request';

/**
 * GET /api/dashboard/capacity
 *
 * Query params:
 *   range — "today" | "7d" | "30d" | "90d" | "all" (default: "30d")
 *
 * Returns hourly capacity utilization % per upstream API. Each row is one
 * hour (newest first) and includes one series per limiter. Gaps are filled
 * with 0% so the line chart is continuous. Aggregation is SQL-side.
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

    const rows = await getCapacityUtilization(since);

    // Build a continuous hour index, oldest → newest (chart-friendly)
    const hoursSet = new Set(rows.map((r: { hour: string }) => r.hour));
    if (since) hoursSet.add(since.slice(0, 13) + ':00:00');
    hoursSet.add(new Date().toISOString().slice(0, 13) + ':00:00');
    const hours = Array.from(hoursSet).sort();

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
    };

    const series: { name: string; data: CapRow[] }[] = [];
    for (const limiter of chartLimiters) {
      const byHour = new Map<string, CapRow>(rows.filter((r: CapRow) => r.limiter === limiter).map((r: CapRow) => [r.hour, r]));
      const data = hours.map((hour: string) => {
        const r = byHour.get(hour);
        return {
          hour,
          limiter,
          utilizationPct: r?.utilizationPct ?? 0,
          isThrottled: r?.isThrottled ?? 0,
          avgQueueWaitMs: r?.avgQueueWaitMs ?? 0,
          rejectedRequests: r?.rejectedRequests ?? 0,
          totalRequests: r?.totalRequests ?? 0,
          maxRequests: r?.maxRequests ?? Math.round((3600 * 1000) / 1000),
        };
      });
      series.push({ name: displayNames[limiter] ?? limiter, data });
    }

    return NextResponse.json({
      range,
      hours,
      series,
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to fetch capacity data') },
      { status: 500 }
    );
  }
}
