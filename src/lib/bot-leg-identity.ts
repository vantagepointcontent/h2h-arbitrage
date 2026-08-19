export type BotLegRelationshipState =
  | 'verified_complementary'
  | 'same_direction'
  | 'invalid'
  | 'legacy_unknown';

export interface BotLegIdentity {
  marketQuestion: string | null;
  outcomeLabel: string | null;
  side: 'yes' | 'no';
  metadataStatus: 'available' | 'missing';
}

export interface BotPositionIdentity {
  kalshi: BotLegIdentity;
  polymarket: BotLegIdentity;
  relationship: {
    state: BotLegRelationshipState;
    label: string;
    explanation: string;
  };
}

interface PositionIdentitySource {
  marketTitle?: string | null;
  kalshiMarketQuestion?: string | null;
  pmMarketQuestion?: string | null;
  kalshiOutcomeLabel?: string | null;
  pmOutcomeLabel?: string | null;
  relationshipState?: BotLegRelationshipState | null;
  relationshipExplanation?: string | null;
  kalshiTicker?: string | null;
  pmConditionId?: string | null;
  kalshiSide: 'yes' | 'no';
  pmSide: 'yes' | 'no';
}

interface PersistedMarketIdentityMetadata {
  eventTitle?: string | null;
  kalshiMarketQuestion?: string | null;
  pmMarketQuestion?: string | null;
  matchedPairs?: Array<{
    artist?: string | null;
    kalshiTicker?: string | null;
    pmConditionId?: string | null;
  }> | null;
  allArbs?: Array<{
    artist?: string | null;
    kalshiTicker?: string | null;
    pmConditionId?: string | null;
    kalshiMarketQuestion?: string | null;
    pmMarketQuestion?: string | null;
  }> | null;
  mutuallyExclusiveVerified?: boolean;
  exhaustiveVerified?: boolean;
}

function canonicalRelationship(
  state: BotLegRelationshipState,
  persistedExplanation?: string | null,
): BotPositionIdentity['relationship'] {
  const explanation = persistedExplanation?.trim();
  switch (state) {
    case 'verified_complementary':
      return { state, label: 'Verified complementary', explanation: explanation || 'The backend canonically verified the exact persisted legs as complementary propositions.' };
    case 'same_direction':
      return { state, label: 'Same-direction', explanation: explanation || 'The backend canonically classified the exact persisted legs as the same-direction proposition.' };
    case 'invalid':
      return { state, label: 'Invalid relationship', explanation: explanation || 'The backend canonically classified the exact persisted leg relationship as invalid.' };
    default:
      return { state, label: 'Legacy / unknown', explanation: explanation || 'No canonical persisted relationship state is available; no relationship was inferred.' };
  }
}

const normalize = (value: string | null | undefined) => value?.trim().toLocaleLowerCase() ?? '';

function uniqueOutcome(
  pairs: NonNullable<PersistedMarketIdentityMetadata['matchedPairs']>,
  key: 'kalshiTicker' | 'pmConditionId',
  identifier: string | null | undefined,
): string | null {
  const target = normalize(identifier);
  if (!target) return null;
  const labels = [...new Set(pairs
    .filter((pair) => normalize(pair[key]) === target)
    .map((pair) => pair.artist?.trim())
    .filter((label): label is string => Boolean(label)))];
  return labels.length === 1 ? labels[0] : null;
}

function uniqueMetadataValue(
  rows: NonNullable<PersistedMarketIdentityMetadata['allArbs']>,
  key: 'kalshiTicker' | 'pmConditionId',
  identifier: string | null | undefined,
  valueKey: 'kalshiMarketQuestion' | 'pmMarketQuestion',
): string | null {
  const target = normalize(identifier);
  if (!target) return null;
  const values = [...new Set(rows
    .filter((row) => normalize(row[key]) === target)
    .map((row) => row[valueKey]?.trim())
    .filter((value): value is string => Boolean(value)))];
  return values.length === 1 ? values[0] : null;
}

