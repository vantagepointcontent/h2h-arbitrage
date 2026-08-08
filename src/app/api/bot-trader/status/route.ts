import { NextResponse } from 'next/server';
import { getSetting } from '@/lib/settings';
import { getExecutions, getTodayBotExposure } from '@/lib/persistence';
import logger from '@/lib/logger';

const DEFAULT_STATUS = {
  enabled: false,
  mode: 'paper' as const,
  todayCount: 0,
  todayStakeUsd: 0,
  lastTradeAt: null,
  lastTradeMarket: null,
};

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

/** GET /api/bot-trader/status — settings-derived state plus UTC-day bot counters. */
export async function GET() {
  try {
    const [enabled, mode, todayStakeUsd, botTrades] = await Promise.all([
      getSetting<boolean>('bot.enabled').catch(() => false),
      getSetting<string>('bot.mode').catch(() => 'paper'),
      getTodayBotExposure().catch((error) => {
        logger.warn('[bot-trader-status] exposure unavailable', { error: String(error) });
        return 0;
      }),
      getExecutions(10_000, 'bot').catch((error) => {
        logger.warn('[bot-trader-status] executions unavailable', { error: String(error) });
        return [];
      }),
    ]);

    const utcDate = new Date().toISOString().slice(0, 10);
    const todayPrefix = `${utcDate}T`;
    const todayCount = botTrades.filter((trade) => trade.timestamp.startsWith(todayPrefix)).length;
    const lastTrade = botTrades[0];

    return NextResponse.json({
      enabled,
      mode: mode === 'production' ? 'production' : 'paper',
      todayCount,
      todayStakeUsd,
      lastTradeAt: lastTrade?.timestamp ?? null,
      lastTradeMarket: lastTrade?.marketTitle ?? null,
    }, { headers: NO_CACHE });
  } catch (error) {
    logger.error('[bot-trader-status-error]', error);
    return NextResponse.json({
      ...DEFAULT_STATUS,
      error: error instanceof Error ? error.message : 'BotTrader status unavailable',
    }, { status: 500, headers: NO_CACHE });
  }
}
