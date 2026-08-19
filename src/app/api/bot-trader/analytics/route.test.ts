import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { getBotPositionAnalytics, summarizeBotPerformance } from '@/lib/bot-positions';
import { NextRequest } from 'next/server';
import { getMarketUrlsById } from '@/lib/persistence';
import { getPersistedCurrentPriceBatch } from '@/lib/current-price-snapshots';
import { enrichBotPositionsWithSettlementLedger } from '@/lib/bot-settlement-store';

vi.mock('@/lib/bot-positions', () => ({ getBotPositionAnalytics: vi.fn(), summarizeBotPerformance: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ getMarketUrlsById: vi.fn() }));
vi.mock('@/lib/current-price-snapshots', () => ({
  getPersistedCurrentPriceBatch: vi.fn(),
  currentPriceSnapshotKey: (request: { platform: string; marketId: string | null; side: string; tokenId: string | null }) =>
    `${request.platform}|${request.marketId?.toLowerCase() ?? ''}|${request.side}|${request.tokenId?.toLowerCase() ?? ''}`,
}));
vi.mock('@/lib/bot-settlement-store', () => ({
  enrichBotPositionsWithSettlementLedger: vi.fn(async (positions: unknown[]) => positions),
}));

describe('GET /api/bot-trader/analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMarketUrlsById).mockResolvedValue(null);
    vi.mocked(getPersistedCurrentPriceBatch).mockResolvedValue(new Map());
    vi.mocked(enrichBotPositionsWithSettlementLedger).mockImplementation(async (positions) => positions as never);
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
      kalshi: expect.objectContaining({ status: 'available', priceCents: 47, identity: { platform: 'kalshi', marketId: 'KX-1', side: 'yes', tokenId: null } }),
      polymarket: expect.objectContaining({ status: 'stale', priceCents: 53, identity: { platform: 'polymarket', marketId: '0x1', side: 'no', tokenId: 'token-no' } }),
    });
    expect(body.analytics.positions[2].currentPriceSnapshots).toEqual({
      kalshi: expect.objectContaining({ status: 'missing_identifier', priceCents: null }),
      polymarket: expect.objectContaining({ status: 'missing_identifier', priceCents: null }),
    });
  });

  it('never reconstructs an immutable held token from a later exit-fee token', async () => {
    vi.mocked(getBotPositionAnalytics).mockResolvedValue({ positions: [{
      id: 180, marketId: 'ny21', kalshiTicker: 'KX-NY21-R', kalshiSide: 'yes',
      pmConditionId: '0xdemocratic-question', pmEntryTokenId: null,
      pmExitTokenId: 'later-democratic-no-token', pmSide: 'no', status: 'open',
      outcomeIdentityStatus: 'verified', kalshiOutcomeLabel: 'Republicans', pmOutcomeLabel: 'Republicans',
      remainingSharesKalshi: 1, remainingSharesPm: 1, entryCostStatus: 'available', totalCostCents: 97,
    }] } as never);

    const response = await GET(new NextRequest('http://localhost/api/bot-trader/analytics'));
    expect(response.status).toBe(200);
    expect(getPersistedCurrentPriceBatch).toHaveBeenCalledWith(expect.arrayContaining([
      { platform: 'polymarket', marketId: '0xdemocratic-question', side: 'no', tokenId: null },
    ]));
    expect(getPersistedCurrentPriceBatch).not.toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ tokenId: 'later-democratic-no-token' }),
    ]));
    const body = await response.json();
    expect(body.analytics.positions[0]).toMatchObject({
      currentValueCents: null,
      unrealizedPnlCents: null,
      unrealizedRoiBps: null,
      valuationStatus: 'unavailable',
    });
  });

  it('derives independent one-share current value from exact persisted scan marks', async () => {
    vi.mocked(getBotPositionAnalytics).mockResolvedValue({
      positions: [{
        id: 9, marketId: 'm9', kalshiTicker: 'KX-9', kalshiSide: 'no',
        pmConditionId: '0x9', pmEntryTokenId: 'token-yes', pmExitTokenId: 'token-yes', pmSide: 'yes',
        outcomeIdentityStatus: 'verified', kalshiOutcomeLabel: 'Outcome A', pmOutcomeLabel: 'Outcome B',
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

  it('values exact-token unresolved exposure while excluding it from verified-arbitrage totals', async () => {
    vi.mocked(getBotPositionAnalytics).mockResolvedValue({ positions: [{
      id: 181, marketId: 'm181', kalshiTicker: 'KX-NY21-R', kalshiSide: 'yes',
      pmConditionId: '0xdemocratic-question', pmEntryTokenId: 'democratic-no-token', pmSide: 'no',
      outcomeIdentityStatus: 'unresolved', outcomeIdentityFailureReason: 'Execution-time selected outcome was not persisted',
      relationshipValidity: 'unresolved_relationship', exposureIdentityStatus: 'exact_held_legs_proven',
      remainingSharesKalshi: 1, remainingSharesPm: 1, status: 'open', entryCostStatus: 'available',
      totalCostCents: 97, totalCostMicrousd: 970_000, currentValueCents: null, unrealizedPnlCents: null,
    }] } as never);
    vi.mocked(getPersistedCurrentPriceBatch).mockResolvedValue(new Map([
      ['kalshi|kx-ny21-r|yes|', { status: 'available', priceCents: 70, source: 'saved-market-full-scan', observedAt: '2026-08-19T12:00:00Z', ageMs: 0 }],
      ['polymarket|0xdemocratic-question|no|democratic-no-token', { status: 'available', priceCents: 29, source: 'saved-market-full-scan', observedAt: '2026-08-19T12:00:00Z', ageMs: 0 }],
    ]));

    const body = await (await GET(new NextRequest('http://localhost/api/bot-trader/analytics'))).json();
    expect(body.analytics.positions[0]).toMatchObject({
      currentValueCents: 99,
      unrealizedPnlCents: 2,
      unrealizedRoiBps: 206,
      valuationStatus: 'current',
      valuationFailureReason: null,
      exposureValuationLabel: 'Invalid/unverified exposure',
      excludedFromVerifiedTotals: true,
    });
  });

  it('uses stale low-depth indicative snapshots and full stored precision for P&L and ROI', async () => {
    vi.mocked(getBotPositionAnalytics).mockResolvedValue({
      positions: [{
        id: 10, marketId: 'm10', kalshiTicker: 'KX-10', kalshiSide: 'yes',
        pmConditionId: '0x10', pmEntryTokenId: 'token-no', pmSide: 'no',
        outcomeIdentityStatus: 'verified', kalshiOutcomeLabel: 'Outcome A', pmOutcomeLabel: 'Outcome B',
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
