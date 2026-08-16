import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getSetting } from '@/lib/settings';
import { getExecutions, getTodayBotExposure } from '@/lib/persistence';
import logger from '@/lib/logger';
import { getBotScanDecisions, getBotScanHealth } from '@/lib/bot-scan-consumer';
import { getCredentialStatus } from '@/lib/execution-creds';
import { getBotExecutionReadiness, type BotSettings } from '@/lib/bot-trader';

const DEFAULT_BOT_SETTINGS = {
  enabled: false,
  mode: 'paper',
  selectionMethod: 'hybrid',
  minRoiPct: 2.0,
  minApyPct: 0,
  minDepthUsd: 0.5,
  minSharesPerLeg: 1,
  maxExpiryDays: 365,
  maxTradesPerDay: 10,
  maxUnitsPerMarket: 3,
};

async function readConsumerHeartbeat(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path.join(process.cwd(), 'data', 'ragnar-consumer-health.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * GET /api/bot-trader/status
 * FEAT-040/041: live status for the BotTrader settings panel.
 * Returns current settings-derived state plus real bot-trade counters.
 */
export async function GET() {
  try {
    const [enabled, mode, selectionMethod, minRoiPct, minApyPct, minDepthUsd, minSharesPerLeg, maxExpiryDays, maxTradesPerDay, maxUnitsPerMarket] = await Promise.all([
      getSetting<boolean>('bot.enabled').catch(() => DEFAULT_BOT_SETTINGS.enabled),
      getSetting<string>('bot.mode').catch(() => DEFAULT_BOT_SETTINGS.mode),
      getSetting<string>('bot.selectionMethod').catch(() => DEFAULT_BOT_SETTINGS.selectionMethod),
      getSetting<number>('bot.minRoiPct').catch(() => DEFAULT_BOT_SETTINGS.minRoiPct),
      getSetting<number>('bot.minApyPct').catch(() => DEFAULT_BOT_SETTINGS.minApyPct),
      getSetting<number>('bot.minDepthUsd').catch(() => DEFAULT_BOT_SETTINGS.minDepthUsd),
      getSetting<number>('bot.minSharesPerLeg').catch(() => DEFAULT_BOT_SETTINGS.minSharesPerLeg),
      getSetting<number>('bot.maxExpiryDays').catch(() => DEFAULT_BOT_SETTINGS.maxExpiryDays),
      getSetting<number>('bot.maxTradesPerDay').catch(() => DEFAULT_BOT_SETTINGS.maxTradesPerDay),
      getSetting<number>('bot.maxUnitsPerMarket').catch(() => DEFAULT_BOT_SETTINGS.maxUnitsPerMarket),
    ]);

    const todayStart = new Date().toISOString().slice(0, 10);
    const todayEnd = `${todayStart}T23:59:59.999Z`;

    const [todayStakeUsd, todayTrades, recentDecisions, scanHealth, credentials, consumerHeartbeat] = await Promise.all([
      getTodayBotExposure().catch((e) => {
        logger.warn('[bot-trader-status] getTodayBotExposure failed', { error: String(e) });
        return 0;
      }),
      getExecutions(10_000, 'bot').catch((e) => {
        logger.warn('[bot-trader-status] getExecutions failed', { error: String(e) });
        return [];
      }),
      getBotScanDecisions(100).catch((e) => {
        logger.warn('[bot-trader-status] getBotScanDecisions failed', { error: String(e) });
        return [];
      }),
      getBotScanHealth(),
      getCredentialStatus(),
      readConsumerHeartbeat(),
    ]);

    const today = todayTrades.filter(
      (t) => t.timestamp >= `${todayStart}T00:00:00.000Z` && t.timestamp <= todayEnd,
    );
    const todayCount2 = today.length;
    const lastTrade = todayTrades[0];
    const activeSettings: BotSettings = {
      enabled,
      mode: mode === 'production' ? 'production' : 'paper',
      selectionMethod: selectionMethod === 'roi' || selectionMethod === 'apy' ? selectionMethod : 'hybrid',
      minRoiPct,
      minApyPct,
      minDepthUsd,
      minSharesPerLeg,
      maxExpiryDays,
      maxTradesPerDay,
    };
    const readiness = await getBotExecutionReadiness(activeSettings);
    const effectiveExecutionMode = readiness.effectiveMode;
    const heartbeatAt = typeof consumerHeartbeat?.lastSuccessAt === 'string' ? consumerHeartbeat.lastSuccessAt : null;
    const heartbeatAgeMs = heartbeatAt == null ? null : Math.max(0, Date.now() - Date.parse(heartbeatAt));
    const degradedReasons = [
      ...(!enabled ? ['BotTrader is disabled'] : []),
      ...(heartbeatAgeMs == null || heartbeatAgeMs > 30_000 ? ['Ragnar consumer heartbeat is stale or missing'] : []),
      ...(scanHealth.pendingScans > 0 ? [`${scanHealth.pendingScans} persisted scan(s) await a durable decision`] : []),
      ...(mode === 'production' ? readiness.blockedReasons : []),
    ];
    const liveUnavailableReasons = [
      ...readiness.blockedReasons,
    ];

    const status = {
      enabled,
      mode,
      selectionMethod,
      minRoiPct,
      minApyPct,
      minDepthUsd,
      minSharesPerLeg,
      maxExpiryDays,
      maxTradesPerDay,
      maxUnitsPerMarket,
      todayCount: todayCount2,
      todayStakeUsd,
      lastTradeAt: lastTrade?.timestamp ?? null,
      lastTradeMarket: lastTrade?.marketTitle ?? null,
      lastTradeRoiPct: lastTrade?.result && typeof lastTrade.result === 'object' && 'actualProfit' in lastTrade.result
        ? Number((lastTrade.result as { actualProfit?: unknown }).actualProfit ?? null)
        : null,
      scanDecisions: {
        count: recentDecisions.length,
        latest: recentDecisions[0] ?? null,
        byState: Object.fromEntries([...new Set(recentDecisions.map((decision) => decision.state))]
          .map((state) => [state, recentDecisions.filter((decision) => decision.state === state).length])),
      },
      workflow: {
        health: degradedReasons.length === 0 ? 'healthy' : 'degraded',
        degradedReasons,
        liveUnavailableReasons,
        effectiveExecutionMode,
        requestedExecutionMode: mode,
        liveAuthorizationConfigured: readiness.authorizationConfigured,
        credentialsReady: credentials.allReady,
        latestCompletedScanId: scanHealth.latestCompletedScanId,
        latestCompletedScanAt: scanHealth.latestCompletedScanAt,
        latestPositiveScanId: scanHealth.latestPositiveScanId,
        latestPositiveScanAt: scanHealth.latestPositiveScanAt,
        cursorScanId: scanHealth.cursorScanId,
        cursorUpdatedAt: scanHealth.cursorUpdatedAt,
        latestDecisionScanId: scanHealth.latestDecisionScanId,
        latestDecisionAt: scanHealth.latestDecisionAt,
        pendingScans: scanHealth.pendingScans,
        cursorLag: scanHealth.cursorLag,
        opportunitiesEvaluated: scanHealth.opportunitiesEvaluated,
        eligibleCount: scanHealth.eligibleCount,
        lastExecutionOrSkip: scanHealth.lastExecutionOrSkip,
        inProgress: scanHealth.inProgress,
        consumer: {
          state: consumerHeartbeat?.state ?? 'missing',
          lastSuccessAt: heartbeatAt,
          ageMs: heartbeatAgeMs,
          processed: consumerHeartbeat?.processed ?? null,
          error: consumerHeartbeat?.error ?? null,
        },
      },
      error: null,
    };

    return NextResponse.json(status, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      },
    });
  } catch (err: unknown) {
    logger.error('[bot-trader-status-error]', err);
    return NextResponse.json(
      {
        enabled: false,
        mode: 'paper',
        selectionMethod: DEFAULT_BOT_SETTINGS.selectionMethod,
        minRoiPct: DEFAULT_BOT_SETTINGS.minRoiPct,
        minApyPct: DEFAULT_BOT_SETTINGS.minApyPct,
        minDepthUsd: DEFAULT_BOT_SETTINGS.minDepthUsd,
        minSharesPerLeg: DEFAULT_BOT_SETTINGS.minSharesPerLeg,
        maxExpiryDays: DEFAULT_BOT_SETTINGS.maxExpiryDays,
        maxTradesPerDay: DEFAULT_BOT_SETTINGS.maxTradesPerDay,
        maxUnitsPerMarket: DEFAULT_BOT_SETTINGS.maxUnitsPerMarket,
        todayCount: 0,
        todayStakeUsd: 0,
        lastTradeAt: null,
        lastTradeMarket: null,
        lastTradeRoiPct: null,
        error: err instanceof Error ? err.message : String(err),
      },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        },
      },
    );
  }
}