export function buildBotLegIdentity(
  position: PositionIdentitySource,
  metadata: PersistedMarketIdentityMetadata | null | undefined,
): BotPositionIdentity {
  const pairs = [...(metadata?.matchedPairs ?? []), ...(metadata?.allArbs ?? [])];
  // A shared event title is not a venue contract question. Only expose exact,
  // explicitly persisted per-venue questions; never manufacture one by fallback.
  const arbs = metadata?.allArbs ?? [];
  const kalshiQuestion = position.kalshiMarketQuestion?.trim()
    || uniqueMetadataValue(arbs, 'kalshiTicker', position.kalshiTicker, 'kalshiMarketQuestion')
    || metadata?.kalshiMarketQuestion?.trim() || null;
  const pmQuestion = position.pmMarketQuestion?.trim()
    || uniqueMetadataValue(arbs, 'pmConditionId', position.pmConditionId, 'pmMarketQuestion')
    || metadata?.pmMarketQuestion?.trim() || null;
  const kalshiOutcome = position.kalshiOutcomeLabel?.trim()
    || uniqueOutcome(pairs, 'kalshiTicker', position.kalshiTicker);
  const pmOutcome = position.pmOutcomeLabel?.trim()
    || uniqueOutcome(pairs, 'pmConditionId', position.pmConditionId);
  const kalshi: BotLegIdentity = {
    marketQuestion: kalshiQuestion,
    outcomeLabel: kalshiOutcome,
    side: position.kalshiSide,
    metadataStatus: kalshiOutcome && kalshiQuestion ? 'available' : 'missing',
  };
  const polymarket: BotLegIdentity = {
    marketQuestion: pmQuestion,
    outcomeLabel: pmOutcome,
    side: position.pmSide,
    metadataStatus: pmOutcome && pmQuestion ? 'available' : 'missing',
  };

  if (position.relationshipState) {
    return {
      kalshi,
      polymarket,
      relationship: canonicalRelationship(position.relationshipState, position.relationshipExplanation),
    };
  }

  if (!kalshiOutcome || !pmOutcome) {
    return {
      kalshi,
      polymarket,
      relationship: {
        state: 'legacy_unknown',
        label: 'Legacy / unknown',
        explanation: 'Outcome metadata missing for one or both exact persisted leg identifiers; no relationship was inferred.',
      },
    };
  }

  const sameOutcome = normalize(kalshiOutcome) === normalize(pmOutcome);
  const sameSide = position.kalshiSide === position.pmSide;
  if (sameOutcome && sameSide) {
    return {
      kalshi,
      polymarket,
      relationship: {
        state: 'same_direction',
        label: 'Same-direction',
        explanation: 'Both exact persisted legs select the same outcome and contract side, so they gain and lose together.',
      },
    };
  }
  if (sameOutcome && !sameSide
      && metadata?.mutuallyExclusiveVerified === true && metadata.exhaustiveVerified === true) {
    return {
      kalshi,
      polymarket,
      relationship: {
        state: 'verified_complementary',
        label: 'Verified complementary',
        explanation: 'The exact persisted legs select opposite YES/NO sides of the same matched proposition.',
      },
    };
  }
  if (sameSide && metadata?.mutuallyExclusiveVerified === true && metadata.exhaustiveVerified === true) {
    return {
      kalshi,
      polymarket,
      relationship: {
        state: 'verified_complementary',
        label: 'Verified complementary',
        explanation: 'The backend verified the distinct selected outcomes as mutually exclusive and exhaustive propositions.',
      },
    };
  }
  if (metadata?.mutuallyExclusiveVerified !== true || metadata.exhaustiveVerified !== true) {
    return {
      kalshi,
      polymarket,
      relationship: {
        state: 'legacy_unknown',
        label: 'Legacy / unknown',
        explanation: 'Exact outcomes are available, but no persisted backend relationship verification exists; no relationship was inferred.',
      },
    };
  }
  return {
    kalshi,
    polymarket,
    relationship: {
      state: 'invalid',
      label: 'Invalid relationship',
      explanation: 'Exact outcome metadata is present, but the persisted sides and propositions are not a verified complementary pair.',
    },
  };
}

function csvCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  // RFC 4180 quoting alone does not prevent spreadsheet formula execution.
  // Numeric financial values (including losses) are safe cells; only
  // untrusted strings need formula neutralization.
  const text = typeof value === 'string' && /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportBotPositionIdentitiesCsv(positions: Array<{
  id: number;
  executionId?: number | null;
  kalshiTicker?: string | null;
  pmConditionId?: string | null;
  pmEntryTokenId?: string | null;
  identity: BotPositionIdentity;
  relationshipValidity?: string | null;
  exposureIdentityStatus?: string | null;
  exposureValuationLabel?: string | null;
  excludedFromVerifiedTotals?: boolean;
  legacyExposureReason?: string | null;
  legacyExposureRevision?: string | null;
  legacyExposureEvidence?: Array<{ source: string; revision: string; capturedAt: string; confidence: string }>;
  buyPriceMicrocents?: number | null;
  buyCostMicrocents?: number | null;
  entryArbProfitSnapshot?: {
    status: 'available' | 'unavailable';
    profitMicrousd?: number;
    currency?: string;
    matchedQuantityMicrounits?: number;
    guaranteedPayoutMicrousd?: number;
    entryRoi?: { numeratorMicrousd: number; denominatorMicrousd: number };
    formulaVersion?: number;
    provenance?: string;
    reason?: string;
  };
  indicativeValueMicrocents?: number | null;
  indicativePnlMicrocents?: number | null;
  unrealizedRoiBps?: number | null;
  valuationStatus?: 'current' | 'stale' | 'unavailable';
  valuationFailureReason?: string | null;
  lastValuationAt?: string | null;
  settlementState?: string | null;
  settlementGrossProceedsCents?: number | null;
  settlementNetProceedsCents?: number | null;
  settlementFailureReason?: string | null;
  settlementCashAvailableAt?: string | null;
  realizedPnlCents?: number | null;
  realizedRoiBps?: number | null;
  currentPriceSnapshots?: {
    kalshi: {
      identity: { platform: string; marketId: string | null; side: string; tokenId: string | null };
      status: string; priceMicrocents?: number | null; priceCents: number | null;
      source: string | null; observedAt: string | null;
    };
    polymarket: {
      identity: { platform: string; marketId: string | null; side: string; tokenId: string | null };
      status: string; priceMicrocents?: number | null; priceCents: number | null;
      source: string | null; observedAt: string | null;
    };
  };
}>): string {
  const headers = [
    'Row Type', 'Position ID', 'Execution ID', 'Kalshi Question', 'Kalshi Outcome', 'Kalshi Side', 'Kalshi Ticker',
    'Polymarket Question', 'Polymarket Outcome', 'Polymarket Side', 'PM Condition ID', 'PM Token ID',
    'Relationship State', 'Relationship Explanation',
    'Relationship Validity', 'Exposure Identity', 'Exposure Valuation Class', 'Excluded From Verified Totals',
    'Legacy Exposure Reason', 'Legacy Exposure Revision', 'Legacy Exposure Evidence Provenance',
    'Buy Price Microcents', 'Buy Cost Microcents',
    'Entry Arb Profit Microusd', 'Entry Arb Profit Status', 'Entry Arb Profit Unavailable Reason',
    'Entry Arb Profit Currency', 'Entry Matched Quantity Microunits', 'Entry Guaranteed Payout Microusd',
    'Entry ROI Numerator Microusd', 'Entry ROI Denominator Microusd',
    'Entry Arb Formula Version', 'Entry Arb Provenance',
    'Kalshi Current Price Microcents',
    'PM Current Price Microcents', 'Current Value Microcents', 'P/L Microcents', 'ROI BPS',
    'Valuation Included', 'Valuation Status', 'Valuation Failure Reason', 'Valuation As Of',
    'Kalshi Snapshot Platform', 'Kalshi Snapshot Market ID', 'Kalshi Snapshot Side', 'Kalshi Snapshot Token ID',
    'Kalshi Snapshot Status', 'Kalshi Snapshot Source', 'Kalshi Snapshot Observed At',
    'PM Snapshot Platform', 'PM Snapshot Market ID', 'PM Snapshot Side', 'PM Snapshot Token ID',
    'PM Snapshot Status', 'PM Snapshot Source', 'PM Snapshot Observed At',
    'Settlement State', 'Gross Settlement Proceeds Cents', 'Net Settlement Proceeds Cents',
    'Realized P/L Cents', 'Realized ROI BPS', 'Settlement Failure Reason', 'Cash Available At',
  ];
  const included = (position: (typeof positions)[number]) =>
    position.excludedFromVerifiedTotals !== true
    &&
    (position.valuationStatus === 'current' || position.valuationStatus === 'stale')
    && Number.isSafeInteger(position.buyPriceMicrocents)
    && Number.isSafeInteger(position.buyCostMicrocents) && position.buyCostMicrocents! > 0
    && Number.isSafeInteger(position.indicativeValueMicrocents)
    && Number.isSafeInteger(position.indicativePnlMicrocents)
    && Number.isSafeInteger(position.unrealizedRoiBps);
  const snapshotPrice = (snapshot: NonNullable<(typeof positions)[number]['currentPriceSnapshots']>['kalshi'] | undefined) => {
    if (!snapshot) return null;
    if (Number.isSafeInteger(snapshot.priceMicrocents)) return snapshot.priceMicrocents!;
    return snapshot.priceCents != null && Number.isSafeInteger(snapshot.priceCents)
      ? snapshot.priceCents * 1_000_000 : null;
  };
  const snapshotCells = (snapshot: NonNullable<(typeof positions)[number]['currentPriceSnapshots']>['kalshi'] | undefined) => [
    snapshot?.identity.platform, snapshot?.identity.marketId, snapshot?.identity.side.toUpperCase(),
    snapshot?.identity.tokenId, snapshot?.status, snapshot?.source, snapshot?.observedAt,
  ];
  const rows = positions.map((position) => {
    const valuationIncluded = included(position);
    const entryArb = position.entryArbProfitSnapshot;
    const entryArbAvailable = entryArb?.status === 'available';
    return [
    'POSITION', position.id, position.executionId,
    position.identity.kalshi.marketQuestion, position.identity.kalshi.outcomeLabel,
    position.identity.kalshi.side.toUpperCase(), position.kalshiTicker,
    position.identity.polymarket.marketQuestion, position.identity.polymarket.outcomeLabel,
    position.identity.polymarket.side.toUpperCase(), position.pmConditionId, position.pmEntryTokenId,
    position.identity.relationship.state, position.identity.relationship.explanation,
    position.relationshipValidity, position.exposureIdentityStatus, position.exposureValuationLabel,
    position.excludedFromVerifiedTotals === true ? 'yes' : 'no', position.legacyExposureReason, position.legacyExposureRevision,
    position.legacyExposureEvidence?.map((evidence) =>
      `${evidence.source}|${evidence.revision}|${evidence.capturedAt}|${evidence.confidence}`).join(';') ?? null,
    position.buyPriceMicrocents, position.buyCostMicrocents,
    entryArbAvailable ? entryArb.profitMicrousd : null,
    entryArb?.status ?? 'unavailable', entryArbAvailable ? null : entryArb?.reason ?? 'Entry Arb Profit unavailable: placement snapshot missing',
    entryArbAvailable ? entryArb.currency : null,
    entryArbAvailable ? entryArb.matchedQuantityMicrounits : null,
    entryArbAvailable ? entryArb.guaranteedPayoutMicrousd : null,
    entryArbAvailable ? entryArb.entryRoi?.numeratorMicrousd : null,
    entryArbAvailable ? entryArb.entryRoi?.denominatorMicrousd : null,
    entryArbAvailable ? entryArb.formulaVersion : null, entryArb?.provenance,
    valuationIncluded ? snapshotPrice(position.currentPriceSnapshots?.kalshi) : null,
    valuationIncluded ? snapshotPrice(position.currentPriceSnapshots?.polymarket) : null,
    valuationIncluded ? position.indicativeValueMicrocents : null,
    valuationIncluded ? position.indicativePnlMicrocents : null,
    valuationIncluded ? position.unrealizedRoiBps : null,
    valuationIncluded ? 'yes' : 'no', position.valuationStatus, position.valuationFailureReason,
    valuationIncluded ? position.lastValuationAt : null,
    ...snapshotCells(position.currentPriceSnapshots?.kalshi),
    ...snapshotCells(position.currentPriceSnapshots?.polymarket),
    position.settlementState, position.settlementGrossProceedsCents,
    position.settlementNetProceedsCents, position.realizedPnlCents, position.realizedRoiBps,
    position.settlementFailureReason, position.settlementCashAvailableAt,
  ];
  });
  const valued = positions.filter(included);
  const total = (key: 'buyPriceMicrocents' | 'buyCostMicrocents' | 'indicativeValueMicrocents' | 'indicativePnlMicrocents') =>
    valued.reduce((sum, position) => sum + position[key]!, 0);
  const totalBuyPrice = total('buyPriceMicrocents');
  const totalBuyCost = total('buyCostMicrocents');
  const totalValue = total('indicativeValueMicrocents');
  const totalPnl = total('indicativePnlMicrocents');
  const totalRoiBps = totalBuyCost > 0
    ? Number((BigInt(totalPnl) * 10_000n + BigInt(totalPnl < 0 ? -totalBuyCost : totalBuyCost) / 2n) / BigInt(totalBuyCost))
    : null;
  const totalRow = [
    'TOTAL', null, null, null, null, null, null, null, null, null, null, null,
    null, `${valued.length} valued position(s); unavailable positions excluded`,
    ...Array(7).fill(null),
    totalBuyPrice, totalBuyCost, ...Array(10).fill(null), null, null, totalValue, totalPnl, totalRoiBps,
    null, null, null, null,
    ...Array(14).fill(null),
    null,
    positions.filter((position) => position.settlementState === 'settled')
      .reduce((sum, position) => sum + (position.settlementGrossProceedsCents ?? 0), 0),
    positions.filter((position) => position.settlementState === 'settled')
      .reduce((sum, position) => sum + (position.settlementNetProceedsCents ?? 0), 0),
    positions.filter((position) => position.settlementState === 'settled')
      .reduce((sum, position) => sum + (position.realizedPnlCents ?? 0), 0),
    null, null, null,
  ];
  return [headers, ...rows, totalRow].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
