import type { PropositionRelationship } from './proposition-identity';

export interface OutcomeIdentityPosition {
  id: number;
  status: string;
  openedAt: string;
  kalshiTicker: string | null;
  pmConditionId: string | null;
  pmEntryTokenId: string | null;
  kalshiSide: 'yes' | 'no';
  pmSide: 'yes' | 'no';
  outcomeIdentityStatus: 'verified' | 'unresolved';
  kalshiMarketQuestion?: string | null;
  pmMarketQuestion?: string | null;
  kalshiOutcomeLabel?: string | null;
  pmOutcomeLabel?: string | null;
}

export interface OutcomeIdentityCorrection {
  id: number;
  kalshiTicker: string;
  pmConditionId: string;
  pmEntryTokenId: string;
  kalshiSide: 'yes' | 'no';
  pmSide: 'yes' | 'no';
  kalshiMarketQuestion: string;
  pmMarketQuestion: string;
  kalshiOutcomeLabel: string;
  pmOutcomeLabel: string;
  outcomeIdentitySource: 'canonical_proposition_relationship_v1';
  outcomeIdentityRecordedAt: string;
  previousOutcomeIdentityStatus: 'verified' | 'unresolved';
  previousKalshiMarketQuestion: string | null;
  previousPmMarketQuestion: string | null;
  previousKalshiOutcomeLabel: string | null;
  previousPmOutcomeLabel: string | null;
}

export interface OutcomeIdentityReconciliationPlan {
  corrections: OutcomeIdentityCorrection[];
  unresolved: Array<{
    id: number;
    reason: string;
    kalshiTicker: string | null;
    pmConditionId: string | null;
    pmEntryTokenId: string | null;
    kalshiSide: 'yes' | 'no';
    pmSide: 'yes' | 'no';
    previousOutcomeIdentityStatus: 'verified' | 'unresolved';
    previousKalshiMarketQuestion: string | null;
    previousPmMarketQuestion: string | null;
    previousKalshiOutcomeLabel: string | null;
    previousPmOutcomeLabel: string | null;
  }>;
}

export const BOT_OUTCOME_IDENTITY_COLUMNS: Readonly<Record<string, string>> = {
  kalshi_market_question: 'TEXT',
  pm_market_question: 'TEXT',
  kalshi_outcome_label: 'TEXT',
  pm_outcome_label: 'TEXT',
  outcome_identity_status: "TEXT NOT NULL DEFAULT 'unresolved'",
  outcome_identity_source: 'TEXT',
  outcome_identity_recorded_at: 'TEXT',
  outcome_identity_failure_reason: 'TEXT',
};

type SchemaExecute = (sql: string) => Promise<unknown>;

export async function prepareBotOutcomeIdentitySchema(
  existingColumns: ReadonlySet<string>,
  allowMutation: boolean,
  execute: SchemaExecute,
): Promise<void> {
  const missing = Object.keys(BOT_OUTCOME_IDENTITY_COLUMNS).filter((name) => !existingColumns.has(name));
  if (!allowMutation) return;
  for (const name of missing) {
    await execute(`ALTER TABLE bot_positions ADD COLUMN ${name} ${BOT_OUTCOME_IDENTITY_COLUMNS[name]}`);
  }
}

export function isSqliteIntegrityCheckOk(row: Record<string, unknown> | undefined): boolean {
  return row != null && Object.values(row).some((value) => String(value).toLowerCase() === 'ok');
}

interface ReconciliationTransaction {
  execute(statement: { sql: string; args: Array<string | number | null> }): Promise<{ rowsAffected: number | bigint }>;
}

export async function applyBotOutcomeIdentityReconciliation(
  plan: OutcomeIdentityReconciliationPlan,
  transaction: ReconciliationTransaction,
  auditRecordedAt: string,
): Promise<{ correctionsApplied: number; unresolvedAuditsApplied: number }> {
  let correctionsApplied = 0;
  let unresolvedAuditsApplied = 0;
  for (const correction of plan.corrections) {
    const result = await transaction.execute({
      sql: `UPDATE bot_positions SET kalshi_market_question = ?, pm_market_question = ?,
        kalshi_outcome_label = ?, pm_outcome_label = ?, outcome_identity_status = 'verified',
        outcome_identity_source = ?, outcome_identity_recorded_at = ?, outcome_identity_failure_reason = NULL
        WHERE id = ? AND status = 'open' AND outcome_identity_status = ?
          AND kalshi_ticker = ? AND pm_condition_id = ? AND pm_entry_token_id = ?
          AND kalshi_side = ? AND pm_side = ?
          AND kalshi_market_question IS ? AND pm_market_question IS ?
          AND kalshi_outcome_label IS ? AND pm_outcome_label IS ?`,
      args: [correction.kalshiMarketQuestion, correction.pmMarketQuestion,
        correction.kalshiOutcomeLabel, correction.pmOutcomeLabel, correction.outcomeIdentitySource,
        correction.outcomeIdentityRecordedAt, correction.id, correction.previousOutcomeIdentityStatus,
        correction.kalshiTicker, correction.pmConditionId, correction.pmEntryTokenId,
        correction.kalshiSide, correction.pmSide, correction.previousKalshiMarketQuestion,
        correction.previousPmMarketQuestion, correction.previousKalshiOutcomeLabel,
        correction.previousPmOutcomeLabel],
    });
    if (Number(result.rowsAffected) !== 1) throw new Error(`Position ${correction.id} changed after identity planning`);
    correctionsApplied += 1;
  }
  for (const unresolved of plan.unresolved) {
    const result = await transaction.execute({
      sql: `UPDATE bot_positions SET outcome_identity_status = 'unresolved',
        outcome_identity_failure_reason = ?, outcome_identity_source = 'bug167_exact_identity_audit_v1',
        outcome_identity_recorded_at = ?
        WHERE id = ? AND status = 'open' AND outcome_identity_status = ?
          AND kalshi_ticker IS ? AND pm_condition_id IS ? AND pm_entry_token_id IS ?
          AND kalshi_side = ? AND pm_side = ?
          AND kalshi_market_question IS ? AND pm_market_question IS ?
          AND kalshi_outcome_label IS ? AND pm_outcome_label IS ?`,
      args: [unresolved.reason, auditRecordedAt, unresolved.id,
        unresolved.previousOutcomeIdentityStatus, unresolved.kalshiTicker,
        unresolved.pmConditionId, unresolved.pmEntryTokenId,
        unresolved.kalshiSide, unresolved.pmSide, unresolved.previousKalshiMarketQuestion,
        unresolved.previousPmMarketQuestion, unresolved.previousKalshiOutcomeLabel,
        unresolved.previousPmOutcomeLabel],
    });
    if (Number(result.rowsAffected) !== 1) throw new Error(`Position ${unresolved.id} changed after identity planning`);
    unresolvedAuditsApplied += 1;
  }
  return { correctionsApplied, unresolvedAuditsApplied };
}

