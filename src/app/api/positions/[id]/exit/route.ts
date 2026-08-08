import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import { getExecutionMode } from '@/lib/settings';
import { executePositionExit, type PositionExitRequest } from '@/lib/positions-exit';
import { placeKalshiSellOrder } from '@/lib/kalshi-orders';
import { placePmSellOrder } from '@/lib/polymarket-orders';
import { persistClosedPosition } from '@/lib/persistence';
import logger from '@/lib/logger';

export const dynamic = 'force-dynamic';

/** Manual-only exit endpoint. The position id is also checked against pairId in the body. */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const [{ id }, body] = await Promise.all([context.params, req.json() as Promise<PositionExitRequest>]);
    if (!body || body.pairId !== id) {
      return NextResponse.json({ error: 'Position id does not match pairId' }, { status: 400 });
    }

    const mode = await getExecutionMode().catch(() => 'paper' as const);
    if (mode !== 'live') {
      return NextResponse.json(
        { error: `Execution mode is ${mode}. Switch explicitly to live before closing positions.` },
        { status: 403 },
      );
    }

    logger.warn('[positions] MANUAL exit requested', { pairId: id, legs: { kalshi: !!body.kalshi, polymarket: !!body.polymarket } });
    const result = await executePositionExit(body, {
      sellKalshi: (leg, clientOrderId) => placeKalshiSellOrder({
        ticker: leg.ticker,
        side: leg.side.toLowerCase() as 'yes' | 'no',
        count: Math.floor(leg.size),
        priceCents: Math.round(leg.priceCents),
        clientOrderId,
      }),
      sellPolymarket: (leg) => placePmSellOrder({ tokenId: leg.asset, price: leg.price, size: leg.size }),
      persistClosedPosition,
      alert: (message, metadata) => logger.error(`[positions] ${message}`, metadata),
    });

    return NextResponse.json(result, { status: result.success ? 200 : result.partialFill ? 409 : 502 });
  } catch (error) {
    return NextResponse.json({ error: clientSafeError(error) }, { status: 500 });
  }
}
