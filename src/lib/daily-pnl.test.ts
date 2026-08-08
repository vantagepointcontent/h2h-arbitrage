import { describe, expect, it } from 'vitest';
import { summarizeDailyPnl } from './daily-pnl';

describe('UI-025 daily P&L summary', () => {
  const now = new Date('2026-07-31T16:00:00.000Z'); // noon US Eastern

  it('uses the US Eastern calendar day and excludes paper executions', () => {
    const result = summarizeDailyPnl({
      now,
      executions: [
        { timestamp: '2026-07-31T13:00:00.000Z', dryRun: false, success: true, kalshiOrder: { size: 10, price: 0.4 }, polymarketOrder: { size: 8, price: 0.5 } },
        { timestamp: '2026-07-31T14:00:00.000Z', dryRun: true, success: true, kalshiOrder: { size: 999, price: 0.9 } },
        { timestamp: '2026-07-31T03:30:00.000Z', dryRun: false, success: true, kalshiOrder: { size: 5, price: 0.5 } },
      ],
      closedPositions: [
        { closedAt: '2026-07-31T15:00:00.000Z', platform: 'kalshi', realizedPnl: 6, size: 10, entryPrice: 0.4, pairId: 'pair-1' },
        { closedAt: '2026-07-31T15:10:00.000Z', platform: 'polymarket', realizedPnl: -2, size: 8, entryPrice: 0.5, pairId: 'pair-1' },
      ],
      positions: [{ breakdown: { totalNetPnl: 3.25 } }],
    });

    expect(result.realizedPnl).toBe(4);
    expect(result.unrealizedPnl).toBe(3.25);
    expect(result.totalTrades).toBe(1);
    expect(result.winRatePct).toBe(100);
    expect(result.totalVolume).toBe(18);
    expect(result.platforms.kalshi.volume).toBe(10);
    expect(result.platforms.polymarket.volume).toBe(8);
  });

  it('uses actual filled USD stake for partial fills', () => {
    const result = summarizeDailyPnl({
      now,
      executions: [{
        timestamp: '2026-07-31T13:00:00.000Z',
        dryRun: false,
        success: true,
        kalshiOrder: { size: 10, price: 0.4 },
        polymarketOrder: { size: 8, price: 0.5 },
        result: {
          kalshiResult: { status: 'partial', filledSize: 6, filledPrice: 0.4 },
          polymarketResult: { status: 'filled', filledSize: 8, filledPrice: 0.5 },
        },
      }],
      closedPositions: [],
      positions: [],
    });

    expect(result.platforms.kalshi.volume).toBe(6);
    expect(result.platforms.polymarket.volume).toBe(8);
    expect(result.totalVolume).toBe(14);
  });

  it('computes win rate per closed pair from net pair P&L', () => {
    const result = summarizeDailyPnl({
      now,
      executions: [],
      closedPositions: [
        { closedAt: '2026-07-31T15:00:00.000Z', platform: 'kalshi', realizedPnl: 6, size: 10, entryPrice: 0.4, pairId: 'winner' },
        { closedAt: '2026-07-31T15:01:00.000Z', platform: 'polymarket', realizedPnl: -2, size: 8, entryPrice: 0.5, pairId: 'winner' },
        { closedAt: '2026-07-31T15:02:00.000Z', platform: 'kalshi', realizedPnl: 1, size: 10, entryPrice: 0.4, pairId: 'loser' },
        { closedAt: '2026-07-31T15:03:00.000Z', platform: 'polymarket', realizedPnl: -3, size: 8, entryPrice: 0.5, pairId: 'loser' },
      ],
      positions: [],
    });

    expect(result.realizedPnl).toBe(2);
    expect(result.winRatePct).toBe(50);
  });

  it('returns finite zero values when there is no trading data', () => {
    expect(summarizeDailyPnl({ now, executions: [], closedPositions: [], positions: [] })).toEqual({
      date: '2026-07-31',
      timezone: 'America/New_York',
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      totalTrades: 0,
      winRatePct: 0,
      totalVolume: 0,
      platforms: {
        kalshi: { realizedPnl: 0, volume: 0 },
        polymarket: { realizedPnl: 0, volume: 0 },
      },
    });
  });
});
