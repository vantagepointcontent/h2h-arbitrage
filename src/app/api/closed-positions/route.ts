import { NextRequest, NextResponse } from 'next/server';
import { getClosedPositions } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { parseBoundedInteger } from '@/lib/request-query';

export const dynamic = 'force-dynamic';

/** Full, fee-netted history created automatically by successful position exits. */
export async function GET(request: NextRequest) {
  try {
    const limit = parseBoundedInteger(new URL(request.url).searchParams.get('limit'), 500, 1, 1000);
    const positions = await getClosedPositions(limit);
    return NextResponse.json(
      { success: true, count: positions.length, positions },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (error) {
    return NextResponse.json({ success: false, error: clientSafeError(error) }, { status: 500 });
  }
}