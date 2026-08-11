import { NextRequest, NextResponse } from 'next/server';
import { getBotPositionMarkets } from '@/lib/bot-positions';
import { clientSafeError } from '@/lib/error-handler';
import { getMarketUrlsById } from '@/lib/persistence';

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
    const cursor = params.get('cursor');
    if (cursor != null && (cursor.length === 0 || cursor.length > 2048)) {
      return NextResponse.json({ success: false, error: 'cursor is invalid' }, { status: 400 });
    }
    const page = await getBotPositionMarkets({
      status: statusParam as 'all' | 'open' | 'settled',
      limit,
      cursor,
    });
    const markets = await Promise.all(page.markets.map(async (market) => {
      const urls = market.marketId ? await getMarketUrlsById(market.marketId) : null;
      const kalshiUrl = urls?.kalshiUrl ?? null;
      const polymarketUrl = urls?.polymarketUrl ?? null;
      const executions = market.executions.map((execution) => ({ ...execution, kalshiUrl, polymarketUrl }));
      return { ...market, kalshiUrl, polymarketUrl, executions, entries: executions };
    }));
    const positions = markets.flatMap((market) => market.executions);
    return NextResponse.json(
      {
        success: true,
        count: positions.length,
        marketCount: markets.length,
        markets,
        nextCursor: page.nextCursor,
        positions,
      },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid positions cursor') {
      return NextResponse.json({ success: false, error: 'cursor is invalid' }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: clientSafeError(error) }, { status: 500 });
  }
}
