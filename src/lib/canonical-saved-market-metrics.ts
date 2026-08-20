import { auditArbClassification, type ArbType } from './arb-types';

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
 * Select the one executable candidate allowed to own the current persisted
 * ROI/strategy/APY projection. This pure selector is shared by persistence and
 * the immediate post-scan UI so the two publications cannot diverge.
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
    // executionStatus post-dates thousands of complete durable scan payloads.
    // Missing means legacy persisted evidence. Explicit non-executable rows may
    // retain indicative ROI, but never executable profit/APY; unavailable rows
    // remain closed entirely.
    const executionEligible = candidate.executionStatus == null
      || candidate.executionStatus === 'executable'
      || candidate.executionStatus === 'non_executable';
    const stakeEligible = candidate.executionStatus === 'non_executable'
      || (Number.isFinite(candidate.totalStake) && Number(candidate.totalStake) > 0);
    return classification.valid && classification.canonicalType !== null
      && executionEligible
      && Number.isFinite(candidate.roiPct) && candidate.roiPct > 0
      && stakeEligible;
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

  const daysToExpiry = typeof best.daysToExpiry === 'number' && Number.isFinite(best.daysToExpiry) && best.daysToExpiry > 0
    ? best.daysToExpiry : null;
  const expiryAt = typeof best.expiryAt === 'string' && Number.isFinite(Date.parse(best.expiryAt))
    ? best.expiryAt : null;
  if (best.executionStatus === 'non_executable') {
    return {
      value: null,
      unavailableReason: 'current_candidate_non_executable',
      outcome: best.artist,
      observedAt: best.outcomeApy?.observedAt ?? observedAt,
      roiPct: best.roiPct,
      profit: null,
      strategy: best.strategy,
      daysToExpiry,
      expiryAt,
    };
  }
  const profit = typeof best.expectedProfit === 'number' && Number.isFinite(best.expectedProfit)
    && best.expectedProfit > 0 ? best.expectedProfit : null;
  if (profit == null) {
    return {
      value: null,
      unavailableReason: 'current_profit_unavailable',
      outcome: best.artist,
      observedAt: best.outcomeApy?.observedAt ?? observedAt,
      roiPct: best.roiPct,
      profit: null,
      strategy: best.strategy,
      daysToExpiry,
      expiryAt,
    };
  }
  const expectedApy = daysToExpiry == null ? null
    : (Math.pow(1 + best.roiPct / 100, 365 / daysToExpiry) - 1) * 100;
  const apyMatches = typeof best.apyPct === 'number' && Number.isFinite(best.apyPct)
    && expectedApy != null && Number.isFinite(expectedApy)
    && Math.abs(best.apyPct - expectedApy) <= Math.max(1e-9, Math.abs(expectedApy) * 1e-9);
  if (!apyMatches || expiryAt == null) {
    return {
      value: null,
      unavailableReason: best.apyUnavailableReason ?? (daysToExpiry == null || expiryAt == null
        ? 'current_tte_unavailable' : 'current_apy_mismatch'),
      outcome: best.artist,
      observedAt: best.outcomeApy?.observedAt ?? observedAt,
      roiPct: best.roiPct,
      profit,
      strategy: best.strategy,
      daysToExpiry,
      expiryAt,
    };
  }
  return {
    value: best.apyPct!,
    unavailableReason: null,
    outcome: best.artist,
    observedAt: best.outcomeApy?.observedAt ?? observedAt,
    roiPct: best.roiPct,
    profit,
    strategy: best.strategy,
    daysToExpiry,
    expiryAt,
  };
}
