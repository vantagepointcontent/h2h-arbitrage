import type { BotPosition } from './bot-positions';
import {
  currentPriceSnapshotKey,
  getPersistedCurrentPriceBatch,
  type PersistedPriceSnapshot,
  type PriceSnapshotRequest,
} from './current-price-snapshots';

export interface ExactLegPriceSnapshot extends PersistedPriceSnapshot {
  identity: PriceSnapshotRequest;
}

export type IndicativelyValuedBotPosition = BotPosition & {
  currentPriceSnapshots: {
    kalshi: ExactLegPriceSnapshot;
    polymarket: ExactLegPriceSnapshot;
  };
};

function missingSnapshot(status: 'missing_identifier' | 'never_saved'): PersistedPriceSnapshot {
  return {
    status, priceCents: null, priceMicrocents: null, source: null, observedAt: null, ageMs: null,
    executableDepthMicros: null, failureReason: null, markFailureReason: null,
  };
}

function polymarketToken(position: BotPosition): string | null {
  // Only the execution-time entry token identifies the held contract. Exit
  // fee metadata and legacy condition fields may have been populated later.
  return position.pmEntryTokenId?.trim() || null;
}

function exactLegBlocker(platform: 'Kalshi' | 'Polymarket', snapshot: PersistedPriceSnapshot): string {
  if (snapshot.status === 'missing_identifier') return `${platform} exact market identifier is missing`;
  if (snapshot.status === 'side_mismatch') return `${platform} exact held side/token snapshot is missing`;
  if (snapshot.status === 'never_saved') return `${platform} exact held-side scan snapshot has never been recorded`;
  return `${platform} last-scanned price is unavailable`;
}

function roundedRatio(numerator: bigint, denominator: bigint): number {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  const value = Number(negative ? -rounded : rounded);
  if (!Number.isSafeInteger(value)) throw new Error('Indicative mark exceeds safe integer range');
  return value;
}

function snapshotMicrocents(snapshot: PersistedPriceSnapshot): number | null {
  if (Number.isSafeInteger(snapshot.priceMicrocents)
    && snapshot.priceMicrocents! >= 0 && snapshot.priceMicrocents! <= 100_000_000) {
    return snapshot.priceMicrocents!;
  }
  return Number.isSafeInteger(snapshot.priceCents)
    && snapshot.priceCents! >= 0 && snapshot.priceCents! <= 100
    ? snapshot.priceCents! * 1_000_000
    : null;
}

