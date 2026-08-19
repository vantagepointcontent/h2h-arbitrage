import type { ClosedPosition, ExecutionRecord } from './persistence';
import { formatScaledMoney, parseCalculationEnvelope, type CalculationEnvelope } from './calculation-envelope';

export const TRADE_EXPORT_HEADERS = [
  'Timestamp', 'Platform', 'Event Name', 'Market Name', 'Side', 'Shares',
  'Price', 'Fees', 'Realized P&L', 'Arb ID', 'Status', 'Method',
  'Fee Source', 'Fee Observed At', 'Fee Version', 'Fee Calculated Cents', 'Fee Charged Cents',
  'Calculation Version', 'Calculation Status', 'Calculation Blocker Code', 'Calculation Blocker',
  'Requested Quantity', 'Executable Quantity', 'Instrument ID', 'Outcome ID',
  'Book Observed At', 'Fill Levels JSON', 'VWAP Price', 'Fee Basis', 'Fee Amount',
  'Fee Source', 'Fee Version', 'Fee Observed At', 'Fee Rate PPM',
  'Gross Cost', 'Gross Payout', 'Gross Profit', 'Total Fees', 'Net P&L',
  'Rounding JSON', 'Calculation Envelope JSON',
] as const;

export type TradeExportRow = readonly (string | number)[];

