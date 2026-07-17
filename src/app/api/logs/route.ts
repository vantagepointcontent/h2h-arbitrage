import { NextRequest, NextResponse } from 'next/server';
import { queryScanHistory, getSavedMarkets } from '@/lib/persistence';
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
 *
 * PERF-P1: all filtering happens in SQLite (indexed) — no 10k-row JS pool.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const marketId = searchParams.get('marketId') || undefined;
    const limitStr = searchParams.get('limit');
    const limit = limitStr ? Math.min(Math.max(Number(limitStr), 1), 500) : 100;
    const minRoiStr = searchParams.get('minRoi');
    const minRoi = minRoiStr !== null ? parseFloat(minRoiStr) : undefined;
    const positiveArbOnly = searchParams.get('positiveArbOnly') === 'true';
    const fromDate = searchParams.get('fromDate') || undefined;
    const toDate = searchParams.get('toDate') || undefined;
    const before = searchParams.get('before') || undefined; // MF-014: cursor

    const { rows: results, total } = await queryScanHistory({
      marketId,
      minRoi: minRoi !== undefined && !isNaN(minRoi) ? minRoi : undefined,
      positiveArbOnly,
      fromDate,
      toDate,
      limit,
      before,
    });

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
      { logs: enriched, count: enriched.length, total, nextCursor },
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
