import type { ClosedPosition, ExecutionRecord } from './persistence';

export const TRADE_EXPORT_HEADERS = [
  'Timestamp', 'Platform', 'Event Name', 'Market Name', 'Side', 'Shares',
  'Price', 'Fees', 'Realized P&L', 'Arb ID', 'Status', 'Method',
  'Fee Source', 'Fee Observed At', 'Fee Version', 'Fee Calculated Cents', 'Fee Charged Cents',
] as const;

export type TradeExportRow = readonly (string | number)[];

type ExportValueRecord = Record<string, unknown>;

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
  if (execution.dryRun || !execution.success) return [];
  const result = (execution.result ?? {}) as ExportValueRecord;
  const kalshiQuote = result.kalshiFeeQuote && typeof result.kalshiFeeQuote === 'object'
    ? result.kalshiFeeQuote as ExportValueRecord
    : null;
  return ([
    ['Kalshi', execution.kalshiOrder, result.kalshiResult],
    ['Polymarket', execution.polymarketOrder, result.polymarketResult],
  ] as const).flatMap(([platform, rawOrder, rawResult]) => {
    if (!rawOrder) return [];
    const order = rawOrder as ExportValueRecord;
    const leg = (rawResult ?? {}) as ExportValueRecord;
    const filledSize = Number(leg.filledSize);
    const filledPrice = Number(leg.filledPrice);
    const fee = leg.fees ?? leg.fee;
    const timestamp = typeof leg.timestamp === 'string' ? leg.timestamp : '';
    if (!['filled', 'partial'].includes(String(leg.status))
      || !Number.isFinite(filledSize) || filledSize <= 0
      || !Number.isFinite(filledPrice) || filledPrice <= 0 || filledPrice > 1
      || typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0
      || typeof leg.orderId !== 'string' || !leg.orderId.trim()
      || !Number.isFinite(Date.parse(timestamp))
      || leg.evidenceSource !== 'venue') return [];
    const marketName = String(order.ticker ?? order.marketId ?? order.conditionId ?? '');
    const status = String(leg.status ?? (execution.success ? 'open' : 'failed'));
    return [[
      new Date(timestamp).toISOString(), platform,
      execution.marketTitle, marketName, String(order.outcome ?? '').toUpperCase(),
      filledSize, filledPrice,
      fee, '', execution.arbId, status,
      execution.source === 'bot' ? (execution.selectionMethod ?? 'Legacy/Unknown') : 'Manual',
      platform === 'Kalshi' ? String(kalshiQuote?.source ?? '') : '',
      platform === 'Kalshi' ? String(kalshiQuote?.observedAt ?? '') : '',
      platform === 'Kalshi' ? String(kalshiQuote?.version ?? '') : '',
      platform === 'Kalshi' && Number.isSafeInteger(kalshiQuote?.calculatedFeeCents)
        ? Number(kalshiQuote?.calculatedFeeCents) : '',
      platform === 'Kalshi' && Number.isSafeInteger(kalshiQuote?.chargedFeeCents)
        ? Number(kalshiQuote?.chargedFeeCents) : '',
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
    'closed', 'Manual', '', '', '', '', '',
  ];
}

export function tradeCsvLine(row: readonly unknown[]): string {
  return row.map(escapeTradeCsv).join(',') + '\n';
}