type ExportValueRecord = Record<string, unknown>;

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalFinite(value: unknown): number | '' {
  if (value == null || value === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : '';
}

function envelopeColumns(envelope: CalculationEnvelope, venue?: string): TradeExportRow {
  const leg = venue ? envelope.legs.find((candidate) => candidate.venue.toLowerCase() === venue.toLowerCase()) : undefined;
  return [
    envelope.version, envelope.status, envelope.blocker?.code ?? '', envelope.blocker?.message ?? '',
    formatScaledMoney(envelope.requestedQuantityMicros), formatScaledMoney(envelope.executableQuantityMicros),
    leg?.instrumentId ?? '', leg?.outcomeId ?? '', leg?.bookObservedAt ?? '',
    leg ? JSON.stringify(leg.fillLevels) : '', formatScaledMoney(leg?.vwapPriceMicros ?? null),
    leg?.fee.basis ?? '', formatScaledMoney(leg?.fee.amountMicros ?? null),
    leg?.fee.schedule?.source ?? '', leg?.fee.schedule?.version ?? '', leg?.fee.schedule?.observedAt ?? '',
    leg?.fee.schedule?.ratePpm ?? '',
    formatScaledMoney(envelope.totals.grossCostMicros), formatScaledMoney(envelope.totals.grossPayoutMicros),
    formatScaledMoney(envelope.totals.grossProfitMicros), formatScaledMoney(envelope.totals.totalFeesMicros),
    formatScaledMoney(envelope.totals.netPnlMicros), JSON.stringify(envelope.rounding), JSON.stringify(envelope),
  ];
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
  const envelope = parseCalculationEnvelope(execution.calculationEnvelope, `execution ${execution.id ?? execution.arbId}`);
  return ([
    ['Kalshi', execution.kalshiOrder, result.kalshiResult],
    ['Polymarket', execution.polymarketOrder, result.polymarketResult],
  ] as const).flatMap(([platform, rawOrder, rawResult]) => {
    if (!rawOrder) return [];
    const order = rawOrder as ExportValueRecord;
    const leg = (rawResult ?? {}) as ExportValueRecord;
    const evidence = leg.venueEvidence && typeof leg.venueEvidence === 'object'
      ? leg.venueEvidence as ExportValueRecord : null;
    const filledSize = Number(leg.filledContracts ?? evidence?.filledQuantity ?? leg.filledSize);
    const filledPrice = Number(leg.filledPrice ?? evidence?.fillPrice);
    const exactFeeMicrousd = leg.chargedFeeMicrousd ?? evidence?.chargedFeeMicrousd;
    const chargedFeeCents = leg.chargedFeeCents ?? evidence?.chargedFeeCents;
    const exactFeeValid = exactFeeMicrousd == null
      || (typeof exactFeeMicrousd === 'number' && Number.isSafeInteger(exactFeeMicrousd)
        && exactFeeMicrousd >= 0 && exactFeeMicrousd % 10 === 0);
    const fee = exactFeeValid && typeof exactFeeMicrousd === 'number'
      ? exactFeeMicrousd / 1_000_000
      : typeof chargedFeeCents === 'number' && Number.isSafeInteger(chargedFeeCents)
        ? chargedFeeCents / 100
        : leg.fees ?? leg.fee;
    const timestampValue = leg.venueTimestamp ?? evidence?.venueTimestamp ?? leg.timestamp;
    const timestamp = typeof timestampValue === 'string' ? timestampValue : '';
    const executionId = leg.executionId ?? evidence?.executionId ?? leg.orderId;
    const venueEvidenceValid = evidence?.venue === platform.toLowerCase();
    const legacyEvidenceValid = leg.evidenceSource === 'venue';
    if (!['filled', 'partial'].includes(String(leg.status))
      || !Number.isFinite(filledSize) || filledSize <= 0
      || !Number.isFinite(filledPrice) || filledPrice <= 0 || filledPrice > 1
      || !exactFeeValid
      || typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0
      || typeof executionId !== 'string' || !executionId.trim()
      || !Number.isFinite(Date.parse(timestamp))
      || (!venueEvidenceValid && !legacyEvidenceValid)) return [];
    const marketName = String(order.ticker ?? order.marketId ?? order.conditionId ?? '');
    const status = String(leg.status ?? (execution.success ? 'open' : 'failed'));
    return [[
      new Date(timestamp).toISOString(), platform,
      execution.marketTitle, marketName, String(order.outcome ?? '').toUpperCase(),
      filledSize, filledPrice,
      fee,
      '', execution.arbId, status,
      execution.source === 'bot' ? (execution.selectionMethod ?? 'Legacy/Unknown') : 'Manual',
      platform === 'Kalshi' ? String(kalshiQuote?.source ?? '') : '',
      platform === 'Kalshi' ? String(kalshiQuote?.observedAt ?? '') : '',
      platform === 'Kalshi' ? String(kalshiQuote?.version ?? '') : '',
      platform === 'Kalshi' && Number.isSafeInteger(kalshiQuote?.calculatedFeeCents)
        ? Number(kalshiQuote?.calculatedFeeCents) : '',
      platform === 'Kalshi' && Number.isSafeInteger(kalshiQuote?.chargedFeeCents)
        ? Number(kalshiQuote?.chargedFeeCents) : '',
      ...envelopeColumns(envelope, platform),
    ] satisfies TradeExportRow];
  });
}

export function closedPositionRow(position: ClosedPosition): TradeExportRow {
  const envelope = parseCalculationEnvelope(position.calculationEnvelope, `closed position ${position.id ?? position.pairId ?? ''}`);
  const calculationLeg = envelope.legs.find((candidate) => candidate.venue === position.platform);
  return [
    new Date(position.closedAt).toISOString(),
    position.platform === 'kalshi' ? 'Kalshi' : 'Polymarket',
    position.marketTitle,
    position.ticker ?? position.conditionId ?? position.marketTitle,
    position.side,
    optionalFinite(position.size),
    finite(position.entryPrice),
    calculationLeg?.fee.amountMicros != null ? formatScaledMoney(calculationLeg.fee.amountMicros) : '',
    optionalFinite(position.realizedPnl),
    position.pairId ?? '',
    'closed', 'Manual', '', '', '', '', '',
    ...envelopeColumns(envelope, position.platform),
  ];
}

export function tradeCsvLine(row: readonly unknown[]): string {
  return row.map(escapeTradeCsv).join(',') + '\n';
}
