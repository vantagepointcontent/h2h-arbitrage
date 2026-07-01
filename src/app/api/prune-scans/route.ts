import { NextRequest, NextResponse } from 'next/server';
import { pruneOldScans, getScanCount } from '@/lib/persistence';

/**
 * POST /api/prune-scans
 *
 * Prune scan results older than `days` days.
 * Query params:
 *   days — retention period in days (default: 30)
 *
 * Response:
 *   { deleted: number, remaining: number }
 */
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Math.max(1, parseInt(searchParams.get('days') || '30', 10));

    const deleted = await pruneOldScans(days);
    const remaining = await getScanCount();

    console.log(`[prune-scans] Deleted ${deleted} rows older than ${days}d, ${remaining} remaining`);

    return NextResponse.json({ deleted, remaining, retentionDays: days });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to prune scans' },
      { status: 500 },
    );
  }
}