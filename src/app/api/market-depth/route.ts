import { NextRequest, NextResponse } from 'next/server';
import { makeKalshiAuthHeaders } from '@/lib/kalshi-auth';
import { fetchClobBook, fetchClobMarket } from '@/lib/polymarket-clob';
import { buildDepthBook, buildKalshiYesBook, cumulativeLevels, type RawDepthLevel } from '@/lib/market-depth';

export const dynamic = 'force-dynamic';

type KalshiOrderbook = {
  orderbook_fp?: {
    yes_dollars?: [string, string][];
    no_dollars?: [string, string][];
  };
  // Legacy payload shape retained as a fallback for backwards compatibility.
  orderbook?: {
    yes_dollars_fp?: [string, string][];
    no_dollars_fp?: [string, string][];
  };
};

function toRawLevels(levels: [string, string][] | undefined): RawDepthLevel[] {
  return (levels ?? []).map(([price, size]) => ({ price, size }));
}

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const kalshiTicker = searchParams.get('kalshiTicker');
  const pmConditionId = searchParams.get('pmConditionId');

  if (!kalshiTicker || !pmConditionId) {
    return jsonError('kalshiTicker and pmConditionId are required', 400);
  }

  try {
    const kalshiPath = `/trade-api/v2/markets/${encodeURIComponent(kalshiTicker)}/orderbook`;
    const [kalshiResult, pmMarket] = await Promise.all([
      fetch(`https://external-api.kalshi.com${kalshiPath}`, {
        headers: makeKalshiAuthHeaders('GET', kalshiPath),
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      }),
      fetchClobMarket(pmConditionId),
    ]);

    if (!kalshiResult.ok) return jsonError(`Kalshi orderbook unavailable (HTTP ${kalshiResult.status})`, 502);
    if (!pmMarket) return jsonError('Polymarket market unavailable', 502);

    const yesToken = pmMarket.tokens.find(token => token.outcome.toLowerCase() === 'yes');
    if (!yesToken) return jsonError('Polymarket YES token unavailable', 502);

    const [kalshiData, pmBook] = await Promise.all([
      kalshiResult.json() as Promise<KalshiOrderbook>,
      fetchClobBook(yesToken.token_id),
    ]);
    if (!pmBook) return jsonError('Polymarket YES orderbook unavailable', 502);

    // Kalshi REST publishes YES and NO bid ladders under `orderbook_fp`.
    // A NO bid is an executable YES ask at 1 - NO bid.
    const kalshiYesBids = toRawLevels(kalshiData.orderbook_fp?.yes_dollars ?? kalshiData.orderbook?.yes_dollars_fp);
    const kalshiNoBids = toRawLevels(kalshiData.orderbook_fp?.no_dollars ?? kalshiData.orderbook?.no_dollars_fp);
    const kalshi = buildKalshiYesBook(kalshiYesBids, kalshiNoBids);
    const polymarket = buildDepthBook(pmBook.bids, pmBook.asks);

    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      kalshi: { label: 'Kalshi YES', ...kalshi, bids: cumulativeLevels(kalshi.bids), asks: cumulativeLevels(kalshi.asks) },
      polymarket: { label: 'Polymarket YES', ...polymarket, bids: cumulativeLevels(polymarket.bids), asks: cumulativeLevels(polymarket.asks) },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[api/market-depth]', error);
    return jsonError('Unable to load live market depth', 502);
  }
}
