/**
 * DATA-007: Authoritative Execution Metadata Contract
 *
 * Shared contract that represents authoritative live execution evidence.
 * A live execution must not be marked successful or analytics-eligible
 * unless every required field is present, well-formed, and traceable to
 * venue evidence. Requested order values, local timestamps, calculated
 * fees, and other inferred fallbacks must not satisfy the contract.
 *
 * Paper executions are preserved but tagged/type-distinct from verified
 * live evidence so they are unambiguously non-authoritative.
 */

import type { OrderResult, ExecutionResult } from './auto-execute';

// ── Venue Identity ────────────────────────────────────────────────────

export type VenueIdentity = 'kalshi' | 'polymarket';

export interface VenueExecutionFill {
  executionId: string;
  quantity: number;
  price: number;
  chargedFeeCents: number;
  venueTimestamp: string;
  /** Liquidity role reported for this individual fill when supplied by the venue. */
  liquidityRole?: 'maker' | 'taker';
}

// ── Live Execution Evidence (authoritative) ─────────────────────────

export interface VenueExecutionEvidence {
  /** Which venue produced this evidence */
  venue: VenueIdentity;

  /** Authoritative filled quantity in contracts/shares as reported by the venue */
  filledQuantity: number;

  /** Authoritative fill price (0-1) as reported by the venue */
  fillPrice: number;

  /** Fee charged by the venue in cents (must be venue-reported, not locally calculated) */
  chargedFeeCents: number;

  /** Venue-provided execution/order identifier */
  executionId: string;

  /** Venue-provided timestamp of the fill/execution (ISO 8601) */
  venueTimestamp: string;

  /** Raw venue response payload for audit traceability */
  raw?: unknown;

  /** Every correlated venue fill when the order executed in multiple trades. */
  fills?: VenueExecutionFill[];

  /** Common liquidity role when all correlated fills share one. */
  liquidityRole?: 'maker' | 'taker';
}

/** A complete authoritative live execution requires evidence from BOTH legs. */
export interface LiveExecutionEvidence {
  kind: 'live';

  /** Evidence from the Kalshi leg */
  kalshi: VenueExecutionEvidence;

  /** Evidence from the Polymarket leg */
  polymarket: VenueExecutionEvidence;

  /** Net actual profit computed from venue-reported fills */
  actualProfit: number;

  /** Whether both legs were matched in contract quantity */
  contractsMatched: boolean;
}

// ── Paper Execution Evidence (non-authoritative) ──────────────────────

export interface PaperExecutionEvidence {
  kind: 'paper';

  /** Simulated Kalshi leg */
  kalshi: {
    venue: 'kalshi';
    filledQuantity: number;
    fillPrice: number;
    executionId: string;
    venueTimestamp: string;
  };

  /** Simulated Polymarket leg */
  polymarket: {
    venue: 'polymarket';
    filledQuantity: number;
    fillPrice: number;
    executionId: string;
    venueTimestamp: string;
  };

  /** Simulated profit */
  actualProfit: number;

  /** Always true for paper since quantities are identical by construction */
  contractsMatched: boolean;
}

// ── Union ─────────────────────────────────────────────────────────────

export type ExecutionEvidence = LiveExecutionEvidence | PaperExecutionEvidence;

// ── Validation ──────────────────────────────────────────────────────

/**
 * Validate that a single venue's evidence meets the authoritative contract.
 * Rejects missing, malformed, or locally-inferred values.
 */
