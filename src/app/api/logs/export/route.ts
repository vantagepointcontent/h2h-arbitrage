import { NextRequest, NextResponse } from 'next/server';
import { getScanHistory } from '@/lib/persistence';

/**
 * GET /api/logs/export
 *
 * Returns a CSV file for Excel. Same filters as /api/logs but always
 * returns all matching rows (up to 500).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const marketId = searchParams.get('marketId') || undefined;
    const minRoi = searchParams.get('minRoi');
    const positiveArbOnly = searchParams.get('positiveArbOnly') === 'true';
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');

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

    // Build CSV
    const headers = [
      'Scan Time',
      'Market ID',
      'Strategy',
      'ROI %',
      'Profit ($)',
      'Matched Count',
      'Kalshi Count',
      'PM Count',
      'Positive Arb Count',
      'Total Stake ($)',
      'Outcome Count',
    ];

    const escapeCsv = (val: any): string => {
      if (val === null || val === undefined) return '';
      const s = String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const rows = filtered.map((r: any) =>
      [
        r.scanned_at,
        r.market_id,
        r.strategy,
        r.best_roi_pct,
        r.best_profit,
        r.matched_count,
        r.kalshi_count,
        r.pm_count,
        r.positive_arb_count,
        r.total_stake,
        r.outcome_count,
      ]
        .map(escapeCsv)
        .join(',')
    );

    const csv = [headers.join(','), ...rows].join('\n');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="edgefinder-logs-${timestamp}.csv"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to export logs' },
      { status: 500 }
    );
  }
}