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
