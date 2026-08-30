import { auditArbClassification, type ArbType } from './arb-types';
import { calculateScanApy } from './scan-apy';

export interface CanonicalSavedMarketCandidate {
  artist: string;
  roiPct: number;
  expectedProfit: number;
  strategy: string;
  arbType?: ArbType | null;
  totalStake?: number | null;
  executionStatus?: 'executable' | 'non_executable' | 'unavailable';
  apyPct?: number | null;
  daysToExpiry?: number | null;
  expiryAt?: string | null;
  apyUnavailableReason?: string | null;
  outcomeApy?: { observedAt?: string | null } | null;
}

export interface CanonicalSavedMarketMetrics {
  value: number | null;
  unavailableReason: string | null;
  outcome: string | null;
  observedAt: string | null;
  roiPct: number | null;
  roiStatus: 'available' | 'not_applicable' | 'unavailable';
  roiUnavailableReason: string | null;
  profit: number | null;
  profitStatus: 'available' | 'not_applicable' | 'unavailable';
  profitUnavailableReason: string | null;
  strategy: string;
  daysToExpiry: number | null;
  expiryAt: string | null;
}

/**
 * Select the one canonical candidate allowed to own the current persisted
 * ROI/strategy/APY projection. APY is derived from that candidate's ROI and
 * event-time expiry rather than optional precomputed metrics. This pure
 * selector is shared by persistence and the immediate post-scan UI so the two
 * publications cannot diverge.
 */
export function selectCanonicalSavedMarketMetrics(
  candidates: CanonicalSavedMarketCandidate[],
  scannedAt: string | null | undefined,
  options?: { allowNonExecutable?: boolean },
): CanonicalSavedMarketMetrics {
  const observedAt = typeof scannedAt === 'string' && Number.isFinite(Date.parse(scannedAt))
    ? scannedAt : null;
  const allowNonExecutable = options?.allowNonExecutable ?? false;
  const eligible = candidates.filter((candidate) => {
    const declared = candidate.arbType === 'cross' || candidate.arbType === 'direct' || candidate.arbType === 'internal'
      ? candidate.arbType : null;
    const classification = auditArbClassification(candidate.strategy, declared);
    const executionOk = candidate.executionStatus == null
      || candidate.executionStatus === 'executable'
      || (allowNonExecutable && candidate.executionStatus === 'non_executable');
    return classification.valid && classification.canonicalType !== null
      && executionOk
      && Number.isFinite(candidate.roiPct) && candidate.roiPct > 0;
  });
  const best = eligible.reduce<CanonicalSavedMarketCandidate | null>((current, candidate) => {
    if (!current) return candidate;
    if (candidate.roiPct !== current.roiPct) return candidate.roiPct > current.roiPct ? candidate : current;
    return candidate.artist.localeCompare(current.artist) < 0 ? candidate : current;
  }, null);
  if (!best) {
    return {
      value: null, unavailableReason: 'no_canonical_arbitrage', outcome: null, observedAt,
      roiPct: null, roiStatus: 'not_applicable', roiUnavailableReason: null,
      profit: null, profitStatus: 'not_applicable', profitUnavailableReason: null,
      strategy: 'No arb', daysToExpiry: null, expiryAt: null,
    };
  }

  const expiryAt = typeof best.expiryAt === 'string' ? best.expiryAt : null;
  const apy = calculateScanApy(best.roiPct, scannedAt ?? '', expiryAt);
  const profit = (best.executionStatus == null || best.executionStatus === 'executable' || allowNonExecutable)
    && typeof best.expectedProfit === 'number' && Number.isFinite(best.expectedProfit)
    && best.expectedProfit > 0 ? best.expectedProfit : null;
  const profitUnavailableReason = profit != null ? null
    : typeof best.expectedProfit !== 'number' || !Number.isFinite(best.expectedProfit)
      ? 'missing_canonical_candidate_profit'
      : 'non_positive_canonical_candidate_profit';
  return {
    value: apy.apyPct,
    unavailableReason: apy.unavailableReason,
    outcome: best.artist,
    observedAt,
    roiPct: best.roiPct,
    roiStatus: 'available',
    roiUnavailableReason: null,
    profit,
    profitStatus: profit == null ? 'unavailable' : 'available',
    profitUnavailableReason,
    strategy: best.strategy,
    daysToExpiry: apy.daysToExpiry,
    expiryAt,
  };
}
