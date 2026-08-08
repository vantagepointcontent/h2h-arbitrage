import { NextRequest, NextResponse } from 'next/server';
import { queryScanHistory, getSavedMarkets } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { parseLogLimit, parseOptionalFiniteNumber } from '@/lib/logs-request';

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
 *
 * PERF-P1: all filtering happens in SQLite (indexed) — no 10k-row JS pool.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const marketId = searchParams.get('marketId') || undefined;
    const limit = parseLogLimit(searchParams.get('limit'));
    const minRoi = parseOptionalFiniteNumber(searchParams.get('minRoi'));
    const positiveArbOnly = searchParams.get('positiveArbOnly') === 'true';
    const fromDate = searchParams.get('fromDate') || undefined;
    const toDate = searchParams.get('toDate') || undefined;
    const before = searchParams.get('before') || undefined; // MF-014: cursor

    const { rows: results, total, uniqueMarkets } = await queryScanHistory({
      marketId,
      minRoi,
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
    let categoryMap = new Map<string, string>();
    try {
      const saved = await getSavedMarkets();
      nameMap = new Map(saved.map((m) => [m.id, m.eventTitle]));
      categoryMap = new Map(saved.map((m) => [m.id, m.category ?? '']));
    } catch { /* name/category resolution is best-effort */ }
    const enriched = results.map((r: any) => ({
      ...r,
      market_name: r.market_title ?? nameMap.get(r.market_id) ?? null,
      category: categoryMap.get(r.market_id) ?? null,
    }));

    return NextResponse.json(
      { logs: enriched, count: enriched.length, total, uniqueMarkets, nextCursor },
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
