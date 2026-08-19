import { NextResponse } from 'next/server';
import { getClosedPositions, getExecutions } from '@/lib/persistence';
import { summarizeDailyPnl } from '@/lib/daily-pnl';
import { clientSafeError } from '@/lib/error-handler';
import { GET as getPositions } from '@/app/api/positions/route';

export const dynamic = 'force-dynamic';

/** UI-025: today's live trading summary using the US Eastern calendar day. */
export async function GET() {
  try {
    const [executions, closedPositions, positionsResponse] = await Promise.all([
      getExecutions(1000),
      getClosedPositions(5000),
      getPositions().catch(() => null),
    ]);

    let positions: Array<{ breakdown?: { totalNetPnl?: number | null } }> = [];
    if (positionsResponse?.ok) {
      const payload = await positionsResponse.json().catch(() => null);
      if (Array.isArray(payload?.positions)) positions = payload.positions;
    }

    return NextResponse.json(
      summarizeDailyPnl({ executions, closedPositions, positions }),
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: clientSafeError(error, 'Failed to load daily P&L') },
      { status: 500 },
    );
  }
}
