import {
  quoteOneShareFromTopAsk,
  type ExecutableBookQuote,
  type ExecutableBookReason,
} from './executable-book';
import type { KalshiAskDepthStatus, UnifiedOutcome } from './matcher';

export type KalshiQuoteFailureKind =
  | 'rate_limited'
  | 'timeout'
  | 'wrong_ticker'
  | 'source_error'
  | 'stale_snapshot';

export interface KalshiQuoteSourceProvenance {
  status: 'fresh' | 'source_unavailable' | 'stale';
  attemptedAt: string;
  observedAt: string | null;
  failureKind?: KalshiQuoteFailureKind | null;
  detail?: string | null;
}

export const KALSHI_EXECUTABLE_QUOTE_MAX_AGE_MS = 30_000;

/** Classify the exact observation attached by the Kalshi HTTP adapter. */
export function resolveKalshiQuoteSourceProvenance(
  observedAt: string | null | undefined,
  attemptedAt: string,
  maxAgeMs = KALSHI_EXECUTABLE_QUOTE_MAX_AGE_MS,
): KalshiQuoteSourceProvenance {
  const attemptedMs = Date.parse(attemptedAt);
  const observedMs = typeof observedAt === 'string' ? Date.parse(observedAt) : Number.NaN;
  if (!Number.isFinite(attemptedMs) || !Number.isFinite(observedMs) || observedMs > attemptedMs
      || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
    return {
      status: 'source_unavailable', attemptedAt, observedAt: null,
      failureKind: 'source_error', detail: 'Kalshi depth observation timestamp is missing or invalid',
    };
  }
  const validObservedAt = observedAt as string;
  const ageMs = attemptedMs - observedMs;
  if (ageMs > maxAgeMs) {
    return {
      status: 'stale', attemptedAt, observedAt: validObservedAt,
      failureKind: 'stale_snapshot',
      detail: `Kalshi depth is ${ageMs}ms old (maximum ${maxAgeMs}ms)`,
    };
  }
  return {
    status: 'fresh', attemptedAt, observedAt: validObservedAt, failureKind: null, detail: null,
  };
}

function unavailableReason(status: KalshiAskDepthStatus | undefined): Extract<ExecutableBookReason,
  'authoritative_empty' | 'missing_depth' | 'malformed_depth' | 'inactive_market'> | undefined {
  if (status === 'authoritative_empty') return 'authoritative_empty';
  if (status === 'missing') return 'missing_depth';
  if (status === 'malformed') return 'malformed_depth';
  if (status === 'inactive') return 'inactive_market';
  return undefined;
}

/**
 * Bind a normalized Kalshi top-of-book quote to its source observation. Failure
 * attempts never reuse price/depth as executable evidence and never redate an
 * older successful observation.
 */
export function buildKalshiExecutableQuote(
  kalshi: NonNullable<UnifiedOutcome['kalshi']> | null | undefined,
  side: 'yes' | 'no',
  depthTimestamp: string,
  source: KalshiQuoteSourceProvenance = {
    status: 'fresh',
    attemptedAt: depthTimestamp,
    observedAt: depthTimestamp,
  },
): ExecutableBookQuote {
  const sourceReason = source.status === 'source_unavailable'
    ? 'source_unavailable'
    : source.status === 'stale' ? 'stale_book' : undefined;
  const sourceObservedAt = source.observedAt;
  const quote = quoteOneShareFromTopAsk({
    price: side === 'yes' ? kalshi?.yesAsk : kalshi?.noAsk,
    depthUsd: side === 'yes' ? kalshi?.yesAskDepth : kalshi?.noAskDepth,
    tickSize: side === 'yes' ? kalshi?.yesTickSize : kalshi?.noTickSize,
    minimumOrderSize: 1,
    depthTimestamp: source.status === 'fresh' ? depthTimestamp : sourceObservedAt,
    unavailableReason: sourceReason ?? unavailableReason(
      side === 'yes' ? kalshi?.yesAskDepthStatus : kalshi?.noAskDepthStatus,
    ),
  });

  return {
    ...quote,
    sourceStatus: source.status,
    sourceAttemptedAt: source.attemptedAt,
    sourceObservedAt,
    sourceFailureKind: source.failureKind ?? null,
    sourceDetail: source.detail ?? null,
  };
}