type RelationshipResolver = (input: {
  kalshiTicker: string | null;
  pmConditionId: string | null;
  pmTokenId: string | null;
  kalshiSide: 'yes' | 'no';
  pmSide: 'yes' | 'no';
}) => PropositionRelationship | null;

export function planBotOutcomeIdentityReconciliation(
  positions: OutcomeIdentityPosition[],
  resolve: RelationshipResolver,
): OutcomeIdentityReconciliationPlan {
  const corrections: OutcomeIdentityCorrection[] = [];
  const unresolved: OutcomeIdentityReconciliationPlan['unresolved'] = [];
  const persisted = (value: string | null | undefined) => value == null ? null : value;
  const reject = (position: OutcomeIdentityPosition, reason: string) => unresolved.push({
    id: position.id, reason, kalshiTicker: position.kalshiTicker,
    pmConditionId: position.pmConditionId, pmEntryTokenId: position.pmEntryTokenId,
    kalshiSide: position.kalshiSide, pmSide: position.pmSide,
    previousOutcomeIdentityStatus: position.outcomeIdentityStatus,
    previousKalshiMarketQuestion: persisted(position.kalshiMarketQuestion),
    previousPmMarketQuestion: persisted(position.pmMarketQuestion),
    previousKalshiOutcomeLabel: persisted(position.kalshiOutcomeLabel),
    previousPmOutcomeLabel: persisted(position.pmOutcomeLabel),
  });
  for (const position of [...positions].sort((a, b) => a.id - b.id)) {
    if (position.status !== 'open') continue;
    if (!position.kalshiTicker?.trim() || !position.pmConditionId?.trim() || !position.pmEntryTokenId?.trim()) {
      reject(position, 'Immutable execution-time platform market or Polymarket entry-token identity is missing');
      continue;
    }
    const relationship = resolve({
      kalshiTicker: position.kalshiTicker,
      pmConditionId: position.pmConditionId,
      pmTokenId: position.pmEntryTokenId,
      kalshiSide: position.kalshiSide,
      pmSide: position.pmSide,
    });
    if (!relationship) {
      reject(position, 'No server-owned canonical relationship proves the persisted exact entry token, sides, and held outcomes');
      continue;
    }
    const normalized = (value: string | null | undefined) => value?.trim().toLowerCase() ?? '';
    const labelsMatch = normalized(position.kalshiMarketQuestion) === normalized(relationship.legs.kalshi.marketQuestion)
      && normalized(position.pmMarketQuestion) === normalized(relationship.legs.polymarket.marketQuestion)
      && normalized(position.kalshiOutcomeLabel) === normalized(relationship.legs.kalshi.payoutState)
      && normalized(position.pmOutcomeLabel) === normalized(relationship.legs.polymarket.payoutState);
    if (position.outcomeIdentityStatus === 'verified' && labelsMatch) continue;
    corrections.push({
      id: position.id,
      kalshiTicker: position.kalshiTicker,
      pmConditionId: position.pmConditionId,
      pmEntryTokenId: position.pmEntryTokenId,
      kalshiSide: position.kalshiSide,
      pmSide: position.pmSide,
      kalshiMarketQuestion: relationship.legs.kalshi.marketQuestion,
      pmMarketQuestion: relationship.legs.polymarket.marketQuestion,
      kalshiOutcomeLabel: relationship.legs.kalshi.payoutState,
      pmOutcomeLabel: relationship.legs.polymarket.payoutState,
      outcomeIdentitySource: 'canonical_proposition_relationship_v1',
      outcomeIdentityRecordedAt: relationship.verifiedAt,
      previousOutcomeIdentityStatus: position.outcomeIdentityStatus,
      previousKalshiMarketQuestion: persisted(position.kalshiMarketQuestion),
      previousPmMarketQuestion: persisted(position.pmMarketQuestion),
      previousKalshiOutcomeLabel: persisted(position.kalshiOutcomeLabel),
      previousPmOutcomeLabel: persisted(position.pmOutcomeLabel),
    });
  }
  return { corrections, unresolved };
}
