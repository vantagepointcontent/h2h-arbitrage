import { NextResponse } from 'next/server';
import { getSavedMarkets } from '@/lib/persistence';

export async function GET() {
  try {
    const markets = await getSavedMarkets();
    return NextResponse.json({
      status: 'ok',
      savedMarketCount: markets.length,
      now: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      status: 'error',
      error: message,
      now: new Date().toISOString(),
    }, { status: 500 });
  }
}
