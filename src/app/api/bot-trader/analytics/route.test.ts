import { describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { getBotPositionAnalytics } from '@/lib/bot-positions';

vi.mock('@/lib/bot-positions', () => ({ getBotPositionAnalytics: vi.fn() }));

describe('GET /api/bot-trader/analytics', () => {
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
    const response = await GET();
    expect(response.status).toBe(200);
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
      },
    });
  });
});
