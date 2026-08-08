import type { ClosedPosition, ExecutionRecord } from './persistence';

export const TRADE_EXPORT_HEADERS = [
  'Timestamp', 'Platform', 'Event Name', 'Market Name', 'Side', 'Shares',
  'Price', 'Fees', 'Realized P&L', 'Arb ID', 'Status',
] as const;

export type TradeExportRow = readonly (string | number)[];

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function escapeTradeCsv(value: unknown): string {
  if (value == null) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text))) text = `'${text}`;
  return /[,"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function executionRows(execution: ExecutionRecord): TradeExportRow[] {
  if (execution.dryRun) return [];
  const result = (execution.result ?? {}) as Record<string, any>;
  return ([
    ['Kalshi', execution.kalshiOrder, result.kalshiResult],
    ['Polymarket', execution.polymarketOrder, result.polymarketResult],
  ] as const).flatMap(([platform, rawOrder, rawResult]) => {
    if (!rawOrder) return [];
    const order = rawOrder as Record<string, any>;
    const leg = (rawResult ?? {}) as Record<string, any>;
    const marketName = String(order.ticker ?? order.marketId ?? order.conditionId ?? '');
    const status = String(leg.status ?? (execution.success ? 'open' : 'failed'));
    return [[
      new Date(leg.timestamp ?? execution.timestamp).toISOString(), platform,
      execution.marketTitle, marketName, String(order.outcome ?? '').toUpperCase(),
      finite(leg.filledSize ?? order.size), finite(leg.filledPrice ?? order.price),
      finite(leg.fees ?? leg.fee), '', execution.arbId, status,
    ] satisfies TradeExportRow];
  });
}

export function closedPositionRow(position: ClosedPosition): TradeExportRow {
  return [
    new Date(position.closedAt).toISOString(),
    position.platform === 'kalshi' ? 'Kalshi' : 'Polymarket',
    position.marketTitle,
    position.ticker ?? position.conditionId ?? position.marketTitle,
    position.side,
    finite(position.size),
    finite(position.entryPrice),
    finite(position.feesPaid),
    finite(position.realizedPnl),
    position.pairId ?? '',
    'closed',
  ];
}

export function tradeCsvLine(row: readonly unknown[]): string {
  return row.map(escapeTradeCsv).join(',') + '\n';
}
