import { NextRequest, NextResponse } from 'next/server';
import { getBotPositions, type BotPositionStatus } from '@/lib/bot-positions';
import { clientSafeError } from '@/lib/error-handler';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const params = new URL(request.url).searchParams;
    const statusParam = params.get('status') ?? 'all';
    if (!['open', 'settled', 'all'].includes(statusParam)) {
      return NextResponse.json({ success: false, error: 'status must be open, settled, or all' }, { status: 400 });
    }
    const limitParam = params.get('limit');
    if (limitParam != null && !/^\d+$/.test(limitParam)) {
      return NextResponse.json({ success: false, error: 'limit must be an integer' }, { status: 400 });
    }
    const limit = limitParam == null ? 100 : Number(limitParam);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      return NextResponse.json({ success: false, error: 'limit must be between 1 and 1000' }, { status: 400 });
    }
    const positions = await getBotPositions({
      status: statusParam as BotPositionStatus | 'all',
      limit,
    });
    return NextResponse.json(
      { success: true, count: positions.length, positions },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (error) {
    return NextResponse.json({ success: false, error: clientSafeError(error) }, { status: 500 });
  }
}
