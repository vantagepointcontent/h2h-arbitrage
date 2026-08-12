import { describe, expect, it } from 'vitest';
import { closedPositionRow, escapeTradeCsv, executionRows } from './trade-export';

describe('trade export', () => {
  it('emits one row per live execution leg and excludes paper trades', () => {
    const base = {
      timestamp: '2026-08-08T10:00:00.000Z', arbId: 'arb-1', marketTitle: 'Event, winner',
      success: true, strategy: null, estimatedProfit: 2, source: 'manual' as const,
      kalshiOrder: { ticker: 'K-1', outcome: 'yes', size: 10, price: 0.4 },
      polymarketOrder: { conditionId: 'P-1', outcome: 'no', size: 10, price: 0.5 },
      result: { kalshiResult: { status: 'filled', filledSize: 9, filledPrice: 0.41, fee: 0.12 } },
    };
    expect(executionRows({ ...base, dryRun: true })).toEqual([]);
    const rows = executionRows({ ...base, dryRun: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(['2026-08-08T10:00:00.000Z', 'Kalshi', 'Event, winner', 'K-1', 'YES', 9, 0.41, 0.12, '', 'arb-1', 'filled', 'Manual']);
    expect(executionRows({ ...base, dryRun: false, source: 'bot', selectionMethod: 'apy' })[0]?.at(-1)).toBe('apy');
    expect(executionRows({ ...base, dryRun: false, source: 'bot', selectionMethod: null })[0]?.at(-1)).toBe('Legacy/Unknown');
  });

  it('does not export requested order values as fills for an unverified live acknowledgement', () => {
    expect(executionRows({
      timestamp: '2026-08-08T10:00:00.000Z', arbId: 'arb-pending', marketTitle: 'Pending',
      dryRun: false, success: false, estimatedProfit: 2,
      kalshiOrder: { ticker: 'K-1', outcome: 'yes', size: 10, price: 0.4 },
      polymarketOrder: { conditionId: 'P-1', outcome: 'no', size: 10, price: 0.5 },
      result: {
        kalshiResult: { status: 'pending', orderId: 'k-1' },
        polymarketResult: { status: 'pending', orderId: 'pm-1' },
      },
    })).toEqual([]);
  });

  it('exports closed P&L and protects spreadsheet cells', () => {
    expect(closedPositionRow({
      marketTitle: '=SUM(A1:A2)', platform: 'polymarket', side: 'NO', size: 5,
      entryPrice: 0.4, exitPrice: 0.6, realizedPnl: 0.9, roiPct: 45,
      closedAt: '2026-08-08T11:00:00Z', feesPaid: 0.1, pairId: 'arb-2',
    })[10]).toBe('closed');
    expect(escapeTradeCsv('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(escapeTradeCsv('Event, winner')).toBe('"Event, winner"');
    expect(escapeTradeCsv(0.41)).toBe('0.41');
  });
});
