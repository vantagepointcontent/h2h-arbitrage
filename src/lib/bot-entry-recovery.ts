import crypto from 'node:crypto';
import { createClient, type Client, type Transaction } from '@libsql/client';

const MICRO = 1_000_000;

export type EntryFeeAuthority = 'charged' | 'execution_estimate';
export type RecoveryVerdict = 'already_authoritative' | 'fully_recoverable' | 'partially_recoverable' | 'conflicting' | 'irrecoverable';

export interface BotEntryEvidenceFeeV1 {
  amountCents: number;
  authority: EntryFeeAuthority;
  source: string;
  version: string;
  observedAt: string;
  platformRounding: string;
}

export interface BotEntryEvidenceFillV1 {
  fillId: string;
  fillAuthority: 'venue_fill' | 'execution_quote';
  priceMicrocents: number;
  sizeMicrounits: number;
  observedAt: string;
  chargedFeeCents?: number;
}

export interface BotEntryEvidenceLegV1 {
  venue: 'kalshi' | 'polymarket';
  marketId: string;
  orderId: string;
  quantityMicrounits: number;
  fills: BotEntryEvidenceFillV1[];
  grossMicrocents: number;
  fee: BotEntryEvidenceFeeV1;
}

export interface BotEntryEvidenceV1 {
  schemaVersion: 1;
  capturedAt: string;
  economicActionId: string;
  mode: 'paper' | 'live';
  legs: { kalshi: BotEntryEvidenceLegV1; polymarket: BotEntryEvidenceLegV1 };
}

export interface BotEntryRecoveryDecision {
  positionId: number;
  executionId: number;
  expectedRevision: number;
  verdict: RecoveryVerdict;
  reasons: string[];
  sourceIds: Record<string, string | number | null>;
  sourceHashes: Record<string, string>;
  sourceSnapshot: string;
  evidence: BotEntryEvidenceV1 | null;
  reportedBuyCostCents: number;
  originalEntryCostStatus: string;
}

export interface BotEntryRecoveryManifest {
  schemaVersion: 1;
  auditedAt: string;
  counts: {
    total: number;
    alreadyAuthoritative: number;
    fullyRecoverable: number;
    partiallyRecoverable: number;
    conflicting: number;
    irrecoverable: number;
    recovered: number;
  };
  reconciliation: {
    before: { availableBuyCostCents: number; unavailableReportedBuyCostCents: number };
    after: { availableBuyCostCents: number; unavailableReportedBuyCostCents: number };
    recoveredBuyCostCents: number;
    invalidatedBuyCostCents: number;
    recoveredPositions: Array<{
      positionId: number;
      valuationStatus: string | null;
      currentValueBefore: number | null;
      currentValueAfter: number | null;
      unrealizedPnlBefore: number | null;
      unrealizedPnlAfter: number | null;
      unrealizedRoiBefore: number | null;
      unrealizedRoiAfter: number | null;
    }>;
  };
  decisions: BotEntryRecoveryDecision[];
}

interface SourceRow extends Record<string, unknown> {
  id: number;
  execution_id: number;
  execution_mode: string;
  status: string;
  shares_kalshi: number;
  shares_pm: number;
  live_shares_kalshi: number | null;
  live_shares_pm: number | null;
  buy_price_kalshi: number;
  buy_price_pm: number;
  entry_cost_status: string;
  entry_cost_failure_reason: string | null;
  total_cost: number;
  fees: number;
  live_principal: number | null;
  live_fees: number | null;
  live_cost: number | null;
  expected_payout: number;
  expected_profit: number;
  expected_roi_bps: number | null;
  current_value: number | null;
  unrealized_pnl: number | null;
  unrealized_roi_pct: number | null;
  valuation_status: string | null;
  entry_evidence_revision: number;
  exact_execution_id: number | null;
  arb_id: string | null;
  dry_run: number | null;
  execution_success: number | null;
  kalshi_order: string | null;
  polymarket_order: string | null;
  result: string | null;
  execution_steps: string | null;
  bot_entry_evidence: string | null;
}

function sha256(value: string | null): string {
  return crypto.createHash('sha256').update(value ?? '').digest('hex');
}

