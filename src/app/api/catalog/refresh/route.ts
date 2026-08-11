import { NextRequest, NextResponse } from 'next/server';
import { refreshMarketCatalog } from '@/lib/market-catalog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/catalog/refresh
 *
 * Manual trigger for the market catalog fetch job. The normal daily run is
 * scheduled via PM2 cron; this endpoint is for on-demand refresh.
 *
 * Query params:
 *   ?full=true   Force a full refresh (default is incremental since last full fetch).
 *
 * The job is serialized inside refreshMarketCatalog(), so concurrent calls wait
 * instead of stampeding the upstream APIs.
 */
export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const full = searchParams.get('full') === 'true';

  try {
    // Serialize the manual trigger with the daily run guard.
    const result = await refreshMarketCatalog({ full });
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: any) {
    console.error('[catalog/refresh] Failed:', err);
    return NextResponse.json(
      { error: err.message || 'Catalog refresh failed' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
