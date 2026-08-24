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
  profit: number | null;
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
): CanonicalSavedMarketMetrics {
  const observedAt = typeof scannedAt === 'string' && Number.isFinite(Date.parse(scannedAt))
    ? scannedAt : null;
  const eligible = candidates.filter((candidate) => {
    const declared = candidate.arbType === 'cross' || candidate.arbType === 'direct' || candidate.arbType === 'internal'
      ? candidate.arbType : null;
    const classification = auditArbClassification(candidate.strategy, declared);
    return classification.valid && classification.canonicalType !== null
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
      roiPct: null, profit: null, strategy: 'No arb', daysToExpiry: null, expiryAt: null,
    };
  }

  const expiryAt = typeof best.expiryAt === 'string' ? best.expiryAt : null;
  const apy = calculateScanApy(best.roiPct, scannedAt ?? '', expiryAt);
  const profit = (best.executionStatus == null || best.executionStatus === 'executable')
    && typeof best.expectedProfit === 'number' && Number.isFinite(best.expectedProfit)
    && best.expectedProfit > 0 ? best.expectedProfit : null;
  return {
    value: apy.apyPct,
    unavailableReason: apy.unavailableReason,
    outcome: best.artist,
    observedAt,
    roiPct: best.roiPct,
    profit,
    strategy: best.strategy,
    daysToExpiry: apy.daysToExpiry,
    expiryAt,
  };
}
