import { NextRequest, NextResponse } from 'next/server';
import { queryExecutions } from '@/lib/persistence';
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
    const rawOffset = searchParams.get('offset');
    if (rawOffset !== null && (!/^\d+$/.test(rawOffset) || Number(rawOffset) > 1_000_000)) {
      return NextResponse.json({ success: false, error: 'offset must be an integer between 0 and 1000000' }, { status: 400 });
    }
    const offset = parseBoundedInteger(rawOffset, 0, 0, 1_000_000);
    const sourceParam = searchParams.get('source');
    if (sourceParam !== null && !['manual', 'bot', 'unknown'].includes(sourceParam)) {
      return NextResponse.json({ success: false, error: 'source must be manual, bot, or unknown' }, { status: 400 });
    }
    const viewParam = searchParams.get('view');
    if (viewParam !== null && !['real', 'dry', 'pending'].includes(viewParam)) {
      return NextResponse.json({ success: false, error: 'view must be real, dry, or pending' }, { status: 400 });
    }
    const methodParam = searchParams.get('method');
    if (methodParam && !['roi', 'apy', 'hybrid', 'legacy'].includes(methodParam)) {
      return NextResponse.json({ success: false, error: 'method must be roi, apy, hybrid, or legacy' }, { status: 400 });
    }
    const sortParam = searchParams.get('sortMethod');
    if (sortParam && !['asc', 'desc'].includes(sortParam)) {
      return NextResponse.json({ success: false, error: 'sortMethod must be asc or desc' }, { status: 400 });
    }
    const page = await queryExecutions({
      limit,
      offset,
      source: sourceParam == null ? undefined : sourceParam as 'manual' | 'bot' | 'unknown',
      view: viewParam == null ? undefined : viewParam as 'real' | 'dry' | 'pending',
      selectionMethod: methodParam as 'roi' | 'apy' | 'hybrid' | 'legacy' | undefined,
      sortMethod: sortParam as 'asc' | 'desc' | undefined,
    });
    return NextResponse.json(
      { success: true, count: page.executions.length, ...page },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (err) {
    return NextResponse.json({ success: false, error: clientSafeError(err) }, { status: 500 });
  }
}
