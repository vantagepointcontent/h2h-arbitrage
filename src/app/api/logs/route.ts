import { NextRequest, NextResponse } from 'next/server';
import { getScanHistory } from '@/lib/persistence';

/**
 * GET /api/logs
 *
 * Query params:
 *   marketId   — filter by market ID
 *   limit      — max results (default 100, max 500)
 *   minRoi     — only return scans with bestRoiPct >= this value
 *   positiveArbOnly=true — only return scans with positive_arb_count > 0
 *   fromDate   — ISO date string, scans at or after
 *   toDate     — ISO date string, scans at or before
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const marketId = searchParams.get('marketId') || undefined;
    const limitStr = searchParams.get('limit');
    const limit = limitStr ? Math.min(Math.max(Number(limitStr), 1), 500) : 100;
    const minRoi = searchParams.get('minRoi');
    const positiveArbOnly = searchParams.get('positiveArbOnly') === 'true';
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');

    // Fetch a generous pool then filter in-app — SQLite ORDER BY + LIMIT is simple enough
    const pool = await getScanHistory(marketId, 500);

    let filtered = pool;

    if (minRoi !== null && minRoi !== undefined) {
      const min = parseFloat(minRoi);
      if (!isNaN(min)) {
        filtered = filtered.filter((r: any) => (r.best_roi_pct ?? 0) >= min);
      }
    }

    if (positiveArbOnly) {
      filtered = filtered.filter((r: any) => (r.positive_arb_count ?? 0) > 0);
    }

    if (fromDate) {
      const from = new Date(fromDate).getTime();
      if (!isNaN(from)) {
        filtered = filtered.filter((r: any) => {
          const t = new Date(r.scanned_at).getTime();
          return !isNaN(t) && t >= from;
        });
      }
    }

    if (toDate) {
      const to = new Date(toDate).getTime();
      if (!isNaN(to)) {
        filtered = filtered.filter((r: any) => {
          const t = new Date(r.scanned_at).getTime();
          return !isNaN(t) && t <= to;
        });
      }
    }

    const results = filtered.slice(0, limit);

    return NextResponse.json(
      { logs: results, count: results.length, total: filtered.length },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
        },
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to fetch logs' },
      { status: 500 }
    );
  }
}