function parseObject(value: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringValue(value: unknown): string | null {
  return nonEmpty(value) ? value : null;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function roundRatio(numerator: bigint, denominator: bigint): number {
  const value = Number((numerator + denominator / 2n) / denominator);
  if (!Number.isSafeInteger(value)) throw new Error('Recovered amount exceeds safe integer range');
  return value;
}

function roiBps(pnlCents: number, costCents: number): number {
  if (costCents <= 0) return 0;
  const numerator = BigInt(pnlCents) * 10_000n;
  const magnitude = roundRatio(numerator < 0n ? -numerator : numerator, BigInt(costCents));
  return numerator < 0n ? -magnitude : magnitude;
}

function parseEvidence(value: string | null): BotEntryEvidenceV1 | null {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as BotEntryEvidenceV1
      : null;
  } catch {
    return null;
  }
}

function validateFee(fee: BotEntryEvidenceFeeV1, mode: BotEntryEvidenceV1['mode'], capturedMs: number, venue: string): string[] {
  const reasons: string[] = [];
  const observedMs = Date.parse(fee?.observedAt ?? '');
  if (!safeNonNegativeInteger(fee?.amountCents)) reasons.push(`${venue} fee amount is missing or malformed`);
  if (fee?.authority !== 'charged' && fee?.authority !== 'execution_estimate') reasons.push(`${venue} fee authority is missing or malformed`);
  if (mode === 'paper' && fee?.authority === 'charged') reasons.push(`${venue} paper fee cannot be labeled charged`);
  if (mode === 'live' && fee?.authority !== 'charged') reasons.push(`${venue} live fee must be venue-charged`);
  if (!nonEmpty(fee?.source)) reasons.push(`${venue} fee source is missing`);
  if (!nonEmpty(fee?.version)) reasons.push(`${venue} fee version is missing`);
  if (!nonEmpty(fee?.platformRounding)) reasons.push(`${venue} fee platform rounding is missing`);
  if (!Number.isFinite(observedMs) || observedMs > capturedMs) reasons.push(`${venue} fee observation timestamp is invalid`);
  return reasons;
}

function validateLeg(
  leg: BotEntryEvidenceLegV1,
  venue: 'kalshi' | 'polymarket',
  expectedShares: number,
  mode: BotEntryEvidenceV1['mode'],
  capturedMs: number,
): string[] {
  const label = venue === 'kalshi' ? 'Kalshi' : 'Polymarket';
  const reasons: string[] = [];
  if (leg?.venue !== venue) reasons.push(`${label} venue identity conflicts`);
  if (!nonEmpty(leg?.marketId)) reasons.push(`${label} market ID is missing`);
  if (!nonEmpty(leg?.orderId)) reasons.push(`${label} order ID is missing`);
  if (!Number.isSafeInteger(leg?.quantityMicrounits) || leg.quantityMicrounits !== expectedShares * MICRO) {
    reasons.push(`${label} quantity conflicts with position`);
  }
  if (!Array.isArray(leg?.fills) || leg.fills.length === 0) {
    reasons.push(`${label} immutable fill ladder is missing`);
  } else {
    let size = 0;
    let grossNumerator = 0n;
    let chargedFeeCents = 0;
    const fillIds = new Set<string>();
    for (const fill of leg.fills) {
      if (!nonEmpty(fill?.fillId) || fillIds.has(fill.fillId)) reasons.push(`${label} fill ID is missing or duplicated`);
      else fillIds.add(fill.fillId);
      if (fill?.fillAuthority !== (mode === 'live' ? 'venue_fill' : 'execution_quote')) {
        reasons.push(`${label} fill authority conflicts with execution mode`);
      }
      const fillObservedMs = Date.parse(fill?.observedAt ?? '');
      if (!Number.isFinite(fillObservedMs) || fillObservedMs > capturedMs) reasons.push(`${label} fill timestamp is invalid`);
      if (mode === 'live') {
        if (!safeNonNegativeInteger(fill?.chargedFeeCents)) reasons.push(`${label} per-fill charged fee is missing or malformed`);
        else chargedFeeCents += fill.chargedFeeCents!;
      } else if (fill?.chargedFeeCents != null) {
        reasons.push(`${label} paper fill cannot carry a charged fee`);
      }
      if (!Number.isSafeInteger(fill?.priceMicrocents) || fill.priceMicrocents <= 0 || fill.priceMicrocents >= 100 * MICRO) {
        reasons.push(`${label} fill price is missing or malformed`);
      }
      if (!Number.isSafeInteger(fill?.sizeMicrounits) || fill.sizeMicrounits <= 0) {
        reasons.push(`${label} fill quantity is missing or malformed`);
      }
      if (Number.isSafeInteger(fill?.sizeMicrounits) && fill.sizeMicrounits > 0) size += fill.sizeMicrounits;
      if (Number.isSafeInteger(fill?.priceMicrocents) && Number.isSafeInteger(fill?.sizeMicrounits)) {
        grossNumerator += BigInt(fill.priceMicrocents) * BigInt(fill.sizeMicrounits);
      }
    }
    if (size !== leg.quantityMicrounits) reasons.push(`${label} fill ladder quantity conflicts`);
    if (!safeNonNegativeInteger(leg.grossMicrocents)
      || roundRatio(grossNumerator, BigInt(MICRO)) !== leg.grossMicrocents) {
      reasons.push(`${label} fill ladder gross conflicts`);
    }
    if (mode === 'live' && safeNonNegativeInteger(leg?.fee?.amountCents)
      && chargedFeeCents !== leg.fee.amountCents) reasons.push(`${label} per-fill charged fees conflict with leg fee`);
  }
  reasons.push(...validateFee(leg?.fee, mode, capturedMs, label));
  return reasons;
}

export function botEntryEvidenceErrors(
  value: unknown,
  context: {
    arbId: string;
    dryRun: boolean;
    kalshiOrder?: unknown;
    polymarketOrder?: unknown;
    result?: unknown;
  },
): string[] {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return ['entry evidence envelope is missing'];
  const evidence = value as BotEntryEvidenceV1;
  const reasons: string[] = [];
  const capturedMs = Date.parse(evidence.capturedAt ?? '');
  if (evidence.schemaVersion !== 1) reasons.push('entry evidence schema version is unsupported');
  if (!Number.isFinite(capturedMs)) reasons.push('entry evidence capture timestamp is invalid');
  if (evidence.economicActionId !== context.arbId) reasons.push('economic action ID conflicts with execution');
  const expectedMode = context.dryRun ? 'paper' : 'live';
  if (evidence.mode !== expectedMode) reasons.push('entry evidence mode conflicts with execution');
  if (!evidence.legs?.kalshi || !evidence.legs?.polymarket) return [...reasons, 'two-leg entry evidence is missing'];
  reasons.push(...validateLeg(
    evidence.legs.kalshi, 'kalshi', evidence.legs.kalshi.quantityMicrounits / MICRO, evidence.mode, capturedMs,
  ));
  reasons.push(...validateLeg(
    evidence.legs.polymarket, 'polymarket', evidence.legs.polymarket.quantityMicrounits / MICRO, evidence.mode, capturedMs,
  ));
  if (evidence.legs.kalshi.quantityMicrounits !== evidence.legs.polymarket.quantityMicrounits) {
    reasons.push('entry evidence leg quantities conflict');
  }

  if ('kalshiOrder' in context || 'polymarketOrder' in context || 'result' in context) {
    const parseObject = (input: unknown): Record<string, unknown> => {
      if (typeof input !== 'string') return asObject(input);
      try { return asObject(JSON.parse(input)); } catch { return {}; }
    };
    const kalshiOrder = parseObject(context.kalshiOrder);
    const polymarketOrder = parseObject(context.polymarketOrder);
    const result = parseObject(context.result);
    const expectedKalshiMarket = stringValue(kalshiOrder.ticker) ?? stringValue(kalshiOrder.marketId);
    const expectedPmMarket = stringValue(polymarketOrder.conditionId) ?? stringValue(polymarketOrder.marketId);
    if (expectedKalshiMarket == null || evidence.legs.kalshi.marketId !== expectedKalshiMarket) {
      reasons.push('Kalshi market ID conflicts with persisted execution request');
    }
    if (expectedPmMarket == null || evidence.legs.polymarket.marketId !== expectedPmMarket) {
      reasons.push('Polymarket market ID conflicts with persisted execution request');
    }
    for (const venue of ['kalshi', 'polymarket'] as const) {
      const label = venue === 'kalshi' ? 'Kalshi' : 'Polymarket';
      const resultLeg = asObject(result[`${venue}Result`]);
      const evidenceLeg = evidence.legs[venue];
      const orderId = stringValue(resultLeg.orderId);
      if (orderId == null || evidenceLeg.orderId !== orderId) reasons.push(`${label} order ID conflicts with execution result`);
      const filledContracts = resultLeg.filledContracts;
      if (typeof filledContracts !== 'number'
        || !Number.isFinite(filledContracts)
        || Math.round(filledContracts * MICRO) !== evidenceLeg.quantityMicrounits) {
        reasons.push(`${label} quantity conflicts with execution result`);
      }
      if (evidence.mode === 'live') {
        const rawFills = asObject(resultLeg.venueEvidence).fills;
        const rawFillIds = Array.isArray(rawFills)
          ? rawFills.map((fill) => stringValue(asObject(fill).fillId)).filter((id): id is string => id != null).sort()
          : [];
        const evidenceFillIds = evidenceLeg.fills.map((fill) => fill.fillId).sort();
        if (rawFillIds.length === 0 || JSON.stringify(rawFillIds) !== JSON.stringify(evidenceFillIds)) {
          reasons.push(`${label} fill IDs conflict with execution result`);
        }
      } else if (evidenceLeg.fills.some((fill, index) => fill.fillId !== `${orderId}:quote:${index}`)) {
        reasons.push(`${label} paper fill IDs conflict with execution quote`);
      }
    }
  }
  return [...new Set(reasons)];
}

function exactOrderId(result: Record<string, unknown>, venue: 'kalshi' | 'polymarket'): string | null {
  const resultKey = venue === 'kalshi' ? 'kalshiResult' : 'polymarketResult';
  const orderId = asObject(result[resultKey]).orderId;
  return nonEmpty(orderId) ? orderId : null;
}

function exactMarketId(order: Record<string, unknown>, venue: 'kalshi' | 'polymarket'): string | null {
  const values = venue === 'kalshi'
    ? [order.ticker, order.marketId]
    : [order.conditionId, order.marketId];
  const value = values.find(nonEmpty);
  return value ?? null;
}

function validateEvidence(row: SourceRow, evidence: BotEntryEvidenceV1): string[] {
  const reasons: string[] = [];
  const capturedMs = Date.parse(evidence?.capturedAt ?? '');
  if (evidence?.schemaVersion !== 1) reasons.push('entry evidence schema version is unsupported');
  if (!Number.isFinite(capturedMs)) reasons.push('entry evidence capture timestamp is invalid');
  if (!nonEmpty(evidence?.economicActionId) || evidence.economicActionId !== row.arb_id) reasons.push('economic action ID conflicts with execution');
  const expectedMode = row.dry_run === 1 ? 'paper' : 'live';
  if (evidence?.mode !== expectedMode || evidence.mode !== row.execution_mode) reasons.push('entry evidence mode conflicts with execution');
  if (!evidence?.legs || typeof evidence.legs !== 'object'
    || !evidence.legs.kalshi || !evidence.legs.polymarket) {
    return [...reasons, 'two-leg entry evidence is missing'];
  }
  reasons.push(...validateLeg(evidence.legs.kalshi, 'kalshi', Number(row.shares_kalshi), evidence.mode, capturedMs));
  reasons.push(...validateLeg(evidence.legs.polymarket, 'polymarket', Number(row.shares_pm), evidence.mode, capturedMs));
  const result = parseObject(row.result);
  const kalshiOrderId = exactOrderId(result, 'kalshi');
  const pmOrderId = exactOrderId(result, 'polymarket');
  if (kalshiOrderId !== evidence.legs.kalshi.orderId) reasons.push('Kalshi order ID conflicts with execution result');
  if (pmOrderId !== evidence.legs.polymarket.orderId) reasons.push('Polymarket order ID conflicts with execution result');
  if (exactMarketId(parseObject(row.kalshi_order), 'kalshi') !== evidence.legs.kalshi.marketId) reasons.push('Kalshi market ID conflicts with execution request');
  if (exactMarketId(parseObject(row.polymarket_order), 'polymarket') !== evidence.legs.polymarket.marketId) reasons.push('Polymarket market ID conflicts with execution request');
  return [...new Set(reasons)];
}

function sourceSnapshot(row: SourceRow): string {
  return JSON.stringify({
    positionId: row.id,
    executionId: row.execution_id,
    arbId: row.arb_id,
    kalshiOrder: row.kalshi_order,
    polymarketOrder: row.polymarket_order,
    result: row.result,
    steps: row.execution_steps,
    botEntryEvidence: row.bot_entry_evidence,
  });
}

function positionRevisionSnapshot(row: SourceRow): string {
  return JSON.stringify({
    positionId: row.id,
    executionId: row.execution_id,
    status: row.status,
    entryCostStatus: row.entry_cost_status,
    entryCostFailureReason: row.entry_cost_failure_reason,
    entryEvidenceRevision: row.entry_evidence_revision,
    sharesKalshi: row.shares_kalshi,
    sharesPm: row.shares_pm,
    liveSharesKalshi: row.live_shares_kalshi,
    liveSharesPm: row.live_shares_pm,
    buyPriceKalshiCents: row.buy_price_kalshi,
    buyPricePmCents: row.buy_price_pm,
    totalCostCents: row.total_cost,
    feesCents: row.fees,
    livePrincipalCents: row.live_principal,
    liveFeesCents: row.live_fees,
    liveCostCents: row.live_cost,
    expectedPayoutCents: row.expected_payout,
    expectedProfitCents: row.expected_profit,
    expectedRoiBps: row.expected_roi_bps,
    currentValueCents: row.current_value,
    unrealizedPnlCents: row.unrealized_pnl,
    unrealizedRoiBps: row.unrealized_roi_pct,
  });
}

function reasonText(decision: BotEntryRecoveryDecision): string | null {
  if (decision.verdict === 'fully_recoverable' || decision.verdict === 'already_authoritative') return null;
  return `Legacy entry recovery ${decision.verdict}: ${decision.reasons.join('; ')}`;
}

export class BotEntryRecoveryStore {
  private readonly client: Client;
  private schemaReady: Promise<void> | null = null;

  constructor(dbUrl: string) {
    this.client = createClient({ url: dbUrl });
  }

  close(): void {
    this.client.close();
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) this.schemaReady = this.createSchema();
    return this.schemaReady;
  }

  private async createSchema(): Promise<void> {
    await this.client.execute('PRAGMA busy_timeout = 30000');
    const executionColumns = new Set((await this.client.execute('PRAGMA table_info(executions)')).rows
      .map((row) => String(row.name)));
    if (!executionColumns.has('bot_entry_evidence')) {
      await this.client.execute('ALTER TABLE executions ADD COLUMN bot_entry_evidence TEXT');
    }
    const columns = await this.client.execute('PRAGMA table_info(bot_positions)');
    const existing = new Set(columns.rows.map((row) => String(row.name)));
    const additions: Record<string, string> = {
      entry_evidence_revision: 'INTEGER NOT NULL DEFAULT 0',
      entry_evidence_sha256: 'TEXT',
      entry_recovery_decision_id: 'INTEGER',
      kalshi_entry_fee_authority: 'TEXT',
      pm_entry_fee_authority: 'TEXT',
      kalshi_entry_fee_rounding: 'TEXT',
      pm_entry_fee_rounding: 'TEXT',
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!existing.has(name)) await this.client.execute(`ALTER TABLE bot_positions ADD COLUMN ${name} ${definition}`);
    }
    await this.client.batch([
      `CREATE TABLE IF NOT EXISTS bot_entry_recovery_runs (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
        source_revision TEXT NOT NULL, manifest_json TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS bot_entry_recovery_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id INTEGER NOT NULL,
        source_table TEXT NOT NULL, source_row_id INTEGER NOT NULL,
        source_sha256 TEXT NOT NULL, source_payload TEXT NOT NULL, captured_at TEXT NOT NULL,
        UNIQUE(source_table, source_row_id, source_sha256)
      )`,
      `CREATE TABLE IF NOT EXISTS bot_entry_recovery_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
        position_id INTEGER NOT NULL, execution_id INTEGER NOT NULL,
        evidence_id INTEGER NOT NULL, expected_revision INTEGER NOT NULL,
        verdict TEXT NOT NULL, reason TEXT, source_ids_json TEXT NOT NULL,
        source_hashes_json TEXT NOT NULL, before_status TEXT NOT NULL,
        after_status TEXT NOT NULL, decided_at TEXT NOT NULL,
        UNIQUE(run_id, position_id)
      )`,
    ], 'write');
  }

  async audit(): Promise<BotEntryRecoveryManifest> {
    const executionColumns = new Set((await this.client.execute('PRAGMA table_info(executions)')).rows
      .map((row) => String(row.name)));
    const positionColumns = new Set((await this.client.execute('PRAGMA table_info(bot_positions)')).rows
      .map((row) => String(row.name)));
    const evidenceProjection = executionColumns.has('bot_entry_evidence')
      ? 'e.bot_entry_evidence'
      : 'NULL AS bot_entry_evidence';
    const revisionProjection = positionColumns.has('entry_evidence_revision')
      ? 'bp.entry_evidence_revision'
      : '0 AS entry_evidence_revision';
    const result = await this.client.execute(`
      SELECT bp.*, ${revisionProjection}, e.id AS exact_execution_id, e.arb_id, e.dry_run,
        e.success AS execution_success, e.kalshi_order, e.polymarket_order,
        e.result, e.steps AS execution_steps, ${evidenceProjection}
      FROM bot_positions bp LEFT JOIN executions e ON e.id = bp.execution_id
      ORDER BY bp.id
    `);
    const rows = result.rows as unknown as SourceRow[];
    const orderUses = new Map<string, number[]>();
    for (const row of rows) {
      const executionResult = parseObject(row.result);
      for (const venue of ['kalshi', 'polymarket'] as const) {
        const id = exactOrderId(executionResult, venue);
        if (id) orderUses.set(`${venue}:${id}`, [...(orderUses.get(`${venue}:${id}`) ?? []), Number(row.id)]);
      }
    }
    const decisions: BotEntryRecoveryDecision[] = rows.map((row) => {
      const snapshot = sourceSnapshot(row);
      const executionResult = parseObject(row.result);
      const evidence = parseEvidence(row.bot_entry_evidence);
      const sourceIds = {
        executionId: Number(row.execution_id),
        arbId: row.arb_id,
        kalshiOrderId: exactOrderId(executionResult, 'kalshi'),
        polymarketOrderId: exactOrderId(executionResult, 'polymarket'),
      };
      const sourceHashes = {
        snapshotSha256: sha256(snapshot),
        positionRevisionSha256: sha256(positionRevisionSnapshot(row)),
        executionResultSha256: sha256(row.result),
        entryEvidenceSha256: sha256(row.bot_entry_evidence),
        normalizedEntryEvidenceSha256: evidence == null ? sha256(null) : sha256(JSON.stringify(evidence)),
      };
      let verdict: RecoveryVerdict;
      let reasons: string[];
      if (Number(row.exact_execution_id) !== Number(row.execution_id)) {
        verdict = 'irrecoverable';
        reasons = ['missing exact executions.id linkage'];
      } else if (evidence) {
        const missingLegs = !evidence.legs?.kalshi || !evidence.legs?.polymarket;
        reasons = missingLegs
          ? [
              ...(!evidence.legs?.kalshi ? ['Kalshi leg evidence is missing'] : []),
              ...(!evidence.legs?.polymarket ? ['Polymarket leg evidence is missing'] : []),
            ]
          : validateEvidence(row, evidence);
        if (sourceIds.kalshiOrderId
          && (orderUses.get(`kalshi:${sourceIds.kalshiOrderId}`)?.length ?? 0) > 1) {
          reasons.push('duplicate Kalshi order ID');
        }
        if (sourceIds.polymarketOrderId
          && (orderUses.get(`polymarket:${sourceIds.polymarketOrderId}`)?.length ?? 0) > 1) {
          reasons.push('duplicate Polymarket order ID');
        }
        const lifecycleBlocked = row.entry_cost_status !== 'available' && (
          row.status !== 'open'
          || Number(row.live_shares_kalshi) !== Number(row.shares_kalshi)
          || Number(row.live_shares_pm) !== Number(row.shares_pm)
        );
        if (reasons.length === 0 && lifecycleBlocked) {
          reasons.push('position lifecycle is no longer pristine; exact reduction/settlement allocation evidence is required');
        }
        verdict = reasons.length === 0
          ? (row.entry_cost_status === 'available' ? 'already_authoritative' : 'fully_recoverable')
          : missingLegs ? 'irrecoverable' : lifecycleBlocked ? 'partially_recoverable' : 'conflicting';
      } else if (row.bot_entry_evidence != null) {
        verdict = 'conflicting';
        reasons = ['persisted entry evidence is malformed'];
      } else {
        const kr = asObject(executionResult.kalshiResult);
        const pr = asObject(executionResult.polymarketResult);
        const conflicts: string[] = [];
        if (Number(row.execution_success) !== 1 || executionResult.success !== true) conflicts.push('execution success conflicts with persisted position');
        if (kr.filledContracts != null && kr.filledContracts !== Number(row.shares_kalshi)) conflicts.push('Kalshi quantity conflicts with position');
        if (pr.filledContracts != null && pr.filledContracts !== Number(row.shares_pm)) conflicts.push('Polymarket quantity conflicts with position');
        for (const venue of ['kalshi', 'polymarket'] as const) {
          const id = exactOrderId(executionResult, venue);
          if (id && (orderUses.get(`${venue}:${id}`)?.length ?? 0) > 1) conflicts.push(`duplicate ${venue === 'kalshi' ? 'Kalshi' : 'Polymarket'} order ID`);
        }
        if (conflicts.length > 0) {
          verdict = 'conflicting';
          reasons = conflicts;
        } else {
          const completeAggregate = Number.isSafeInteger(kr.filledContracts) && Number(kr.filledContracts) > 0
            && Number.isSafeInteger(pr.filledContracts) && Number(pr.filledContracts) > 0
            && typeof kr.filledPrice === 'number' && Number.isFinite(kr.filledPrice)
            && typeof pr.filledPrice === 'number' && Number.isFinite(pr.filledPrice)
            && sourceIds.kalshiOrderId != null && sourceIds.polymarketOrderId != null;
          verdict = completeAggregate ? 'partially_recoverable' : 'irrecoverable';
          reasons = completeAggregate
            ? ['aggregate simulated legs exist but immutable fill ladders and execution-time fee authority are absent']
            : ['one or more exact positive leg quantities, prices, or order IDs are missing'];
        }
        reasons.push('Kalshi immutable fill ladder missing', 'Polymarket immutable fill ladder missing', 'Kalshi execution-time fee amount/provenance missing', 'Polymarket execution-time fee amount/provenance missing');
      }
      return { positionId: Number(row.id), executionId: Number(row.execution_id), expectedRevision: Number(row.entry_evidence_revision ?? 0), verdict, reasons: [...new Set(reasons)], sourceIds, sourceHashes, sourceSnapshot: snapshot, evidence: verdict === 'fully_recoverable' ? evidence : null, reportedBuyCostCents: Number(row.total_cost), originalEntryCostStatus: row.entry_cost_status };
    });
    const count = (verdict: RecoveryVerdict) => decisions.filter((decision) => decision.verdict === verdict).length;
    const availableBuyCostCents = decisions
      .filter((decision) => decision.originalEntryCostStatus === 'available')
      .reduce((sum, decision) => sum + decision.reportedBuyCostCents, 0);
    const unavailableReportedBuyCostCents = decisions
      .filter((decision) => decision.originalEntryCostStatus !== 'available')
      .reduce((sum, decision) => sum + decision.reportedBuyCostCents, 0);
    return {
      schemaVersion: 1,
      auditedAt: new Date().toISOString(),
      counts: {
        total: decisions.length,
        alreadyAuthoritative: count('already_authoritative'),
        fullyRecoverable: count('fully_recoverable'),
        partiallyRecoverable: count('partially_recoverable'),
        conflicting: count('conflicting'),
        irrecoverable: count('irrecoverable'),
        recovered: 0,
      },
      reconciliation: {
        before: { availableBuyCostCents, unavailableReportedBuyCostCents },
        after: { availableBuyCostCents, unavailableReportedBuyCostCents },
        recoveredBuyCostCents: 0,
        invalidatedBuyCostCents: 0,
        recoveredPositions: [],
      },
      decisions,
    };
  }

  async apply(manifest: BotEntryRecoveryManifest, options: { beforeCommit?: () => void | Promise<void> } = {}): Promise<BotEntryRecoveryManifest> {
    await this.ensureSchema();
    const transaction = await this.client.transaction('write');
    const runId = crypto.randomUUID();
    try {
      await transaction.execute({
        sql: 'INSERT INTO bot_entry_recovery_runs (id,started_at,source_revision) VALUES (?,?,?)',
        args: [runId, manifest.auditedAt, sha256(JSON.stringify(manifest.decisions.map((decision) => decision.sourceHashes)))],
      });
      let recovered = 0;
      const recoveredPositions: BotEntryRecoveryManifest['reconciliation']['recoveredPositions'] = [];
      for (const decision of manifest.decisions) {
        const currentSource = await transaction.execute({
          sql: `SELECT bp.*,
              e.arb_id,e.kalshi_order,e.polymarket_order,e.result,e.steps,e.bot_entry_evidence
            FROM bot_positions bp JOIN executions e ON e.id=bp.execution_id
            WHERE bp.id=? AND bp.execution_id=?`,
          args: [decision.positionId, decision.executionId],
        });
        const source = currentSource.rows[0];
        const currentSnapshot = source == null ? null : JSON.stringify({
          positionId: decision.positionId,
          executionId: decision.executionId,
          arbId: source.arb_id,
          kalshiOrder: source.kalshi_order,
          polymarketOrder: source.polymarket_order,
          result: source.result,
          steps: source.steps,
          botEntryEvidence: source.bot_entry_evidence,
        });
        if (currentSnapshot == null || sha256(currentSnapshot) !== decision.sourceHashes.snapshotSha256) {
          throw new Error(`Stale source evidence for bot position ${decision.positionId}`);
        }
        const currentPositionRevisionHash = sha256(positionRevisionSnapshot(source as unknown as SourceRow));
        if (currentPositionRevisionHash !== decision.sourceHashes.positionRevisionSha256) {
          throw new Error(`Stale entry-evidence revision for bot position ${decision.positionId}`);
        }
        if (decision.evidence != null
          && sha256(JSON.stringify(decision.evidence)) !== decision.sourceHashes.normalizedEntryEvidenceSha256) {
          throw new Error(`Manifest evidence changed after audit for bot position ${decision.positionId}`);
        }
        const evidenceId = await this.persistEvidence(transaction, decision);
        const beforeStatus = decision.originalEntryCostStatus;
        let afterStatus = beforeStatus;
        let positionMutated = false;
        if (decision.verdict === 'already_authoritative') {
          // A rerun is economically read-only, but still records a durable
          // classification decision so every run accounts for every row.
        } else if (decision.verdict === 'fully_recoverable' && decision.evidence) {
          const economics = this.recoveredEconomics(decision.evidence);
          const update = await transaction.execute({
            sql: `UPDATE bot_positions SET
              buy_price_kalshi=?, buy_price_pm=?, total_cost=?, fees=?,
              live_principal=?, live_fees=?, live_cost=?, expected_payout=?, expected_profit=?, expected_roi_bps=?,
              unrealized_pnl=CASE WHEN current_value IS NULL THEN NULL ELSE current_value-? END,
              unrealized_roi_pct=CASE
                WHEN current_value IS NULL THEN NULL
                WHEN current_value>=? THEN CAST(((current_value-?)*10000 + CAST(?/2 AS INTEGER))/? AS INTEGER)
                ELSE -CAST(((?-current_value)*10000 + CAST(?/2 AS INTEGER))/? AS INTEGER)
              END,
              entry_cost_status='available', entry_cost_failure_reason=NULL,
              kalshi_entry_gross_microcents=?, pm_entry_gross_microcents=?, entry_cost_rounding_delta_microcents=?,
              kalshi_entry_fill_count=?, pm_entry_fill_count=?, kalshi_entry_fills_json=?, pm_entry_fills_json=?,
              kalshi_entry_fee=?, pm_entry_fee=?,
              kalshi_entry_fee_authority=?, pm_entry_fee_authority=?,
              kalshi_entry_fee_rounding=?, pm_entry_fee_rounding=?,
              kalshi_entry_fee_source=?, kalshi_entry_fee_observed_at=?, kalshi_entry_fee_version=?,
              pm_entry_fee_source=?, pm_entry_fee_observed_at=?, pm_entry_fee_version=?,
              entry_evidence_sha256=?,
              entry_evidence_revision=entry_evidence_revision+1
              WHERE id=? AND execution_id=? AND entry_cost_status='unavailable' AND entry_evidence_revision=?
                AND status=? AND entry_cost_failure_reason IS ?
                AND shares_kalshi=? AND shares_pm=?
                AND live_shares_kalshi IS ? AND live_shares_pm IS ?
                AND buy_price_kalshi=? AND buy_price_pm=? AND total_cost=? AND fees=?
                AND live_principal IS ? AND live_fees IS ? AND live_cost IS ?
                AND expected_payout=? AND expected_profit=? AND expected_roi_bps IS ?
                AND current_value IS ? AND unrealized_pnl IS ? AND unrealized_roi_pct IS ?`,
            args: [
              economics.kalshiBuyPriceCents, economics.pmBuyPriceCents, economics.totalCostCents, economics.feesCents,
              economics.livePrincipalCents, economics.liveFeesCents, economics.liveCostCents,
              economics.expectedPayoutCents, economics.expectedProfitCents, economics.expectedRoiBps,
              economics.liveCostCents,
              economics.liveCostCents, economics.liveCostCents, economics.liveCostCents, economics.liveCostCents,
              economics.liveCostCents, economics.liveCostCents, economics.liveCostCents,
              decision.evidence.legs.kalshi.grossMicrocents, decision.evidence.legs.polymarket.grossMicrocents,
              economics.roundingDeltaMicrocents,
              decision.evidence.legs.kalshi.fills.length, decision.evidence.legs.polymarket.fills.length,
              JSON.stringify(decision.evidence.legs.kalshi.fills),
              JSON.stringify(decision.evidence.legs.polymarket.fills),
              decision.evidence.legs.kalshi.fee.amountCents, decision.evidence.legs.polymarket.fee.amountCents,
              decision.evidence.legs.kalshi.fee.authority, decision.evidence.legs.polymarket.fee.authority,
              decision.evidence.legs.kalshi.fee.platformRounding, decision.evidence.legs.polymarket.fee.platformRounding,
              decision.evidence.legs.kalshi.fee.source, decision.evidence.legs.kalshi.fee.observedAt, decision.evidence.legs.kalshi.fee.version,
              decision.evidence.legs.polymarket.fee.source, decision.evidence.legs.polymarket.fee.observedAt, decision.evidence.legs.polymarket.fee.version,
              decision.sourceHashes.entryEvidenceSha256,
              decision.positionId, decision.executionId, decision.expectedRevision,
              source.status, source.entry_cost_failure_reason,
              source.shares_kalshi, source.shares_pm,
              source.live_shares_kalshi, source.live_shares_pm,
              source.buy_price_kalshi, source.buy_price_pm, source.total_cost, source.fees,
              source.live_principal, source.live_fees, source.live_cost,
              source.expected_payout, source.expected_profit, source.expected_roi_bps,
              source.current_value, source.unrealized_pnl, source.unrealized_roi_pct,
            ],
          });
          if (update.rowsAffected !== 1) throw new Error(`Stale entry-evidence revision for bot position ${decision.positionId}`);
          const after = (await transaction.execute({
            sql: 'SELECT current_value,unrealized_pnl,unrealized_roi_pct FROM bot_positions WHERE id=?',
            args: [decision.positionId],
          })).rows[0];
          if (after.current_value !== source.current_value) {
            throw new Error(`Recovery changed independent current value for bot position ${decision.positionId}`);
          }
          if (source.current_value != null && (after.unrealized_pnl == null || after.unrealized_roi_pct == null)) {
            throw new Error(`Recovery failed to populate P&L for valued bot position ${decision.positionId}`);
          }
          recoveredPositions.push({
            positionId: decision.positionId,
            valuationStatus: source.valuation_status == null ? null : String(source.valuation_status),
            currentValueBefore: source.current_value == null ? null : Number(source.current_value),
            currentValueAfter: after.current_value == null ? null : Number(after.current_value),
            unrealizedPnlBefore: source.unrealized_pnl == null ? null : Number(source.unrealized_pnl),
            unrealizedPnlAfter: after.unrealized_pnl == null ? null : Number(after.unrealized_pnl),
            unrealizedRoiBefore: source.unrealized_roi_pct == null ? null : Number(source.unrealized_roi_pct),
            unrealizedRoiAfter: after.unrealized_roi_pct == null ? null : Number(after.unrealized_roi_pct),
          });
          afterStatus = 'available';
          positionMutated = true;
          recovered += 1;
        } else {
          const reason = reasonText(decision);
          const update = await transaction.execute({
            sql: `UPDATE bot_positions SET entry_cost_status='unavailable', entry_cost_failure_reason=?,
                entry_evidence_revision=entry_evidence_revision+1
              WHERE id=? AND execution_id=? AND entry_cost_status=? AND entry_evidence_revision=?
                AND (entry_cost_status<>'unavailable' OR COALESCE(entry_cost_failure_reason,'')<>?)`,
            args: [reason, decision.positionId, decision.executionId, beforeStatus, decision.expectedRevision, reason],
          });
          positionMutated = update.rowsAffected === 1;
          afterStatus = 'unavailable';
        }
        const decidedAt = new Date().toISOString();
        const inserted = await transaction.execute({
          sql: `INSERT INTO bot_entry_recovery_decisions
            (run_id,position_id,execution_id,evidence_id,expected_revision,verdict,reason,source_ids_json,source_hashes_json,before_status,after_status,decided_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
          args: [runId, decision.positionId, decision.executionId, evidenceId, decision.expectedRevision,
            decision.verdict, reasonText(decision), JSON.stringify(decision.sourceIds), JSON.stringify(decision.sourceHashes),
            beforeStatus, afterStatus, decidedAt],
        });
        const decisionId = Number(inserted.rows[0]?.id ?? 0);
        if (positionMutated) {
          await transaction.execute({
            sql: 'UPDATE bot_positions SET entry_recovery_decision_id=? WHERE id=?',
            args: [decisionId, decision.positionId],
          });
        }
      }
      const recoveredDecisions = manifest.decisions.filter((decision) => decision.verdict === 'fully_recoverable' && decision.evidence);
      const recoveredBuyCostCents = recoveredDecisions.reduce((sum, decision) =>
        sum + this.recoveredEconomics(decision.evidence!).totalCostCents, 0);
      const removedUnavailableReportedCents = recoveredDecisions.reduce((sum, decision) =>
        sum + decision.reportedBuyCostCents, 0);
      const invalidatedBuyCostCents = manifest.decisions
        .filter((decision) => decision.originalEntryCostStatus === 'available'
          && decision.verdict !== 'already_authoritative')
        .reduce((sum, decision) => sum + decision.reportedBuyCostCents, 0);
      const completed = {
        ...manifest,
        counts: { ...manifest.counts, recovered },
        reconciliation: {
          ...manifest.reconciliation,
          after: {
            availableBuyCostCents: manifest.reconciliation.before.availableBuyCostCents
              + recoveredBuyCostCents - invalidatedBuyCostCents,
            unavailableReportedBuyCostCents: manifest.reconciliation.before.unavailableReportedBuyCostCents
              - removedUnavailableReportedCents + invalidatedBuyCostCents,
          },
          recoveredBuyCostCents,
          invalidatedBuyCostCents,
          recoveredPositions,
        },
      };
      await options.beforeCommit?.();
      await transaction.execute({
        sql: 'UPDATE bot_entry_recovery_runs SET completed_at=?, manifest_json=? WHERE id=?',
        args: [new Date().toISOString(), JSON.stringify(completed), runId],
      });
      await transaction.commit();
      return completed;
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  }

  async run(options: { beforeCommit?: () => void | Promise<void> } = {}): Promise<BotEntryRecoveryManifest> {
    return this.apply(await this.audit(), options);
  }

  private async persistEvidence(transaction: Transaction, decision: BotEntryRecoveryDecision): Promise<number> {
    const hash = decision.sourceHashes.snapshotSha256;
    await transaction.execute({
      sql: `INSERT OR IGNORE INTO bot_entry_recovery_evidence
        (execution_id,source_table,source_row_id,source_sha256,source_payload,captured_at)
        VALUES (?,?,?,?,?,?)`,
      args: [decision.executionId, 'executions', decision.executionId, hash, decision.sourceSnapshot, new Date().toISOString()],
    });
    const existing = await transaction.execute({
      sql: `SELECT id FROM bot_entry_recovery_evidence
        WHERE source_table='executions' AND source_row_id=? AND source_sha256=?`,
      args: [decision.executionId, hash],
    });
    const id = Number(existing.rows[0]?.id ?? 0);
    if (!id) throw new Error(`Could not preserve source evidence for execution ${decision.executionId}`);
    return id;
  }

  private recoveredEconomics(evidence: BotEntryEvidenceV1) {
    const kalshiGross = evidence.legs.kalshi.grossMicrocents;
    const pmGross = evidence.legs.polymarket.grossMicrocents;
    const principalCents = roundRatio(BigInt(kalshiGross + pmGross), BigInt(MICRO));
    const feesCents = evidence.legs.kalshi.fee.amountCents + evidence.legs.polymarket.fee.amountCents;
    const totalCostCents = principalCents + feesCents;
    const expectedPayoutCents = roundRatio(
      BigInt(Math.min(evidence.legs.kalshi.quantityMicrounits, evidence.legs.polymarket.quantityMicrounits)) * 100n,
      BigInt(MICRO),
    );
    const expectedProfitCents = expectedPayoutCents - totalCostCents;
    return {
      kalshiBuyPriceCents: roundRatio(BigInt(kalshiGross), BigInt(evidence.legs.kalshi.quantityMicrounits)),
      pmBuyPriceCents: roundRatio(BigInt(pmGross), BigInt(evidence.legs.polymarket.quantityMicrounits)),
      totalCostCents,
      feesCents,
      livePrincipalCents: principalCents,
      liveFeesCents: feesCents,
      liveCostCents: totalCostCents,
      expectedPayoutCents,
      expectedProfitCents,
      expectedRoiBps: roiBps(expectedProfitCents, totalCostCents),
      roundingDeltaMicrocents: totalCostCents * MICRO - kalshiGross - pmGross - feesCents * MICRO,
    };
  }
}
