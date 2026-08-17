import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { getBotPositionAnalytics, summarizeBotPerformance } from '@/lib/bot-positions';
import { NextRequest } from 'next/server';
import { getMarketUrlsById, getSavedMarketById } from '@/lib/persistence';
import { getPersistedCurrentPriceBatch } from '@/lib/current-price-snapshots';

vi.mock('@/lib/bot-positions', () => ({ getBotPositionAnalytics: vi.fn(), summarizeBotPerformance: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ getMarketUrlsById: vi.fn(), getSavedMarketById: vi.fn() }));
vi.mock('@/lib/current-price-snapshots', () => ({
  getPersistedCurrentPriceBatch: vi.fn(),
  currentPriceSnapshotKey: (request: { platform: string; marketId: string | null; side: string; tokenId: string | null }) =>
    `${request.platform}|${request.marketId?.toLowerCase() ?? ''}|${request.side}|${request.tokenId?.toLowerCase() ?? ''}`,
}));

describe('GET /api/bot-trader/analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMarketUrlsById).mockResolvedValue(null);
    vi.mocked(getSavedMarketById).mockResolvedValue(null);
    vi.mocked(getPersistedCurrentPriceBatch).mockResolvedValue(new Map());
    vi.mocked(summarizeBotPerformance).mockImplementation(() => ({
      capital: { currentCents: 99 }, pnl: { unrealizedCents: null },
    }) as never);
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
      expect.objectContaining({ id: 1, marketId: 'market-1', kalshiUrl: 'https://kalshi.test/market', polymarketUrl: 'https://pm.test/event' }),
      expect.objectContaining({ id: 2, marketId: 'market-1', kalshiUrl: 'https://kalshi.test/market', polymarketUrl: 'https://pm.test/event' }),
    ]);
  });

  it('enriches legacy positions with exact persisted outcome identities and backend relationship state', async () => {
    vi.mocked(getBotPositionAnalytics).mockResolvedValue({ positions: [{
      id: 97, executionId: 128, marketId: 'fl-26', marketTitle: 'FL-26 House Election Winner',
      kalshiTicker: 'KX-FL-D', pmConditionId: '0xdem', pmEntryTokenId: 'token-dem-yes',
      kalshiSide: 'yes', pmSide: 'yes', status: 'open',
    }] } as never);
    vi.mocked(getSavedMarketById).mockResolvedValue({
      id: 'fl-26', eventTitle: 'FL-26 House Election Winner', kalshiUrl: '', polymarketUrl: '', createdAt: '',
      lastScanResult: {
        matchedPairs: [
          { artist: 'Democrats', kalshiTicker: 'KX-FL-D', pmConditionId: '0xdem' },
          { artist: 'Republicans', kalshiTicker: 'KX-FL-R', pmConditionId: '0xrep' },
        ],
      },
    } as never);

    const response = await GET(new NextRequest('http://localhost/api/bot-trader/analytics'));
    const body = await response.json();

    expect(body.analytics.positions[0]).toMatchObject({
      identity: {
        kalshi: { marketQuestion: null, outcomeLabel: 'Democrats', side: 'yes' },
        polymarket: { marketQuestion: null, outcomeLabel: 'Democrats', side: 'yes' },
        relationship: { state: 'same_direction' },
      },
    });
  });

  it('deduplicates exact legs into one persisted snapshot batch and isolates missing identifiers', async () => {
    vi.mocked(getBotPositionAnalytics).mockResolvedValue({ positions: [
      { id: 1, marketId: 'm1', kalshiTicker: 'KX-1', kalshiSide: 'yes', pmConditionId: '0x1', pmEntryTokenId: 'token-no', pmSide: 'no' },
      { id: 2, marketId: 'm1', kalshiTicker: 'KX-1', kalshiSide: 'yes', pmConditionId: '0x1', pmEntryTokenId: 'token-no', pmSide: 'no' },
      { id: 3, marketId: null, kalshiTicker: null, kalshiSide: 'no', pmConditionId: null, pmEntryTokenId: null, pmSide: 'yes' },
    ] } as never);
    vi.mocked(getPersistedCurrentPriceBatch).mockResolvedValue(new Map([
      ['kalshi|kx-1|yes|', { status: 'available', priceCents: 47, source: 'saved-market-full-scan', observedAt: '2026-08-14T12:00:00.000Z', ageMs: 1000 }],
      ['polymarket|0x1|no|token-no', { status: 'stale', priceCents: 53, source: 'saved-market-full-scan', observedAt: '2026-08-14T11:00:00.000Z', ageMs: 3_601_000 }],
    ]));

    const response = await GET(new NextRequest('http://localhost/api/bot-trader/analytics'));
    const body = await response.json();

    expect(getPersistedCurrentPriceBatch).toHaveBeenCalledTimes(1);
    expect(getPersistedCurrentPriceBatch).toHaveBeenCalledWith([
      { platform: 'kalshi', marketId: 'KX-1', side: 'yes', tokenId: null },
      { platform: 'polymarket', marketId: '0x1', side: 'no', tokenId: 'token-no' },
      { platform: 'kalshi', marketId: null, side: 'no', tokenId: null },
      { platform: 'polymarket', marketId: null, side: 'yes', tokenId: null },
    ]);
    expect(body.analytics.positions[0].currentPriceSnapshots).toEqual({
      kalshi: expect.objectContaining({ status: 'available', priceCents: 47 }),
      polymarket: expect.objectContaining({ status: 'stale', priceCents: 53 }),
    });
    expect(body.analytics.positions[2].currentPriceSnapshots).toEqual({
      kalshi: expect.objectContaining({ status: 'missing_identifier', priceCents: null }),
      polymarket: expect.objectContaining({ status: 'missing_identifier', priceCents: null }),
    });
  });

  it('derives independent one-share current value from exact persisted scan marks', async () => {
    vi.mocked(getBotPositionAnalytics).mockResolvedValue({
      positions: [{
        id: 9, marketId: 'm9', kalshiTicker: 'KX-9', kalshiSide: 'no',
        pmConditionId: '0x9', pmEntryTokenId: 'token-yes', pmExitTokenId: 'token-yes', pmSide: 'yes',
        remainingSharesKalshi: 1, remainingSharesPm: 1, remainingOpenCostCents: 95,
        status: 'open', entryCostStatus: 'unavailable', currentValueCents: null, unrealizedPnlCents: null,
      }],
      performance: { valuation: { fresh: 0, stale: 0, unavailable: 1 } },
      openPositions: { count: 1, unrealizedPnlCents: null },
      averageRoi: { atTradeBps: 500, currentBps: null },
    } as never);
    vi.mocked(getPersistedCurrentPriceBatch).mockResolvedValue(new Map([
      ['kalshi|kx-9|no|', {
        status: 'available', priceCents: 45, executableDepthMicros: 1_000_000,
        source: 'saved-market-full-scan', observedAt: '2026-08-14T12:00:00.000Z', ageMs: 1_000, failureReason: null,
      }],
      ['polymarket|0x9|yes|token-yes', {
        status: 'available', priceCents: 54, executableDepthMicros: 2_000_000,
        source: 'saved-market-quick-refresh', observedAt: '2026-08-14T12:00:01.000Z', ageMs: 0, failureReason: null,
      }],
    ]));

    const response = await GET(new NextRequest('http://localhost/api/bot-trader/analytics'));
    const body = await response.json();
    expect(body.analytics.positions[0]).toMatchObject({
      currentPriceKalshiCents: 45,
      currentPricePmCents: 54,
      currentValueCents: 99,

      lastValuationAt: '2026-08-14T12:00:00.000Z',
      valuationStatus: 'current',
      valuationFailureReason: null,
      unrealizedPnlCents: null,
      unrealizedRoiBps: null,
    });
    expect(summarizeBotPerformance).toHaveBeenCalledWith([
      expect.objectContaining({ id: 9, currentValueCents: 99, unrealizedPnlCents: null }),
    ], expect.any(Date));
    expect(body.analytics.performance).toEqual({ capital: { currentCents: 99 }, pnl: { unrealizedCents: null } });
  });

  it('uses stale low-depth indicative snapshots and full stored precision for P&L and ROI', async () => {
    vi.mocked(getBotPositionAnalytics).mockResolvedValue({
      positions: [{
        id: 10, marketId: 'm10', kalshiTicker: 'KX-10', kalshiSide: 'yes',
        pmConditionId: '0x10', pmEntryTokenId: 'token-no', pmSide: 'no',
        remainingSharesKalshi: 1, remainingSharesPm: 1, remainingOpenCostCents: 97,
        totalCostCents: 97, totalCostMicrousd: 970_000,
        status: 'open', entryCostStatus: 'available', currentValueCents: null,
        unrealizedPnlCents: null, realizedPnlCents: null,
      }],
      performance: { valuation: { fresh: 0, stale: 0, unavailable: 1 } },
      openPositions: { count: 1, unrealizedPnlCents: null },
      averageRoi: { atTradeBps: 500, currentBps: null },
    } as never);
    vi.mocked(getPersistedCurrentPriceBatch).mockResolvedValue(new Map([
      ['kalshi|kx-10|yes|', {
        status: 'stale', priceCents: 46, priceMicrocents: 45_500_100,
        executableDepthMicros: 0, source: 'saved-market-full-scan',
        observedAt: '2026-08-17T10:00:00.000Z', ageMs: 7_200_000,
        failureReason: 'Kalshi YES executable bid unavailable',
      }],
      ['polymarket|0x10|no|token-no', {
        status: 'stale', priceCents: 54, priceMicrocents: 54_449_900,
        executableDepthMicros: 250_000, source: 'saved-market-full-scan',
        observedAt: '2026-08-17T10:01:00.000Z', ageMs: 7_140_000,
        failureReason: 'Polymarket NO executable depth 0.25 is below one share',
      }],
    ]));

    const response = await GET(new NextRequest('http://localhost/api/bot-trader/analytics'));
    const body = await response.json();
    expect(body.analytics.positions[0]).toMatchObject({
      currentValueCents: 100,
      indicativeValueMicrocents: 99_950_000,
      unrealizedPnlCents: 3,
      indicativePnlMicrocents: 2_950_000,
      unrealizedRoiBps: 304,
      valuationStatus: 'stale',
      lastValuationAt: '2026-08-17T10:00:00.000Z',
    });
    expect(body.analytics.positions[0].valuationFailureReason).toContain('Stale');
    expect(body.analytics.positions[0].valuationFailureReason).not.toContain('depth');
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
