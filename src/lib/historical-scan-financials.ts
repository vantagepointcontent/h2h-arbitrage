import { parseCalculationEnvelope, type CalculationEnvelope } from './calculation-envelope';

export const HISTORICAL_SCAN_FINANCIALS_REVISION = 3 as const;

export type HistoricalFinancialSource = 'scan_result_scalar' | 'raw_result_snapshot';
export type HistoricalFinancialFieldName = 'roiPct' | 'profitUsd' | 'apyPct' | 'stakeUsd';
export type HistoricalFinancialReasonCode =
  | 'historical_roi_not_persisted'
  | 'historical_profit_not_persisted'
  | 'historical_apy_not_persisted'
  | 'historical_stake_not_persisted'
  | 'current_candidate_non_executable'
  | 'confirmed_no_arbitrage';

export type HistoricalFinancialField =
  | {
      status: 'available';
      value: number;
      source: HistoricalFinancialSource;
      sourceRevision: string;
    }
  | {
      status: 'unavailable';
      value: null;
      source: 'unavailable';
      sourceRevision: string;
      reasonCode: HistoricalFinancialReasonCode;
      reason: string;
    };

export interface HistoricalScanFinancials {
  revision: typeof HISTORICAL_SCAN_FINANCIALS_REVISION;
  scanId: number | null;
  envelope: CalculationEnvelope;
  fields: Record<HistoricalFinancialFieldName, HistoricalFinancialField>;
}

type PersistedFinancialRow = {
  id?: unknown;
  strategy?: unknown;
  positive_arb_count?: unknown;
  best_roi_pct?: unknown;
  best_profit?: unknown;
  apy_pct?: unknown;
  total_stake?: unknown;
  raw_result?: unknown;
  calculation_envelope?: unknown;
  historical_financials_revision?: unknown;
  historical_financials_provenance?: unknown;
};

type RawFinancialSnapshot = {
  roiPct?: unknown;
  expectedProfit?: unknown;
  apyPct?: unknown;
  totalStake?: unknown;
  strategy?: unknown;
  executionStatus?: unknown;
  executionBlocker?: unknown;
};

const FIELD_METADATA: Record<HistoricalFinancialFieldName, {
  scalar: keyof PersistedFinancialRow;
  raw: keyof RawFinancialSnapshot;
  reasonCode: HistoricalFinancialReasonCode;
  reason: string;
}> = {
  roiPct: {
    scalar: 'best_roi_pct', raw: 'roiPct', reasonCode: 'historical_roi_not_persisted',
    reason: 'No authoritative scan-time ROI value was persisted for this result.',
  },
  profitUsd: {
    scalar: 'best_profit', raw: 'expectedProfit', reasonCode: 'historical_profit_not_persisted',
    reason: 'No authoritative scan-time profit value was persisted for this result.',
  },
  apyPct: {
    scalar: 'apy_pct', raw: 'apyPct', reasonCode: 'historical_apy_not_persisted',
    reason: 'No authoritative scan-time APY value was persisted for this result.',
  },
  stakeUsd: {
    scalar: 'total_stake', raw: 'totalStake', reasonCode: 'historical_stake_not_persisted',
    reason: 'No authoritative scan-time stake value was persisted for this result.',
  },
};

function finitePersistedNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractRawSnapshots(value: unknown): RawFinancialSnapshot[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const allArbs = (parsed as { allArbs?: unknown }).allArbs;
  if (!Array.isArray(allArbs)) return [];
  return allArbs.filter((candidate): candidate is RawFinancialSnapshot =>
    candidate != null && typeof candidate === 'object' && !Array.isArray(candidate));
}

function sameFiniteNumber(left: unknown, right: unknown): boolean {
  const a = finitePersistedNumber(left);
  const b = finitePersistedNumber(right);
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 8;
}

function selectRawSnapshot(row: PersistedFinancialRow): RawFinancialSnapshot | null {
  const snapshots = extractRawSnapshots(row.raw_result);
  if (snapshots.length === 1) return snapshots[0];
  if (snapshots.length === 0) return null;
  const strategy = typeof row.strategy === 'string' ? row.strategy : null;
  const exact = snapshots.filter((candidate) => sameFiniteNumber(candidate.roiPct, row.best_roi_pct)
    && (strategy == null || candidate.strategy === strategy));
  return exact.length === 1 ? exact[0] : null;
}

type PersistedFieldProvenance = { status?: unknown; reasonCode?: unknown };

function parseFieldProvenance(row: PersistedFinancialRow): Partial<Record<HistoricalFinancialFieldName, PersistedFieldProvenance>> | null {
  if (row.historical_financials_revision !== HISTORICAL_SCAN_FINANCIALS_REVISION) return null;
  let parsed = row.historical_financials_provenance;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const fields = (parsed as { fields?: unknown }).fields;
  return fields && typeof fields === 'object' && !Array.isArray(fields)
    ? fields as Partial<Record<HistoricalFinancialFieldName, PersistedFieldProvenance>>
    : null;
}

