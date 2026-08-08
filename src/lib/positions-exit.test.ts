import { describe, expect, it, vi } from 'vitest';
import { executePositionExit, type PositionExitRequest } from './positions-exit';

const request: PositionExitRequest = {
  pairId: 'pair-1',
  kalshi: {
    ticker: 'KX-1', side: 'YES', size: 10, entryPrice: 0.4, exitPrice: 0.6,
    priceCents: 60, feesPaid: 0.1, exitFees: 0.2, title: 'Market',
  },
  polymarket: {
    asset: 'token-1', conditionId: 'condition-1', outcome: 'No', side: 'NO', size: 10,
    entryPrice: 0.6, exitPrice: 0.7, price: 0.7, feesPaid: 0.05, exitFees: 0.05, title: 'Market',
  },
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    sellKalshi: vi.fn().mockResolvedValue({ orderId: 'k1', status: 'executed', filledCount: 10 }),
    sellPolymarket: vi.fn().mockResolvedValue({ orderId: 'p1', status: 'matched', success: true }),
    persistClosedPosition: vi.fn().mockResolvedValue(undefined),
    alert: vi.fn(),
    now: () => new Date('2026-08-08T12:00:00Z'),
    ...overrides,
  };
}

describe('executePositionExit', () => {
  it('starts both closes concurrently, returns fee-net realized P&L, and writes both legs to history', async () => {
    let releaseKalshi!: () => void;
    const kalshiPending = new Promise<void>((resolve) => { releaseKalshi = resolve; });
    const sellKalshi = vi.fn(async () => {
      await kalshiPending;
      return { orderId: 'k1', status: 'executed', filledCount: 10 };
    });
    const sellPolymarket = vi.fn().mockImplementation(async () => {
      expect(sellKalshi).toHaveBeenCalledTimes(1);
      releaseKalshi();
      return { orderId: 'p1', status: 'matched', success: true };
    });
    const deps = dependencies({ sellKalshi, sellPolymarket });

    const result = await executePositionExit(request, deps);

    expect(result).toMatchObject({ success: true, partialFill: false, status: 'closed', realizedPnl: 2.6 });
    expect(deps.persistClosedPosition).toHaveBeenCalledTimes(2);
    expect(deps.persistClosedPosition).toHaveBeenCalledWith(expect.objectContaining({ platform: 'kalshi', pairId: 'pair-1', realizedPnl: 1.7 }));
    expect(deps.persistClosedPosition).toHaveBeenCalledWith(expect.objectContaining({ platform: 'polymarket', pairId: 'pair-1', realizedPnl: 0.9 }));
  });

  it('retries a failed leg and succeeds without raising a partial-close alert', async () => {
    const sellPolymarket = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({ orderId: 'p2', status: 'matched', success: true });
    const deps = dependencies({ sellPolymarket });

    const result = await executePositionExit(request, deps);

    expect(result.success).toBe(true);
    expect(sellPolymarket).toHaveBeenCalledTimes(2);
    expect(deps.alert).not.toHaveBeenCalled();
  });

  it('reports and alerts when one leg remains open after retries', async () => {
    const sellPolymarket = vi.fn().mockRejectedValue(new Error('book unavailable'));
    const deps = dependencies({ sellPolymarket });

    const result = await executePositionExit(request, deps);

    expect(result).toMatchObject({ success: false, partialFill: true, status: 'partially_closed', realizedPnl: 1.7 });
    expect(sellPolymarket).toHaveBeenCalledTimes(3);
    expect(result.errors?.polymarket).toContain('book unavailable');
    expect(deps.alert).toHaveBeenCalledWith(expect.stringContaining('partially filled'), expect.objectContaining({ pairId: 'pair-1' }));
    expect(deps.persistClosedPosition).toHaveBeenCalledTimes(1);
  });
});
