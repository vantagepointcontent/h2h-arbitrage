import { NextRequest, NextResponse } from 'next/server';
import { getCatalogStatus } from '@/lib/market-catalog';

export const dynamic = 'force-dynamic';

/**
 * GET /api/catalog/status
 *
 * Returns the current catalog job status: last run time, markets fetched,
 * 429s encountered, per-category progress, and overall catalog size.
 */
export async function GET(_request: NextRequest) {
  try {
    const status = await getCatalogStatus();
    return NextResponse.json(status, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: any) {
    console.error('[catalog/status] Failed:', err);
    return NextResponse.json(
      { error: err.message || 'Catalog status failed' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
