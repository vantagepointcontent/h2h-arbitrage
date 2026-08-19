import { createHash } from 'node:crypto';

export type RelationshipValidity =
  | 'verified_complementary'
  | 'confirmed_invalid'
  | 'unresolved_relationship'
  | 'non_exhaustive_conflicting';
export type ExposureIdentityVerdict =
  | 'exact_held_legs_proven'
  | 'partially_proven'
  | 'no_fill_rolled_back'
  | 'unrecoverable';
export type ExposureValuationClass =
  | 'verified_arbitrage'
  | 'invalid_unverified_exposure'
  | 'unavailable';

export interface LegacyExposurePositionEvidence {
  position: {
    id: number;
    executionId: number;
    executionMode: 'paper' | 'live';
    status: string;
    openedAt: string;
    kalshiTicker: string | null;
    pmConditionId: string | null;
    pmEntryTokenId: string | null;
    kalshiSide: 'yes' | 'no';
    pmSide: 'yes' | 'no';
    sharesKalshi: number;
    sharesPm: number;
    outcomeIdentityStatus: 'verified' | 'unresolved';
    propositionRelationshipState: string;
    legacyExposureRevision: string | null;
  };
  execution: {
    id: number;
    timestamp: string;
    dryRun: boolean;
    success: boolean;
    kalshiOrder: {
      marketId?: unknown;
      ticker?: unknown;
      outcome?: unknown;
      contracts?: unknown;
    } | null;
    polymarketOrder: {
      marketId?: unknown;
      conditionId?: unknown;
      outcome?: unknown;
      contracts?: unknown;
    } | null;
    result: {
      success?: unknown;
      rollbackExecuted?: unknown;
      unhedged?: unknown;
      kalshiResult?: { status?: unknown; filledContracts?: unknown; orderId?: unknown } | null;
      polymarketResult?: { status?: unknown; filledContracts?: unknown; orderId?: unknown } | null;
    } | null;
  } | null;
  relationshipAuthority: {
    verdict: RelationshipValidity;
    source: string;
    sourceRevision: string;
    capturedAt: string;
    kalshiMarketQuestion: string | null;
    pmMarketQuestion: string | null;
    kalshiOutcomeLabel: string | null;
    pmOutcomeLabel: string | null;
  } | null;
  pmTokenAuthority: {
    tokenId: string;
    marketId: string;
    side: 'yes' | 'no';
    source: string;
    sourceRevision: string;
    capturedAt: string;
  } | null;
  /** Deliberately excluded from classification; retained only in forensic reports. */
  nonAuthoritativeContext?: Record<string, unknown>;
}