export function serializeHistoricalFinancialProvenance(
  row: PersistedFinancialRow,
  authoritativeScalarFields: HistoricalFinancialFieldName[] = [],
): string {
  const authoritativeFields = Object.fromEntries(authoritativeScalarFields.map((name) => [name, { status: 'available' }]));
  const resolved = resolveHistoricalScanFinancials({
    ...row,
    historical_financials_revision: authoritativeScalarFields.length > 0 ? HISTORICAL_SCAN_FINANCIALS_REVISION : null,
    historical_financials_provenance: authoritativeScalarFields.length > 0
      ? { revision: HISTORICAL_SCAN_FINANCIALS_REVISION, fields: authoritativeFields }
      : null,
  });
  return JSON.stringify({
    revision: HISTORICAL_SCAN_FINANCIALS_REVISION,
    fields: Object.fromEntries(Object.entries(resolved.fields).map(([name, field]) => [name,
      field.status === 'available'
        ? { status: 'available', source: field.source, sourceRevision: field.sourceRevision }
        : { status: 'unavailable', reasonCode: field.reasonCode, reason: field.reason },
    ])),
  });
}

/**
 * Resolve immutable historical economics field-by-field. Calculation envelopes
 * are provenance, not a gate: a sparse/newer envelope must never erase older
 * scalar evidence captured by the completed scan.
 */
export function resolveHistoricalScanFinancials(row: PersistedFinancialRow): HistoricalScanFinancials {
  const id = finitePersistedNumber(row.id);
  const scanId = id != null && Number.isSafeInteger(id) && id > 0 ? id : null;
  const envelope = parseCalculationEnvelope(row.calculation_envelope, `scan result ${scanId ?? 'unknown'}`);
  const positiveArbCount = finitePersistedNumber(row.positive_arb_count);
  const positiveArb = positiveArbCount != null && positiveArbCount > 0;
  const raw = selectRawSnapshot(row);
  const scalarRevision = `scan_results:${scanId ?? 'unknown'}`;
  const rawRevision = `${scalarRevision}:raw_result`;
  // Canonical persisted arb count owns applicability. A completed scan may
  // retain its best indicative candidate for diagnostics while truthfully
  // recording zero executable Positive Arbs; those arb-only economics are N/A.
  const confirmedNoArbitrage = positiveArbCount === 0
    || (row.strategy === 'No arb' && !positiveArb);
  const selectedCandidate = typeof row.strategy === 'string' && row.strategy.length > 0 && row.strategy !== 'No arb';
  const provenance = parseFieldProvenance(row);

  const fields = Object.fromEntries((Object.keys(FIELD_METADATA) as HistoricalFinancialFieldName[]).map((name) => {
    const metadata = FIELD_METADATA[name];
    if (confirmedNoArbitrage) {
      return [name, {
        status: 'unavailable', value: null, source: 'unavailable', sourceRevision: scalarRevision,
        reasonCode: 'confirmed_no_arbitrage',
        reason: 'The completed scan found no candidate opportunity; this financial metric is not applicable.',
      } satisfies HistoricalFinancialField];
    }
    const persistedField = provenance?.[name];
    if (persistedField?.status === 'unavailable') {
      return [name, {
        status: 'unavailable', value: null, source: 'unavailable', sourceRevision: scalarRevision,
        reasonCode: metadata.reasonCode, reason: metadata.reason,
      } satisfies HistoricalFinancialField];
    }
    const scalar = finitePersistedNumber(row[metadata.scalar]);
    // Legacy positive-opportunity writers used zero as a missing-value
    // sentinel. A zero is authoritative only when the row is not claiming a
    // positive executable opportunity; negative event-time ROI remains valid.
    const scalarUsable = scalar != null && (scalar !== 0 || persistedField?.status === 'available'
      || (!positiveArb && !selectedCandidate));
    if (scalarUsable) {
      return [name, {
        status: 'available', value: scalar, source: 'scan_result_scalar', sourceRevision: scalarRevision,
      } satisfies HistoricalFinancialField];
    }

    const rawValue = finitePersistedNumber(raw?.[metadata.raw]);
    const rawUsable = rawValue != null && (rawValue !== 0 || persistedField?.status === 'available');
    if (rawUsable) {
      return [name, {
        status: 'available', value: rawValue, source: 'raw_result_snapshot', sourceRevision: rawRevision,
      } satisfies HistoricalFinancialField];
    }

    // A raw non-executable annotation can explain genuinely absent applicable
    // evidence, but it must never overwrite an immutable persisted snapshot.
    if (name !== 'roiPct' && raw?.executionStatus === 'non_executable') {
      const blocker = typeof raw.executionBlocker === 'string' && raw.executionBlocker.trim()
        ? ` ${raw.executionBlocker.trim()}` : '';
      return [name, {
        status: 'unavailable', value: null, source: 'unavailable', sourceRevision: rawRevision,
        reasonCode: 'current_candidate_non_executable',
        reason: `The selected scan candidate was indicative but not executable; no tradeable ${name === 'profitUsd' ? 'profit' : name === 'apyPct' ? 'APY' : 'stake'} was established.${blocker}`,
      } satisfies HistoricalFinancialField];
    }

    return [name, {
      status: 'unavailable', value: null, source: 'unavailable', sourceRevision: scalarRevision,
      reasonCode: metadata.reasonCode, reason: metadata.reason,
    } satisfies HistoricalFinancialField];
  })) as Record<HistoricalFinancialFieldName, HistoricalFinancialField>;

  return { revision: HISTORICAL_SCAN_FINANCIALS_REVISION, scanId, envelope, fields };
}