function applyPersistedIndicativeValuation(
  position: BotPosition,
  kalshi: PersistedPriceSnapshot,
  polymarket: PersistedPriceSnapshot,
): BotPosition {
  if (position.status !== 'open') return position;
  if (position.outcomeIdentityStatus !== 'verified'
    || !position.kalshiOutcomeLabel?.trim() || !position.pmOutcomeLabel?.trim()) {
    return {
      ...position,
      currentPriceKalshiCents: null,
      currentPricePmCents: null,
      currentValueCents: null,
      unrealizedPnlCents: null,
      unrealizedRoiBps: null,
      valuationStatus: 'unavailable',
      valuationFailureReason: position.outcomeIdentityFailureReason?.trim()
        || 'Immutable execution-time held outcome identity is unresolved',
    };
  }
  const available = (snapshot: PersistedPriceSnapshot) =>
    (snapshot.status === 'available' || snapshot.status === 'stale')
    && snapshotMicrocents(snapshot) != null
    && snapshot.observedAt != null && Number.isFinite(Date.parse(snapshot.observedAt));
  if (!available(kalshi) || !available(polymarket)) {
    const blockers = [
      ...(!available(kalshi) ? [exactLegBlocker('Kalshi', kalshi)] : []),
      ...(!available(polymarket) ? [exactLegBlocker('Polymarket', polymarket)] : []),
    ];
    return {
      ...position,
      currentPriceKalshiCents: available(kalshi) ? kalshi.priceCents : null,
      currentPricePmCents: available(polymarket) ? polymarket.priceCents : null,
      currentValueCents: null,
      unrealizedPnlCents: null,
      unrealizedRoiBps: null,
      valuationStatus: 'unavailable',
      valuationFailureReason: blockers.join('; '),
    };
  }

  const kalshiQuantity = position.remainingSharesKalshi;
  const pmQuantity = position.remainingSharesPm;
  if (!Number.isSafeInteger(kalshiQuantity) || kalshiQuantity < 0
    || !Number.isSafeInteger(pmQuantity) || pmQuantity < 0) {
    return {
      ...position,
      currentValueCents: null,
      unrealizedPnlCents: null,
      unrealizedRoiBps: null,
      valuationStatus: 'unavailable',
      valuationFailureReason: 'Persisted held quantity is unavailable',
    };
  }
  const indicativeValueMicrocents = Number(
    BigInt(snapshotMicrocents(kalshi)!) * BigInt(kalshiQuantity)
      + BigInt(snapshotMicrocents(polymarket)!) * BigInt(pmQuantity),
  );
  if (!Number.isSafeInteger(indicativeValueMicrocents)) throw new Error('Indicative current value exceeds safe integer range');
  const currentValueCents = roundedRatio(BigInt(indicativeValueMicrocents), 1_000_000n);
  const lastValuationAt = [kalshi.observedAt!, polymarket.observedAt!].sort()[0];
  const stale = kalshi.status === 'stale' || polymarket.status === 'stale';
  const valuationFailureReason = stale
    ? [kalshi, polymarket].filter((snapshot) => snapshot.status === 'stale').map((snapshot) => {
      const platform = snapshot === kalshi ? 'Kalshi' : 'Polymarket';
      const age = snapshot.ageMs == null ? 'unknown age' : `${Math.floor(snapshot.ageMs / 60_000)}m old`;
      const failure = snapshot.markFailureReason ? `; ${snapshot.markFailureReason}` : '';
      return `${platform} Stale last-scanned mark (${age}, ${snapshot.source ?? 'unknown source'}${failure})`;
    }).join('; ')
    : null;
  // BUG-160 defines Buy Cost as immutable persisted entry cost. Do not switch
  // this mark-to-market formula to remaining basis or executable close cost.
  const buyCostMicrocents = Number.isSafeInteger(position.totalCostMicrousd) && position.totalCostMicrousd! >= 0
    ? position.totalCostMicrousd! * 100
    : Number.isSafeInteger(position.totalCostCents) && position.totalCostCents >= 0
      ? position.totalCostCents * 1_000_000
      : null;
  const entryAvailable = position.entryCostStatus === 'available'
    && buyCostMicrocents != null && Number.isSafeInteger(buyCostMicrocents);
  const indicativePnlMicrocents = entryAvailable ? indicativeValueMicrocents - buyCostMicrocents : null;
  const unrealizedPnlCents = indicativePnlMicrocents == null
    ? null
    : roundedRatio(BigInt(indicativePnlMicrocents), 1_000_000n);
  const unrealizedRoiBps = indicativePnlMicrocents != null && buyCostMicrocents! > 0
    ? roundedRatio(BigInt(indicativePnlMicrocents) * 10_000n, BigInt(buyCostMicrocents!))
    : null;
  return {
    ...position,
    currentPriceKalshiCents: kalshi.priceCents,
    currentPricePmCents: polymarket.priceCents,
    currentValueCents,
    indicativeValueMicrocents,
    ...(buyCostMicrocents == null ? {} : { indicativeBuyCostMicrocents: buyCostMicrocents }),
    ...(indicativePnlMicrocents == null ? {} : { indicativePnlMicrocents }),
    lastValuationAt,
    valuationStatus: stale ? 'stale' : 'current',
    valuationFailureReason,
    valuationFailureAt: stale ? [kalshi, polymarket]
      .filter((snapshot) => snapshot.status === 'stale')
      .map((snapshot) => snapshot.observedAt!)
      .sort().at(-1) ?? lastValuationAt : null,
    unrealizedPnlCents,
    unrealizedRoiBps,
  };
}

export async function enrichBotPositionsWithPersistedIndicativeValuation(
  positions: BotPosition[],
): Promise<IndicativelyValuedBotPosition[]> {
  const legRequests = positions.flatMap((position): PriceSnapshotRequest[] => [
    { platform: 'kalshi', marketId: position.kalshiTicker, side: position.kalshiSide, tokenId: null },
    { platform: 'polymarket', marketId: position.pmConditionId, side: position.pmSide, tokenId: polymarketToken(position) },
  ]);
  const deduplicatedLegs = [...new Map(legRequests.map((leg) => [currentPriceSnapshotKey(leg), leg])).values()];
  const priceSnapshots = await getPersistedCurrentPriceBatch(deduplicatedLegs);
  const snapshotFor = (leg: PriceSnapshotRequest) => priceSnapshots.get(currentPriceSnapshotKey(leg))
    ?? missingSnapshot(leg.marketId ? 'never_saved' : 'missing_identifier');
  return positions.map((position) => {
    const kalshiLeg = { platform: 'kalshi' as const, marketId: position.kalshiTicker, side: position.kalshiSide, tokenId: null };
    const polymarketLeg = { platform: 'polymarket' as const, marketId: position.pmConditionId, side: position.pmSide, tokenId: polymarketToken(position) };
    const kalshiSnapshot = snapshotFor(kalshiLeg);
    const polymarketSnapshot = snapshotFor(polymarketLeg);
    return {
      ...applyPersistedIndicativeValuation(position, kalshiSnapshot, polymarketSnapshot),
      currentPriceSnapshots: {
        kalshi: { ...kalshiSnapshot, identity: kalshiLeg },
        polymarket: { ...polymarketSnapshot, identity: polymarketLeg },
      },
    };
  });
}