export function isAuthoritativeVenueEvidence(
  evidence: unknown,
): evidence is VenueExecutionEvidence {
  if (!evidence || typeof evidence !== 'object') return false;
  const e = evidence as Record<string, unknown>;

  // venue identity
  if (e.venue !== 'kalshi' && e.venue !== 'polymarket') return false;

  // BotTrader analytics persists integer contracts.
  const filledQuantity = typeof e.filledQuantity === 'number' ? e.filledQuantity : Number.NaN;
  if (!Number.isSafeInteger(filledQuantity) || filledQuantity <= 0) return false;

  // fillPrice: must be in (0, 1)
  const fillPrice = typeof e.fillPrice === 'number' ? e.fillPrice : Number.NaN;
  if (!Number.isFinite(fillPrice) || fillPrice <= 0 || fillPrice >= 1) return false;

  // executionId: non-empty string
  if (typeof e.executionId !== 'string' || e.executionId.trim().length === 0) return false;

  // venueTimestamp: well-formed ISO 8601 string with timezone
  if (typeof e.venueTimestamp !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(e.venueTimestamp)) return false;
  const tsMs = Date.parse(e.venueTimestamp);
  if (Number.isNaN(tsMs)) return false;

  // Missing fee means unknown, not zero.
  if (!Number.isSafeInteger(e.chargedFeeCents) || Number(e.chargedFeeCents) < 0) return false;

  if (e.fills != null) {
    if (!Array.isArray(e.fills) || e.fills.length === 0) return false;
    let quantity = 0;
    let gross = 0;
    let fees = 0;
    const ids = new Set<string>();
    for (const rawFill of e.fills) {
      if (!rawFill || typeof rawFill !== 'object' || Array.isArray(rawFill)) return false;
      const fill = rawFill as Record<string, unknown>;
      if (typeof fill.executionId !== 'string' || !fill.executionId.trim() || ids.has(fill.executionId)) return false;
      if (!Number.isSafeInteger(fill.quantity) || Number(fill.quantity) <= 0) return false;
      if (typeof fill.price !== 'number' || !Number.isFinite(fill.price) || fill.price <= 0 || fill.price >= 1) return false;
      if (!Number.isSafeInteger(fill.chargedFeeCents) || Number(fill.chargedFeeCents) < 0) return false;
      if (typeof fill.venueTimestamp !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(fill.venueTimestamp)
        || Number.isNaN(Date.parse(fill.venueTimestamp))) return false;
      ids.add(fill.executionId);
      quantity += Number(fill.quantity);
      gross += Number(fill.quantity) * fill.price;
      fees += Number(fill.chargedFeeCents);
    }
    if (quantity !== filledQuantity || fees !== e.chargedFeeCents
      || Math.abs(gross / quantity - fillPrice) > 1e-12) return false;
  }

  return true;
}

/**
 * Validate a complete live execution evidence.
 * Both legs must be authoritative and contracts must match.
 */
export function isAuthoritativeLiveEvidence(
  evidence: unknown,
): evidence is LiveExecutionEvidence {
  if (!evidence || typeof evidence !== 'object') return false;
  const e = evidence as Record<string, unknown>;

  if (e.kind !== 'live') return false;
  if (!isAuthoritativeVenueEvidence(e.kalshi)) return false;
  if (!isAuthoritativeVenueEvidence(e.polymarket)) return false;
  if (e.contractsMatched !== true) return false;

  const kalshi = e.kalshi as VenueExecutionEvidence;
  const polymarket = e.polymarket as VenueExecutionEvidence;

  // Cross-validate: both venues must be distinct
  if (kalshi.venue === polymarket.venue) return false;

  // actualProfit must be a finite number
  const actualProfit = typeof e.actualProfit === 'number' ? e.actualProfit : Number.NaN;
  if (!Number.isFinite(actualProfit)) return false;

  return true;
}

/**
 * Build execution evidence from an ExecutionResult.
 * Returns null for dry-run executions (paper) or when evidence is incomplete.
 */
export function buildExecutionEvidence(
  result: ExecutionResult,
  dryRun: boolean,
): ExecutionEvidence | null {
  if (dryRun) {
    return buildPaperEvidence(result);
  }
  return buildLiveEvidence(result);
}

function buildPaperEvidence(result: ExecutionResult): PaperExecutionEvidence | null {
  const k = result.kalshiResult;
  const p = result.polymarketResult;

  if (!k.filledContracts || !p.filledContracts) return null;
  if (k.filledPrice == null || p.filledPrice == null) return null;

  return {
    kind: 'paper',
    kalshi: {
      venue: 'kalshi',
      filledQuantity: k.filledContracts,
      fillPrice: k.filledPrice,
      executionId: k.orderId ?? 'paper-unknown',
      venueTimestamp: k.timestamp,
    },
    polymarket: {
      venue: 'polymarket',
      filledQuantity: p.filledContracts,
      fillPrice: p.filledPrice,
      executionId: p.orderId ?? 'paper-unknown',
      venueTimestamp: p.timestamp,
    },
    actualProfit: result.actualProfit ?? 0,
    contractsMatched: true,
  };
}

