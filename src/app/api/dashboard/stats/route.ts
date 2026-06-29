import { NextRequest, NextResponse } from 'next/server';
import { getScanHistory } from '@/lib/persistence';

/**
 * GET /api/dashboard/stats
 *
 * Query params:
 *   range   — "today" | "7d" | "30d" | "90d" | "all" (default: "30d")
 *
 * Returns aggregated dashboard statistics from scan_results.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') || '30d';

    // Compute cutoff date
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

    // Fetch all records we need (SQLite doesn't support WHERE + aggregation well,
    // so we pull generously and aggregate in JS)
    const allRows = await getScanHistory(undefined, 500);

    // Filter by date range
    const rows = since
      ? allRows.filter((r: any) => (r.scanned_at ?? '') >= since!)
      : allRows;

    // ── KPI aggregations ──────────────────────────────────────
    const totalScans = rows.length;

    // Total arbs found (sum of positive_arb_count)
    const totalArbsFound = rows.reduce((s: number, r: any) => s + (r.positive_arb_count ?? 0), 0);

    // Active arbs now: scans in the last 5 minutes with positive_arb_count > 0
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    const activeArbs = rows.filter(
      (r: any) => (r.scanned_at ?? '') >= fiveMinAgo && (r.positive_arb_count ?? 0) > 0
    ).length;

    // Average ROI (net of fees — stored as-is in DB)
    const avgRoi = totalScans > 0
      ? rows.reduce((s: number, r: any) => s + (r.best_roi_pct ?? 0), 0) / totalScans
      : 0;

    // Distinct markets tracked
    const marketsSet = new Set(rows.map((r: any) => r.market_id).filter(Boolean));
    const marketsTracked = marketsSet.size;

    // Total profit (sum of best_profit, net of fees)
    const totalProfit = rows.reduce((s: number, r: any) => s + (r.best_profit ?? 0), 0);

    // ── Scans-per-day (last 30 days) ──────────────────────────
    const scansPerDay: { date: string; count: number }[] = [];
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      const ds = d.toISOString().slice(0, 10);
      const count = rows.filter(
        (r: any) => (r.scanned_at ?? '').slice(0, 10) === ds
      ).length;
      scansPerDay.push({ date: ds, count });
    }

    // ── ROI Distribution histogram ────────────────────────────
    const roiBuckets = [
      { label: '0–2%', low: 0, high: 2, count: 0 },
      { label: '2–5%', low: 2, high: 5, count: 0 },
      { label: '5–10%', low: 5, high: 10, count: 0 },
      { label: '10–20%', low: 10, high: 20, count: 0 },
      { label: '20%+', low: 20, high: Infinity, count: 0 },
    ];
    rows.forEach((r: any) => {
      const roi = r.best_roi_pct ?? 0;
      for (const b of roiBuckets) {
        if (roi >= b.low && roi < b.high) { b.count++; break; }
      }
    });

    // ── Timeline data (hourly buckets for line chart) ──────────
    const timelineData: { time: string; scans: number; avgRoi: number }[] = [];
    const hourlyMap = new Map<string, { scans: number; roiSum: number }>();
    rows.forEach((r: any) => {
      const ts = r.scanned_at ?? '';
      // Bucket by hour
      const bucket = ts.slice(0, 13) + ':00:00';
      const entry = hourlyMap.get(bucket);
      if (entry) {
        entry.scans++;
        entry.roiSum += r.best_roi_pct ?? 0;
      } else {
        hourlyMap.set(bucket, { scans: 1, roiSum: r.best_roi_pct ?? 0 });
      }
    });
    const sortedHours = [...hourlyMap.keys()].sort();
    for (const h of sortedHours) {
      const e = hourlyMap.get(h)!;
      timelineData.push({
        time: h,
        scans: e.scans,
        avgRoi: e.scans > 0 ? +(e.roiSum / e.scans).toFixed(2) : 0,
      });
    }

    // ── Top active arbs (recent scans with positive arbs) ──────
    const topActiveArbs = rows
      .filter((r: any) => (r.positive_arb_count ?? 0) > 0)
      .sort((a: any, b: any) => (b.best_roi_pct ?? 0) - (a.best_roi_pct ?? 0))
      .slice(0, 10)
      .map((r: any) => ({
        id: r.id,
        market_id: r.market_id,
        best_roi_pct: r.best_roi_pct,
        best_profit: r.best_profit,
        strategy: r.strategy,
        positive_arb_count: r.positive_arb_count,
        scanned_at: r.scanned_at,
      }));

    return NextResponse.json({
      kpis: {
        totalArbsFound,
        activeArbs,
        totalScans,
        avgRoi,
        marketsTracked,
        totalProfit,
      },
      scansPerDay,
      roiDistribution: roiBuckets,
      timeline: timelineData,
      topActiveArbs,
      range,
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to fetch dashboard stats' },
      { status: 500 }
    );
  }
}
