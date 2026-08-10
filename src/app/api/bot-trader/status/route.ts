import { NextResponse } from 'next/server';
import { getSetting } from '@/lib/settings';
import { getExecutions, getTodayBotExposure } from '@/lib/persistence';
import logger from '@/lib/logger';

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
};

/**
 * GET /api/bot-trader/status
 * FEAT-040/041: live status for the BotTrader settings panel.
 * Returns current settings-derived state plus real bot-trade counters.
 */
export async function GET() {
  try {
    const [enabled, mode, selectionMethod, minRoiPct, minApyPct, minDepthUsd, minSharesPerLeg, maxExpiryDays, maxTradesPerDay] = await Promise.all([
      getSetting<boolean>('bot.enabled').catch(() => DEFAULT_BOT_SETTINGS.enabled),
      getSetting<string>('bot.mode').catch(() => DEFAULT_BOT_SETTINGS.mode),
      getSetting<string>('bot.selectionMethod').catch(() => DEFAULT_BOT_SETTINGS.selectionMethod),
      getSetting<number>('bot.minRoiPct').catch(() => DEFAULT_BOT_SETTINGS.minRoiPct),
      getSetting<number>('bot.minApyPct').catch(() => DEFAULT_BOT_SETTINGS.minApyPct),
      getSetting<number>('bot.minDepthUsd').catch(() => DEFAULT_BOT_SETTINGS.minDepthUsd),
      getSetting<number>('bot.minSharesPerLeg').catch(() => DEFAULT_BOT_SETTINGS.minSharesPerLeg),
      getSetting<number>('bot.maxExpiryDays').catch(() => DEFAULT_BOT_SETTINGS.maxExpiryDays),
      getSetting<number>('bot.maxTradesPerDay').catch(() => DEFAULT_BOT_SETTINGS.maxTradesPerDay),
    ]);

    const todayStart = new Date().toISOString().slice(0, 10);
    const todayEnd = `${todayStart}T23:59:59.999Z`;

    const [todayStakeUsd, todayTrades] = await Promise.all([
      getTodayBotExposure().catch((e) => {
        logger.warn('[bot-trader-status] getTodayBotExposure failed', { error: String(e) });
        return 0;
      }),
      getExecutions(10_000, 'bot').catch((e) => {
        logger.warn('[bot-trader-status] getExecutions failed', { error: String(e) });
        return [];
      }),
    ]);

    const today = todayTrades.filter(
      (t) => t.timestamp >= `${todayStart}T00:00:00.000Z` && t.timestamp <= todayEnd,
    );
    const todayCount2 = today.length;
    const lastTrade = todayTrades[0];

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
      todayCount: todayCount2,
      todayStakeUsd,
      lastTradeAt: lastTrade?.timestamp ?? null,
      lastTradeMarket: lastTrade?.marketTitle ?? null,
      lastTradeRoiPct: lastTrade?.result && typeof lastTrade.result === 'object' && 'actualProfit' in lastTrade.result
        ? Number((lastTrade.result as { actualProfit?: unknown }).actualProfit ?? null)
        : null,
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
