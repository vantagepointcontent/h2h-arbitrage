import { connection, NextResponse } from 'next/server';
import { getSavedMarkets, recoverInterruptedScanPublications, getLogsDataQualityHealth } from '@/lib/persistence';
import { clientSafeError } from '@/lib/error-handler';
import { getScanWorkerMetrics } from '@/lib/scan-worker-coordinator';
import { getSqliteContentionMetrics } from '@/lib/sqlite-write-retry';
import { getQuickPricesMetrics } from '@/lib/quick-prices-coordinator';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyPollerHealth, type PollerHealthSnapshot } from '@/lib/poller-health';
import { classifyBotConsumerHealth, summarizeMarketsProjectionHealth } from '@/lib/pipeline-health';

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

async function readFullScanHealth(): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(
      path.join(process.cwd(), 'data', 'saved-market-scanner-health.json'),
      'utf8',
    ));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function readRagnarHealth(): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(
      path.join(process.cwd(), 'data', 'ragnar-consumer-health.json'),
      'utf8',
    ));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function GET() {
  await connection();
  try {
    recovery ??= recoverInterruptedScanPublications();
    await recovery;
    const [markets, pollerSnapshot, fullScanHealth, logsDataQuality, ragnarHealth] = await Promise.all([
      getSavedMarkets(),
      readPollerHealth(),
      readFullScanHealth(),
      getLogsDataQualityHealth(),
      readRagnarHealth(),
    ]);
    const pollerStatus = classifyPollerHealth(pollerSnapshot);
    const sqliteContention = getSqliteContentionMetrics();
    const botTrader = classifyBotConsumerHealth({
      heartbeat: ragnarHealth,
      scanHealth: ragnarHealth ?? {},
    });
    const marketsProjection = summarizeMarketsProjectionHealth(markets);
    const supervisedScannerState = (fullScanHealth?.components as Record<string, unknown> | undefined)?.scanner;
    const scannerComponentState = supervisedScannerState && typeof supervisedScannerState === 'object'
      ? (supervisedScannerState as Record<string, unknown>).state
      : fullScanHealth?.state;
    const scannerComponentReason = supervisedScannerState && typeof supervisedScannerState === 'object'
      ? (supervisedScannerState as Record<string, unknown>).reason ?? null
      : fullScanHealth?.detail ?? null;
    const scannerState = scannerComponentState === 'healthy' && !pollerStatus.stale && !pollerStatus.mixedVersion
      ? 'healthy' : 'degraded';
    return NextResponse.json({
      status: 'ok',
      deployment: {
        commit: process.env.DEPLOY_COMMIT ?? null,
        buildId: process.env.H2H_BUILD_ID ?? null,
      },
      savedMarketCount: markets.length,
      scanWorkers: getScanWorkerMetrics(),
      quickPrices: getQuickPricesMetrics(),
      sqliteContention,
      fullScanHealth,
      logsDataQuality,
      components: {
        scanner: {
          state: scannerState,
          reason: pollerStatus.stale ? 'Poller heartbeat is stale' : scannerComponentReason,
        },
        persistence: {
          state: sqliteContention.exhaustedWrites > 0 ? 'degraded' : 'healthy',
          ...sqliteContention,
        },
        markets: marketsProjection,
        botTrader,
      },
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
