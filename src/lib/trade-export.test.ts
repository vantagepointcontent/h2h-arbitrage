import { describe, expect, it } from 'vitest';
import { closedPositionRow, escapeTradeCsv, executionRows } from './trade-export';

describe('trade export', () => {
  it('emits one row per live execution leg and excludes paper trades', () => {
    const base = {
      timestamp: '2026-08-08T10:00:00.000Z', arbId: 'arb-1', marketTitle: 'Event, winner',
      success: true, strategy: null, estimatedProfit: 2, source: 'manual' as const,
      kalshiOrder: { ticker: 'K-1', outcome: 'yes', size: 10, price: 0.4 },
      polymarketOrder: { conditionId: 'P-1', outcome: 'no', size: 10, price: 0.5 },
      result: { kalshiResult: {
        status: 'filled', filledSize: 9, filledPrice: 0.41, fee: 0.12,
        orderId: 'k-fill-1', timestamp: '2026-08-08T10:00:01.000Z', evidenceSource: 'venue',
      } },
    };
    expect(executionRows({ ...base, dryRun: true })).toEqual([]);
    const rows = executionRows({ ...base, dryRun: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(['2026-08-08T10:00:01.000Z', 'Kalshi', 'Event, winner', 'K-1', 'YES', 9, 0.41, 0.12, '', 'arb-1', 'filled', 'Manual', '', '', '', '', '']);
    expect(executionRows({ ...base, dryRun: false, source: 'bot', selectionMethod: 'apy' })[0]?.[11]).toBe('apy');
    expect(executionRows({ ...base, dryRun: false, source: 'bot', selectionMethod: null })[0]?.[11]).toBe('Legacy/Unknown');
  });

  it('exports authoritative Kalshi calculated and charged fee provenance', () => {
    const execution = {
      timestamp: '2026-08-08T10:00:00.000Z', arbId: 'arb-fee', marketTitle: 'Fee market',
      dryRun: false, success: true, estimatedProfit: 1,
      kalshiOrder: { ticker: 'K-1', outcome: 'yes', size: 1, price: 0.4 },
      result: {
        kalshiResult: { status: 'filled', filledSize: 1, filledPrice: 0.4, fees: 0.01,
          orderId: 'k-1', timestamp: '2026-08-08T10:00:01.000Z', evidenceSource: 'venue' },
        kalshiFeeQuote: { source: 'kalshi-series:KX', observedAt: '2026-08-08T10:00:00.000Z',
          version: 'quadratic:1000000:v1', calculatedFeeCents: 2, chargedFeeCents: 1 },
      },
    };
    expect(executionRows(execution as never)[0]?.slice(-5)).toEqual([
      'kalshi-series:KX', '2026-08-08T10:00:00.000Z', 'quadratic:1000000:v1', 2, 1,
    ]);
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

  it('preserves the observed Polymarket five-decimal fee in execution exports', () => {
    const rows = executionRows({
      timestamp: '2026-08-08T10:00:00.000Z', arbId: 'arb-pm-fee', marketTitle: 'Politics',
      dryRun: false, success: true, estimatedProfit: 1,
      polymarketOrder: { conditionId: '0xpolitics', outcome: 'yes', size: 1, price: 0.7 },
      result: { polymarketResult: {
        platform: 'polymarket', status: 'filled', filledContracts: 1, filledPrice: 0.7,
        chargedFeeCents: 1, chargedFeeMicrousd: 8_400,
        executionId: 'pm-fill-1', venueTimestamp: '2026-08-08T10:00:01.000Z',
        orderId: 'pm-order-1', timestamp: '2026-08-08T10:00:01.000Z',
        venueEvidence: {
          venue: 'polymarket', filledQuantity: 1, fillPrice: 0.7,
          chargedFeeCents: 1, chargedFeeMicrousd: 8_400,
          executionId: 'pm-fill-1', venueTimestamp: '2026-08-08T10:00:01.000Z',
        },
      } },
    });

    expect(rows[0]?.[7]).toBe(0.0084);
    expect(escapeTradeCsv(rows[0]![7] as number)).toBe('0.0084');
  });

  it.each([
    ['timestamp', { timestamp: undefined }],
    ['fee', { fee: undefined }],
    ['execution ID', { orderId: undefined }],
    ['venue provenance', { evidenceSource: undefined }],
  ])('does not export a filled leg with missing authoritative %s evidence', (_field, omission) => {
    const leg = {
      status: 'filled', filledSize: 9, filledPrice: 0.41, fee: 0,
      orderId: 'k-fill-1', timestamp: '2026-08-08T10:00:01.000Z', evidenceSource: 'venue',
      ...omission,
    };
    expect(executionRows({
      timestamp: '2026-08-08T10:00:00.000Z', arbId: 'arb-incomplete', marketTitle: 'Incomplete',
      dryRun: false, success: true, estimatedProfit: 2,
      kalshiOrder: { ticker: 'K-1', outcome: 'yes', size: 10, price: 0.4 },
      result: { kalshiResult: leg },
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
