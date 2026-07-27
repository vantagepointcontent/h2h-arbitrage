import { NextRequest, NextResponse } from 'next/server';
import { getExecutions } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { parseBoundedInteger } from '@/lib/request-query';

/* TRADES-001: GET /api/executions — durable trade history for the Trades page. */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    // Reject decimal, negative, non-finite, and oversized limits before they
    // reach the persistence layer. This keeps the public route bounded even
    // when its database implementation changes.
    const limit = parseBoundedInteger(searchParams.get('limit'), 200, 1, 1000);
    const executions = await getExecutions(limit);
    return NextResponse.json(
      { success: true, count: executions.length, executions },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (err) {
    return NextResponse.json({ success: false, error: clientSafeError(err) }, { status: 500 });
  }
}
