import { NextRequest, NextResponse } from 'next/server';
import { getScanHistory, getSavedMarkets } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';

/**
 * GET /api/logs
 *
 * Query params:
 *   marketId   — filter by market ID
 *   limit      — max results (default 100, max 200)
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
    const limit = limitStr ? Math.min(Math.max(Number(limitStr), 1), 200) : 100;
    const minRoi = searchParams.get('minRoi');
    const positiveArbOnly = searchParams.get('positiveArbOnly') === 'true';
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');

    // Fetch a generous pool then filter in-app — SQLite ORDER BY + LIMIT is simple enough
    const pool = await getScanHistory(marketId, 10000);

    let filtered = pool;

    if (minRoi) {
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
    const nextCursor = results.length === limit ? results[results.length - 1].scanned_at : undefined;

    // UI-015: resolve human-readable market names. Prefer the name stored at
    // scan time (market_title), fall back to a live join with saved markets.
    let nameMap = new Map<string, string>();
    try {
      const saved = await getSavedMarkets();
      nameMap = new Map(saved.map((m) => [m.id, m.eventTitle]));
    } catch { /* name resolution is best-effort */ }
    const enriched = results.map((r: any) => ({
      ...r,
      market_name: r.market_title ?? nameMap.get(r.market_id) ?? null,
    }));

    return NextResponse.json(
      { logs: enriched, count: enriched.length, total: filtered.length, nextCursor },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
        },
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to fetch logs') },
      { status: 500 }
    );
  }
}