function buildLiveEvidence(result: ExecutionResult): LiveExecutionEvidence | null {
  const kalshiEvidence = result.kalshiResult.venueEvidence;
  const polymarketEvidence = result.polymarketResult.venueEvidence;
  if (!isAuthoritativeVenueEvidence(kalshiEvidence)
    || !isAuthoritativeVenueEvidence(polymarketEvidence)
    || kalshiEvidence.venue !== 'kalshi'
    || polymarketEvidence.venue !== 'polymarket') return null;
  if (typeof result.actualProfit !== 'number' || !Number.isFinite(result.actualProfit)) return null;

  const contractsMatched =
    Number.isFinite(kalshiEvidence.filledQuantity) &&
    Number.isFinite(polymarketEvidence.filledQuantity) &&
    Math.abs(kalshiEvidence.filledQuantity - polymarketEvidence.filledQuantity) < 1e-6;

  if (!contractsMatched) return null;

  const evidence: LiveExecutionEvidence = {
    kind: 'live',
    kalshi: kalshiEvidence,
    polymarket: polymarketEvidence,
    actualProfit: result.actualProfit,
    contractsMatched,
  };

  return isAuthoritativeLiveEvidence(evidence) ? evidence : null;
}

// ── OrderResult → Venue Evidence Conversion ───────────────────────────

/**
 * Convert an OrderResult to a VenueExecutionEvidence.
 * Returns null when any required field is missing or malformed.
 */
export function orderResultToVenueEvidence(result: OrderResult): VenueExecutionEvidence | null {
  const evidence = result.venueEvidence;
  return isAuthoritativeVenueEvidence(evidence) && evidence.venue === result.platform ? evidence : null;
}

/**
 * Extract the authoritative matched fill from two OrderResults.
 * Returns null when fills are mismatched, zero, or missing.
 */
export function getAuthoritativeMatchedFill(args: {
  kalshiResult: Pick<OrderResult, 'filledContracts' | 'filledPrice'>;
  polymarketResult: Pick<OrderResult, 'filledContracts' | 'filledPrice'>;
}): {
  kalshiContracts: number;
  pmContracts: number;
  kalshiPrice: number;
  pmPrice: number;
} | null {
  const kc = args.kalshiResult.filledContracts;
  const pc = args.polymarketResult.filledContracts;
  const kp = args.kalshiResult.filledPrice;
  const pp = args.polymarketResult.filledPrice;

  if (
    kc == null || pc == null ||
    !Number.isFinite(kc) || !Number.isFinite(pc) ||
    kc <= 0 || pc <= 0 ||
    kc !== pc
  ) {
    return null;
  }

  if (
    kp == null || pp == null ||
    !Number.isFinite(kp) || !Number.isFinite(pp) ||
    kp <= 0 || kp >= 1 ||
    pp <= 0 || pp >= 1
  ) {
    return null;
  }

  return {
    kalshiContracts: kc,
    pmContracts: pc,
    kalshiPrice: kp,
    pmPrice: pp,
  };
}

// ── Analytics Eligibility Gate ──────────────────────────────────────

/**
 * Determine whether an execution result is eligible for analytics.
 * Live executions require authoritative evidence. Paper executions
 * are explicitly ineligible for analytics to prevent simulated data
 * from contaminating performance metrics.
 */
export function isAnalyticsEligible(
  result: ExecutionResult,
  evidence: ExecutionEvidence | null,
): boolean {
  if (!evidence) return false;
  if (evidence.kind === 'paper') return false;
  return (
    evidence.kind === 'live' &&
    isAuthoritativeLiveEvidence(evidence) &&
    result.success === true &&
    !result.rollbackExecuted &&
    !result.unhedged
  );
}
