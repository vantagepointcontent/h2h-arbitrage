import { NextResponse } from 'next/server';
import { getSavedMarkets, recoverInterruptedScanPublications } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { getScanWorkerMetrics } from '@/lib/scan-worker-coordinator';
import { getSqliteContentionMetrics } from '@/lib/sqlite-write-retry';
import { getQuickPricesMetrics } from '@/lib/quick-prices-coordinator';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyPollerHealth, type PollerHealthSnapshot } from '@/lib/poller-health';

let recovery: Promise<number> | null = null;

async function readPollerHealth(): Promise<PollerHealthSnapshot | null> {
  try {
    const value: unknown = JSON.parse(await readFile(
      path.join(process.cwd(), 'data', 'poller-health.json'),
      'utf8',
    ));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as PollerHealthSnapshot
      : null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    recovery ??= recoverInterruptedScanPublications();
    await recovery;
    const [markets, pollerSnapshot] = await Promise.all([getSavedMarkets(), readPollerHealth()]);
    const pollerStatus = classifyPollerHealth(pollerSnapshot);
    return NextResponse.json({
      status: 'ok',
      savedMarketCount: markets.length,
      scanWorkers: getScanWorkerMetrics(),
      quickPrices: getQuickPricesMetrics(),
      sqliteContention: getSqliteContentionMetrics(),
      savedMarketScheduler: {
        ...pollerStatus,
        status: pollerSnapshot?.status ?? null,
        pollerPid: pollerSnapshot?.pollerPid ?? null,
        heartbeatAt: pollerSnapshot?.heartbeatAt ?? null,
        startedAt: pollerSnapshot?.startedAt ?? null,
        finishedAt: pollerSnapshot?.finishedAt ?? null,
        durationMs: pollerSnapshot?.durationMs ?? null,
        successCount: pollerSnapshot?.successCount ?? null,
        failureCount: pollerSnapshot?.failureCount ?? null,
        avgScanMs: pollerSnapshot?.avgScanMs ?? null,
        maxScanMs: pollerSnapshot?.maxScanMs ?? null,
        openBreakers: pollerSnapshot?.openBreakers ?? null,
        capacity: pollerSnapshot?.capacity ?? null,
        progress: pollerSnapshot?.progress ?? null,
        queue: pollerSnapshot?.queue ?? null,
      },
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
