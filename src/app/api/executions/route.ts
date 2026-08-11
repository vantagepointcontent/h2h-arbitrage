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
    const methodParam = searchParams.get('method');
    if (methodParam && !['roi', 'apy', 'hybrid', 'legacy'].includes(methodParam)) {
      return NextResponse.json({ success: false, error: 'method must be roi, apy, hybrid, or legacy' }, { status: 400 });
    }
    const sortParam = searchParams.get('sortMethod');
    if (sortParam && !['asc', 'desc'].includes(sortParam)) {
      return NextResponse.json({ success: false, error: 'sortMethod must be asc or desc' }, { status: 400 });
    }
    const executions = await getExecutions(limit, undefined, {
      selectionMethod: methodParam as 'roi' | 'apy' | 'hybrid' | 'legacy' | undefined,
      sortMethod: sortParam as 'asc' | 'desc' | undefined,
    });
    return NextResponse.json(
      { success: true, count: executions.length, executions },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (err) {
    return NextResponse.json({ success: false, error: clientSafeError(err) }, { status: 500 });
  }
}
