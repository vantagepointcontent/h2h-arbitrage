export const LOGS_REQUIRED_FIELDS = ['roi', 'profit', 'apy', 'state', 'currentRoi'] as const;
export type LogsRequiredField = typeof LOGS_REQUIRED_FIELDS[number];
export type LogsDataQualityState = 'healthy' | 'warning' | 'degraded';

export interface LogsQualityRow {
  id: number;
  scanStatus: string | null;
  positiveArbCount: number;
  arbValid: boolean;
  roiPct: number | null;
  profitUsd: number | null;
  apyPct: number | null;
  apyEligible: boolean;
  state: string | null;
  exactMarketIdentity: boolean;
  currentRoiPct: number | null;
  reasons: Partial<Record<LogsRequiredField, string>>;
}

export interface LogsFieldAvailability {
  denominator: number;
  available: number;
  unavailable: number;
  unavailablePct: number;
  reasons: Record<string, number>;
}

export interface LogsDataQualitySnapshot {
  batchId: string;
  state: LogsDataQualityState;
  fields: Record<LogsRequiredField, LogsFieldAvailability>;
  breaches: Array<{
    field: LogsRequiredField;
    trigger: 'structural_zero_tolerance' | 'single_batch_over_50pct' | 'two_consecutive_batches_over_5pct';
    unavailablePct: number;
  }>;
  reconciliation: { requested: boolean; maxAttempts: 2 };
  recoveryVerified: boolean;
}

export interface LogsQualityBatchInput {
  batchId: string;
  rows: LogsQualityRow[];
  previousBatch: LogsDataQualitySnapshot | null;
}

function finite(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function eligible(row: LogsQualityRow, field: LogsRequiredField): boolean {
  if (row.scanStatus !== 'completed' || !row.arbValid || row.positiveArbCount <= 0) return false;
  if (field === 'apy') return row.apyEligible;
  if (field === 'currentRoi') return row.exactMarketIdentity;
  return true;
}

function available(row: LogsQualityRow, field: LogsRequiredField): boolean {
  switch (field) {
    case 'roi': return finite(row.roiPct);
    case 'profit': return finite(row.profitUsd);
    case 'apy': return finite(row.apyPct);
    case 'state': return typeof row.state === 'string' && row.state.length > 0;
    case 'currentRoi': return finite(row.currentRoiPct);
  }
}

function fieldAvailability(rows: LogsQualityRow[], field: LogsRequiredField): LogsFieldAvailability {
  const cohort = rows.filter((row) => eligible(row, field));
  const unavailableRows = cohort.filter((row) => !available(row, field));
  const reasons: Record<string, number> = {};
  for (const row of unavailableRows) {
    const reason = row.reasons[field] ?? 'unexpected_missing_without_reason';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return {
    denominator: cohort.length,
    available: cohort.length - unavailableRows.length,
    unavailable: unavailableRows.length,
    unavailablePct: cohort.length === 0 ? 0 : unavailableRows.length * 100 / cohort.length,
    reasons,
  };
}

export function evaluateLogsDataQuality(input: LogsQualityBatchInput): LogsDataQualitySnapshot {
  const fields = Object.fromEntries(LOGS_REQUIRED_FIELDS.map((field) => [
    field,
    fieldAvailability(input.rows, field),
  ])) as Record<LogsRequiredField, LogsFieldAvailability>;

  const breaches: LogsDataQualitySnapshot['breaches'] = [];
  let warning = false;
  for (const field of LOGS_REQUIRED_FIELDS) {
    const metric = fields[field];
    if (metric.unavailable === 0) continue;
    const structural = Object.keys(metric.reasons).some((reason) =>
      reason.includes('structural') || reason.includes('schema') || reason.includes('persistence_field_missing'));
    if (structural) {
      breaches.push({ field, trigger: 'structural_zero_tolerance', unavailablePct: metric.unavailablePct });
    } else if (metric.unavailablePct > 50) {
      breaches.push({ field, trigger: 'single_batch_over_50pct', unavailablePct: metric.unavailablePct });
    } else if (metric.unavailablePct > 5
      && (input.previousBatch?.fields[field].unavailablePct ?? 0) > 5) {
      breaches.push({ field, trigger: 'two_consecutive_batches_over_5pct', unavailablePct: metric.unavailablePct });
    } else if (metric.unavailablePct > 5) {
      warning = true;
    }
  }

  const state: LogsDataQualityState = breaches.length > 0 ? 'degraded' : warning ? 'warning' : 'healthy';
  const recoveryVerified = input.previousBatch?.state === 'degraded' && state === 'healthy';
  return {
    batchId: input.batchId,
    state,
    fields,
    breaches,
    reconciliation: { requested: state === 'degraded', maxAttempts: 2 },
    recoveryVerified,
  };
}
