import { NextRequest, NextResponse } from 'next/server';
import { getBotPositions, type BotPositionStatus } from '@/lib/bot-positions';
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
    const offsetParam = params.get('offset');
    if (offsetParam != null && !/^\d+$/.test(offsetParam)) {
      return NextResponse.json({ success: false, error: 'offset must be a non-negative integer' }, { status: 400 });
    }
    const offset = offsetParam == null ? 0 : Number(offsetParam);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return NextResponse.json({ success: false, error: 'offset must be a non-negative integer' }, { status: 400 });
    }
    const storedPositions = await getBotPositions({
      status: statusParam as BotPositionStatus | 'all',
      limit,
      offset,
    });
    const positions = await Promise.all(storedPositions.map(async (position) => {
      if (!position.marketId) return { ...position, kalshiUrl: null, polymarketUrl: null };
      const urls = await getMarketUrlsById(position.marketId);
      return { ...position, kalshiUrl: urls?.kalshiUrl ?? null, polymarketUrl: urls?.polymarketUrl ?? null };
    }));
    const marketActiveUnits = new Map<string, number>();
    for (const p of positions) {
      if (p.status !== 'open' || !p.marketId) continue;
      marketActiveUnits.set(p.marketId, (marketActiveUnits.get(p.marketId) ?? 0) + 1);
    }
    const enrichedPositions = positions.map((p) => ({
      ...p,
      activeUnits: p.marketId ? (marketActiveUnits.get(p.marketId) ?? 0) : 1,
      maxUnitsPerMarket: 3,
    }));
    return NextResponse.json(
      { success: true, count: enrichedPositions.length, positions: enrichedPositions },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (error) {
    return NextResponse.json({ success: false, error: clientSafeError(error) }, { status: 500 });
  }
}
