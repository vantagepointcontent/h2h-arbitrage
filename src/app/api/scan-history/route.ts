import { NextRequest, NextResponse } from 'next/server';
import { getScanHistory, getSavedMarkets } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';

/**
 * GET /api/scan-history?marketId=x&limit=20
 *
 * Returns scan results from SQLite, optionally filtered by marketId.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const marketId = searchParams.get('marketId') || undefined;
    const limitStr = searchParams.get('limit');
    const limit = limitStr ? Math.min(Math.max(Number(limitStr), 1), 500) : 20;

    const history = await getScanHistory(marketId, limit);

    // UI-015: attach human-readable names
    let nameMap = new Map<string, string>();
    try {
      const saved = await getSavedMarkets();
      nameMap = new Map(saved.map((m) => [m.id, m.eventTitle]));
    } catch { /* best-effort */ }
    const enriched = history.map((r: any) => ({
      ...r,
      market_name: r.market_title ?? nameMap.get(r.market_id) ?? null,
    }));

    return NextResponse.json({ history: enriched, count: enriched.length }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err, 'Failed to fetch scan history') }, { status: 500 });
  }
}
