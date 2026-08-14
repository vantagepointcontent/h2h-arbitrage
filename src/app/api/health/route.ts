import { NextResponse } from 'next/server';
import { getSavedMarkets, recoverInterruptedScanPublications } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { getScanWorkerMetrics } from '@/lib/scan-worker-coordinator';
import { getSqliteContentionMetrics } from '@/lib/sqlite-write-retry';
import { getQuickPricesMetrics } from '@/lib/quick-prices-coordinator';

let recovery: Promise<number> | null = null;

export async function GET() {
  try {
    recovery ??= recoverInterruptedScanPublications();
    await recovery;
    const markets = await getSavedMarkets();
    return NextResponse.json({
      status: 'ok',
      savedMarketCount: markets.length,
      scanWorkers: getScanWorkerMetrics(),
      quickPrices: getQuickPricesMetrics(),
      sqliteContention: getSqliteContentionMetrics(),
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
