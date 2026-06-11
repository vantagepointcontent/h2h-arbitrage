import { NextRequest, NextResponse } from 'next/server';
import { getScanHistory } from '@/lib/persistence';

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

    return NextResponse.json({ history, count: history.length }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch scan history' }, { status: 500 });
  }
}
