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
  mutuallyExclusiveVerified?: boolean;
  exhaustiveVerified?: boolean;
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

export function buildBotLegIdentity(
  position: PositionIdentitySource,
  metadata: PersistedMarketIdentityMetadata | null | undefined,
): BotPositionIdentity {
  const pairs = metadata?.matchedPairs ?? [];
  // A shared event title is not a venue contract question. Only expose exact,
  // explicitly persisted per-venue questions; never manufacture one by fallback.
  const kalshiQuestion = position.kalshiMarketQuestion?.trim()
    || metadata?.kalshiMarketQuestion?.trim() || null;
  const pmQuestion = position.pmMarketQuestion?.trim()
    || metadata?.pmMarketQuestion?.trim() || null;
  const kalshiOutcome = uniqueOutcome(pairs, 'kalshiTicker', position.kalshiTicker);
  const pmOutcome = uniqueOutcome(pairs, 'pmConditionId', position.pmConditionId);
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
  const text = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportBotPositionIdentitiesCsv(positions: Array<{
  id: number;
  executionId?: number | null;
  kalshiTicker?: string | null;
  pmConditionId?: string | null;
  pmEntryTokenId?: string | null;
  identity: BotPositionIdentity;
}>): string {
  const headers = [
    'Position ID', 'Execution ID', 'Kalshi Question', 'Kalshi Outcome', 'Kalshi Side', 'Kalshi Ticker',
    'Polymarket Question', 'Polymarket Outcome', 'Polymarket Side', 'PM Condition ID', 'PM Token ID',
    'Relationship State', 'Relationship Explanation',
  ];
  const rows = positions.map((position) => [
    position.id, position.executionId,
    position.identity.kalshi.marketQuestion, position.identity.kalshi.outcomeLabel,
    position.identity.kalshi.side.toUpperCase(), position.kalshiTicker,
    position.identity.polymarket.marketQuestion, position.identity.polymarket.outcomeLabel,
    position.identity.polymarket.side.toUpperCase(), position.pmConditionId, position.pmEntryTokenId,
    position.identity.relationship.state, position.identity.relationship.explanation,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
