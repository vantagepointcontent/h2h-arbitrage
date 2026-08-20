import { parseCalculationEnvelope, type CalculationEnvelope } from './calculation-envelope';

export const HISTORICAL_SCAN_FINANCIALS_REVISION = 2 as const;

export type HistoricalFinancialSource = 'scan_result_scalar' | 'raw_result_snapshot';
export type HistoricalFinancialFieldName = 'roiPct' | 'profitUsd' | 'apyPct' | 'stakeUsd';
export type HistoricalFinancialReasonCode =
  | 'historical_roi_not_persisted'
  | 'historical_profit_not_persisted'
  | 'historical_apy_not_persisted'
  | 'historical_stake_not_persisted';

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
};

type RawFinancialSnapshot = {
  roiPct?: unknown;
  expectedProfit?: unknown;
  apyPct?: unknown;
  totalStake?: unknown;
  strategy?: unknown;
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

  const fields = Object.fromEntries((Object.keys(FIELD_METADATA) as HistoricalFinancialFieldName[]).map((name) => {
    const metadata = FIELD_METADATA[name];
    const scalar = finitePersistedNumber(row[metadata.scalar]);
    const scalarUsable = scalar != null && (!positiveArb || scalar > 0);
    if (scalarUsable) {
      return [name, {
        status: 'available', value: scalar, source: 'scan_result_scalar', sourceRevision: scalarRevision,
      } satisfies HistoricalFinancialField];
    }

    const rawValue = finitePersistedNumber(raw?.[metadata.raw]);
    const rawUsable = rawValue != null && (!positiveArb || rawValue > 0);
    if (rawUsable) {
      return [name, {
        status: 'available', value: rawValue, source: 'raw_result_snapshot', sourceRevision: rawRevision,
      } satisfies HistoricalFinancialField];
    }

    return [name, {
      status: 'unavailable', value: null, source: 'unavailable', sourceRevision: scalarRevision,
      reasonCode: metadata.reasonCode, reason: metadata.reason,
    } satisfies HistoricalFinancialField];
  })) as Record<HistoricalFinancialFieldName, HistoricalFinancialField>;

  return { revision: HISTORICAL_SCAN_FINANCIALS_REVISION, scanId, envelope, fields };
}