export interface LegacyExposureVerdict {
  version: 1;
  relationshipValidity: RelationshipValidity;
  exposureIdentity: ExposureIdentityVerdict;
  valuationClass: ExposureValuationClass;
  executionMode: 'paper' | 'live';
  simulated: boolean;
  exactLegs: {
    kalshi: {
      marketId: string | null;
      tokenId: null;
      side: 'yes' | 'no';
      requestedQuantity: number | null;
      filledQuantity: number | null;
      orderId: string | null;
      marketQuestion: string | null;
      outcomeLabel: string | null;
    };
    polymarket: {
      marketId: string | null;
      tokenId: string | null;
      side: 'yes' | 'no';
      requestedQuantity: number | null;
      filledQuantity: number | null;
      orderId: string | null;
      marketQuestion: string | null;
      outcomeLabel: string | null;
    };
  };
  reason: string;
  evidence: Array<{
    source: string;
    revision: string;
    capturedAt: string;
    confidence: 'canonical' | 'exact_immutable_execution' | 'fingerprinted_audit';
  }>;
  excludedFromVerifiedTotals: boolean;
  tradeAuthorization: 'denied';
  closeAuthorization: 'denied';
  revision: string;
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

export function legacyExposureEvidenceRevision(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function exactString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function exactQuantity(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function exactSide(value: unknown, expected: 'yes' | 'no'): boolean {
  return exactString(value)?.toLowerCase() === expected;
}

function terminalZero(result: { status?: unknown; filledContracts?: unknown } | null | undefined): boolean {
  const status = exactString(result?.status)?.toLowerCase();
  return exactQuantity(result?.filledContracts) === 0
    && (status === 'cancelled' || status === 'canceled' || status === 'failed' || status === 'rejected');
}

export function classifyLegacyExposure(input: LegacyExposurePositionEvidence): LegacyExposureVerdict {
  const { position, execution, relationshipAuthority, pmTokenAuthority } = input;
  const relationshipValidity = relationshipAuthority?.verdict ?? 'unresolved_relationship';
  const kalshiOrderMarket = exactString(execution?.kalshiOrder?.ticker)
    ?? exactString(execution?.kalshiOrder?.marketId);
  const exactKalshiMarket = exactString(position.kalshiTicker);
  const exactPmMarket = exactString(position.pmConditionId);
  const authorityToken = exactString(pmTokenAuthority?.tokenId);
  const requestedPmToken = exactString(execution?.polymarketOrder?.marketId);
  const persistedPmToken = exactString(position.pmEntryTokenId);
  const authorityBindsRecordedToken = authorityToken != null
    && (requestedPmToken === authorityToken || persistedPmToken === authorityToken);
  const exactPmToken = authorityToken && /^\d+$/.test(authorityToken)
    && authorityBindsRecordedToken
    && exactPmMarket != null
    && exactString(pmTokenAuthority?.marketId)?.toLowerCase() === exactPmMarket.toLowerCase()
    && pmTokenAuthority?.side === position.pmSide
    ? authorityToken : null;
  const kalshiFill = exactQuantity(execution?.result?.kalshiResult?.filledContracts);
  const pmFill = exactQuantity(execution?.result?.polymarketResult?.filledContracts);
  const kalshiOrderBound = exactKalshiMarket != null && kalshiOrderMarket != null
    && exactKalshiMarket.toLowerCase() === kalshiOrderMarket.toLowerCase()
    && exactSide(execution?.kalshiOrder?.outcome, position.kalshiSide);
  const pmOrderBound = exactPmMarket != null && exactPmToken != null
    && exactSide(execution?.polymarketOrder?.outcome, position.pmSide);
  const rollbackProven = execution?.result?.rollbackExecuted === true
    && execution.result.unhedged === false;
  const noFillProven = terminalZero(execution?.result?.kalshiResult)
    && terminalZero(execution?.result?.polymarketResult);
  const bothPositiveFills = kalshiFill != null && kalshiFill > 0 && pmFill != null && pmFill > 0;
  const bothLegsBound = kalshiOrderBound && pmOrderBound;

  let exposureIdentity: ExposureIdentityVerdict;
  let reason: string;
  if (rollbackProven || noFillProven) {
    exposureIdentity = 'no_fill_rolled_back';
    reason = rollbackProven
      ? 'Immutable execution evidence records a completed rollback with no unhedged remainder'
      : 'Both immutable venue results terminally record zero fills';
  } else if (bothLegsBound && bothPositiveFills) {
    exposureIdentity = 'exact_held_legs_proven';
    reason = 'Immutable execution requests and per-venue fill results prove both exact held legs';
  } else if (execution && (kalshiOrderBound || pmOrderBound || kalshiFill != null || pmFill != null)) {
    exposureIdentity = 'partially_proven';
    reason = !exactPmToken
      ? 'Polymarket entry token is missing or not independently bound to the exact persisted market and held side'
      : 'Only part of the exact held-leg or fill identity is proven';
  } else {
    exposureIdentity = 'unrecoverable';
    reason = 'No complete immutable execution request and fill evidence can be bound to the persisted position';
  }

  const valuationClass: ExposureValuationClass = exposureIdentity !== 'exact_held_legs_proven'
    ? 'unavailable'
    : relationshipValidity === 'verified_complementary'
      ? 'verified_arbitrage'
      : 'invalid_unverified_exposure';
  const authoritativeLabels = relationshipAuthority != null;
  const evidence: LegacyExposureVerdict['evidence'] = [];
  if (execution) {
    evidence.push({
      source: `executions:${execution.id}`,
      revision: legacyExposureEvidenceRevision(execution),
      capturedAt: execution.timestamp,
      confidence: 'exact_immutable_execution',
    });
  }
  if (relationshipAuthority) {
    evidence.push({
      source: relationshipAuthority.source,
      revision: relationshipAuthority.sourceRevision,
      capturedAt: relationshipAuthority.capturedAt,
      confidence: relationshipAuthority.verdict === 'verified_complementary' ? 'canonical' : 'fingerprinted_audit',
    });
  }
  if (pmTokenAuthority) {
    evidence.push({
      source: pmTokenAuthority.source,
      revision: pmTokenAuthority.sourceRevision,
      capturedAt: pmTokenAuthority.capturedAt,
      confidence: 'fingerprinted_audit',
    });
  }
  const withoutRevision = {
    version: 1 as const,
    relationshipValidity,
    exposureIdentity,
    valuationClass,
    executionMode: position.executionMode,
    simulated: position.executionMode === 'paper',
    exactLegs: {
      kalshi: {
        marketId: exactKalshiMarket,
        tokenId: null,
        side: position.kalshiSide,
        requestedQuantity: exactQuantity(execution?.kalshiOrder?.contracts),
        filledQuantity: kalshiFill,
        orderId: exactString(execution?.result?.kalshiResult?.orderId),
        marketQuestion: authoritativeLabels ? relationshipAuthority.kalshiMarketQuestion : null,
        outcomeLabel: authoritativeLabels ? relationshipAuthority.kalshiOutcomeLabel : null,
      },
      polymarket: {
        marketId: exactPmMarket,
        tokenId: exactPmToken,
        side: position.pmSide,
        requestedQuantity: exactQuantity(execution?.polymarketOrder?.contracts),
        filledQuantity: pmFill,
        orderId: exactString(execution?.result?.polymarketResult?.orderId),
        marketQuestion: authoritativeLabels ? relationshipAuthority.pmMarketQuestion : null,
        outcomeLabel: authoritativeLabels ? relationshipAuthority.pmOutcomeLabel : null,
      },
    },
    reason,
    evidence,
    excludedFromVerifiedTotals: valuationClass !== 'verified_arbitrage',
    tradeAuthorization: 'denied' as const,
    closeAuthorization: 'denied' as const,
  };
  return { ...withoutRevision, revision: legacyExposureEvidenceRevision(withoutRevision) };
}

export interface LegacyExposureReconciliationDecision {
  positionId: number;
  expectedRevision: string | null;
  before: LegacyExposureVerdict | null;
  after: LegacyExposureVerdict;
}

interface ReconciliationTransaction {
  execute(statement: { sql: string; args: Array<string | number | null> }): Promise<{ rowsAffected: number | bigint }>;
}

export async function applyLegacyExposureReconciliation(
  decisions: LegacyExposureReconciliationDecision[],
  transaction: ReconciliationTransaction,
  runId: string,
): Promise<{ applied: number }> {
  let applied = 0;
  for (const decision of decisions) {
    const result = await transaction.execute({
      sql: `UPDATE bot_positions SET relationship_validity = ?, exposure_identity_status = ?,
        legacy_exposure_verdict_json = ?, legacy_exposure_revision = ?, legacy_exposure_run_id = ?,
        kalshi_market_question = COALESCE(kalshi_market_question, ?),
        pm_market_question = COALESCE(pm_market_question, ?),
        kalshi_outcome_label = COALESCE(kalshi_outcome_label, ?),
        pm_outcome_label = COALESCE(pm_outcome_label, ?)
        WHERE id = ? AND legacy_exposure_revision IS ?`,
      args: [
        decision.after.relationshipValidity,
        decision.after.exposureIdentity,
        JSON.stringify(decision.after),
        decision.after.revision,
        runId,
        decision.after.exactLegs.kalshi.marketQuestion,
        decision.after.exactLegs.polymarket.marketQuestion,
        decision.after.exactLegs.kalshi.outcomeLabel,
        decision.after.exactLegs.polymarket.outcomeLabel,
        decision.positionId,
        decision.expectedRevision,
      ],
    });
    if (Number(result.rowsAffected) !== 1) {
      throw new Error(`Position ${decision.positionId} changed after forensic planning`);
    }
    applied += 1;
  }
  return { applied };
}
