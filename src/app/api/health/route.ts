import { NextResponse } from 'next/server';
import { getSavedMarkets } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';

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
    const message = clientSafeError(err, 'Health check failed');
    return NextResponse.json({
      status: 'error',
      error: message,
      now: new Date().toISOString(),
    }, { status: 500 });
  }
}
