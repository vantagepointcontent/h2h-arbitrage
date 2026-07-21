import { NextRequest, NextResponse } from 'next/server';
import { pruneOldScans, getScanCount } from '@/lib/persistence';
import { pruneOldEpisodes } from '@/lib/arb-lifecycle';
import { clientSafeError } from '@/lib/error-handler';
import { parseRetentionDays } from '@/lib/retention-request';

function authorized(request: NextRequest): boolean {
  const token = process.env.H2H_API_TOKEN;
  return !token || request.headers.get('x-api-token') === token;
}

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
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const days = parseRetentionDays(searchParams.get('days'));
  if (typeof days !== 'number') {
    return NextResponse.json({ error: days.error }, { status: 400 });
  }

  try {

    const deleted = await pruneOldScans(days);
    const remaining = await getScanCount();
    // Closed arb episodes get a longer retention (90d) — they're the
    // lifecycle dataset and much smaller than raw scan rows.
    const episodesDeleted = await pruneOldEpisodes(90);

    console.log(`[prune-scans] Deleted ${deleted} rows older than ${days}d, ${remaining} remaining, ${episodesDeleted} old arb episodes pruned`);

    return NextResponse.json({ deleted, remaining, retentionDays: days, episodesDeleted });
  } catch (err: any) {
    return NextResponse.json(
      { error: clientSafeError(err, 'Failed to prune scans') },
      { status: 500 },
    );
  }
}