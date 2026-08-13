import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { getBotPositionAnalytics } from '@/lib/bot-positions';
import { NextRequest } from 'next/server';
import { getMarketUrlsById } from '@/lib/persistence';

vi.mock('@/lib/bot-positions', () => ({ getBotPositionAnalytics: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ getMarketUrlsById: vi.fn() }));

describe('GET /api/bot-trader/analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMarketUrlsById).mockResolvedValue(null);
  });
  it('returns aggregated bot position analytics without caching', async () => {
    vi.mocked(getBotPositionAnalytics).mockResolvedValue({
      totalBotTrades: { paper: 2, production: 1, total: 3 },
      openPositions: { count: 2, unrealizedPnlCents: 500 },
      settledPositions: { count: 1, realizedPnlCents: 300, winRateBps: 10_000 },
      averageRoi: { atTradeBps: 500, currentBps: 600 },
      bestTrade: null,
      worstTrade: null,
      dailyPnl: [],
      timeStats: { tradesPerDayBps: 0, averageHoldSeconds: 0 },
    } as never);
    const response = await GET(new NextRequest('http://localhost/api/bot-trader/analytics?method=roi&mode=paper&range=7d'));
    expect(response.status).toBe(200);
    expect(getBotPositionAnalytics).toHaveBeenCalledWith({ method: 'roi', mode: 'paper', range: '7d' });
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(response.json()).resolves.toEqual({
      success: true,
      analytics: {
        totalBotTrades: { paper: 2, production: 1, total: 3 },
        openPositions: { count: 2, unrealizedPnlCents: 500 },
        settledPositions: { count: 1, realizedPnlCents: 300, winRateBps: 10_000 },
        averageRoi: { atTradeBps: 500, currentBps: 600 },
        bestTrade: null,
        worstTrade: null,
        dailyPnl: [],
        timeStats: { tradesPerDayBps: 0, averageHoldSeconds: 0 },
        positions: [],
      },
    });
  });

  it('rejects invalid method or mode filters', async () => {
    const response = await GET(new NextRequest('http://localhost/api/bot-trader/analytics?method=guessed&mode=mixed'));
    expect(response.status).toBe(400);
    expect(getBotPositionAnalytics).not.toHaveBeenCalled();
  });

  it('rejects invalid dashboard range filters', async () => {
    const response = await GET(new NextRequest('http://localhost/api/bot-trader/analytics?range=forever'));
    expect(response.status).toBe(400);
    expect(getBotPositionAnalytics).not.toHaveBeenCalled();
  });

  it('enriches identifier-present analytics positions with persisted venue links', async () => {
    vi.mocked(getBotPositionAnalytics).mockResolvedValue({
      positions: [{ id: 1, marketId: 'market-1' }, { id: 2, marketId: 'market-1' }],
    } as never);
    vi.mocked(getMarketUrlsById).mockResolvedValue({ kalshiUrl: 'https://kalshi.test/market', polymarketUrl: 'https://pm.test/event' });
    const response = await GET(new NextRequest('http://localhost/api/bot-trader/analytics'));
    const body = await response.json();
    expect(getMarketUrlsById).toHaveBeenCalledTimes(1);
    expect(body.analytics.positions).toEqual([
      { id: 1, marketId: 'market-1', kalshiUrl: 'https://kalshi.test/market', polymarketUrl: 'https://pm.test/event' },
      { id: 2, marketId: 'market-1', kalshiUrl: 'https://kalshi.test/market', polymarketUrl: 'https://pm.test/event' },
    ]);
  });

  it('returns an actionable retry message when the analytics store is unavailable', async () => {
    vi.mocked(getBotPositionAnalytics).mockRejectedValue(new Error('database unavailable'));

    const response = await GET(new NextRequest('http://localhost/api/bot-trader/analytics'));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/^BotTrader analytics are temporarily unavailable\. Retry in a moment \(Error, ref: [a-f0-9]{16}\)$/);
  });
});
