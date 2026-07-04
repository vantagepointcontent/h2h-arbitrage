import { NextRequest, NextResponse } from 'next/server';
import { getExecutions } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';

/* TRADES-001: GET /api/executions — durable trade history for the Trades page. */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get('limit') || 200);
    const executions = await getExecutions(limit);
    return NextResponse.json(
      { success: true, count: executions.length, executions },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (err) {
    return NextResponse.json({ success: false, error: clientSafeError(err) }, { status: 500 });
  }
}
