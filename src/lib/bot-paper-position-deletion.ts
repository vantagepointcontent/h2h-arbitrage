import { createHash } from 'node:crypto';
import type { Client, InValue, Transaction } from '@libsql/client';

export interface PaperPositionDeletionCohortRow {
  positionId: number;
  executionId: number;
  exposureIdentity: string;
}

export interface PaperPositionDeletionCandidate extends PaperPositionDeletionCohortRow {
  revision: string;
  pairKey: string | null;
  proof: {
    positionMode: string;
    executionDryRun: number;
    simulatedOrderIds: string[];
    settlementRows: number;
  };
}

export interface PaperPositionDeletionExcluded extends PaperPositionDeletionCohortRow {
  reasons: string[];
}

export interface PaperPositionDeletionPlan {
  version: 1;
  sourceRevision: string;
  counts: { requested: number; eligible: number; excluded: number; alreadyDeleted: number; missing: number };
  eligible: PaperPositionDeletionCandidate[];
  excluded: PaperPositionDeletionExcluded[];
  alreadyDeleted: PaperPositionDeletionCohortRow[];
  missing: PaperPositionDeletionCohortRow[];
}

export interface PaperPositionDeletionApplyResult {
  positionsDeleted: number;
  executionsTombstoned: number;
  settlementRowsDeleted: number;
  recoveryDecisionRowsDeleted: number;
  recoveryEvidenceRowsDeleted: number;
  reservationsDeleted: number;
  alreadyDeleted: number;
}

type Executor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;
type Row = Record<string, unknown>;

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

const MALFORMED_JSON = Symbol('malformed-json');

function parseJson(value: unknown): unknown | typeof MALFORMED_JSON {
  if (value == null) return null;
  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    return MALFORMED_JSON;
  }
}

function collectOrderIds(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectOrderIds(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Row)) {
      if (/^(order_?id|client_?order_?id)$/i.test(key) && item != null) found.push(String(item));
      collectOrderIds(item, found);
    }
  }
  return found;
}

function isSimulatedOrderId(value: string): boolean {
  return /^(dry[-_:]?run[-_:]|paper[-_:]|sim(?:ulated)?[-_:])/i.test(value);
}

async function tableExists(executor: Executor, table: string): Promise<boolean> {
  const result = await executor.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
    args: [table],
  });
  return result.rows.length > 0;
}

async function columns(executor: Executor, table: string): Promise<Set<string>> {
  if (!await tableExists(executor, table)) return new Set();
  const result = await executor.execute(`PRAGMA table_info(${JSON.stringify(table)})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

function pairKey(kalshiTicker: unknown, pmConditionId: unknown): string | null {
  if (typeof kalshiTicker !== 'string' || !kalshiTicker.trim()
    || typeof pmConditionId !== 'string' || !pmConditionId.trim()) return null;
  return `${kalshiTicker.trim().toLowerCase()}\u0000${pmConditionId.trim().toLowerCase()}`;
}

async function settlementRows(executor: Executor, positionId: number): Promise<{ summaries: Row[]; legs: Row[] }> {
  const summaries = await tableExists(executor, 'bot_position_settlements')
    ? (await executor.execute({ sql: 'SELECT * FROM bot_position_settlements WHERE position_id=?', args: [positionId] })).rows as unknown as Row[]
    : [];
  const legs = await tableExists(executor, 'bot_position_settlement_legs')
    ? (await executor.execute({ sql: 'SELECT * FROM bot_position_settlement_legs WHERE position_id=? ORDER BY venue', args: [positionId] })).rows as unknown as Row[]
    : [];
  return { summaries, legs };
}

function hasSettlementCredit(position: Row, settlements: { summaries: Row[]; legs: Row[] }): boolean {
  if (position.resolution_payout != null || position.resolution_source != null) return true;
  return settlements.summaries.some((row) => row.position_state === 'settled'
      || row.gross_settlement_proceeds_cents != null || row.net_settlement_proceeds_cents != null
      || row.realized_pnl_cents != null || row.cash_available_at != null)
    || settlements.legs.some((row) => row.payout_entitlement_cents != null
      || row.net_settlement_proceeds_cents != null || row.cash_available_at != null
      || ![null, 'pending', 'unavailable'].includes(row.credit_state as null | string));
}

function candidateRevision(position: Row, execution: Row, settlements: { summaries: Row[]; legs: Row[] }): string {
  return sha256({ position, execution, settlements });
}

function positionForRevision(row: Row): Row {
  const keys = [
    'id', 'execution_id', 'execution_mode', 'market_id', 'market_title', 'kalshi_ticker',
    'pm_condition_id', 'kalshi_side', 'pm_side', 'shares_kalshi', 'shares_pm',
    'live_shares_kalshi', 'live_shares_pm', 'total_cost', 'total_cost_microusd',
    'status', 'opened_at', 'settled_at', 'closed_at', 'realized_pnl',
    'realized_pnl_before_settlement', 'resolution_source', 'resolution_payout',
    'resolution_validation_status', 'relationship_validity', 'exposure_identity_status',
    'legacy_exposure_revision',
  ];
  return Object.fromEntries(keys.map((key) => [key, row[key] ?? null]));
}

export async function auditPaperPositionDeletion(
  executor: Executor,
  cohort: PaperPositionDeletionCohortRow[],
): Promise<PaperPositionDeletionPlan> {
  const ids = new Set<number>();
  const executions = new Set<number>();
  for (const row of cohort) {
    if (!Number.isSafeInteger(row.positionId) || row.positionId <= 0
      || !Number.isSafeInteger(row.executionId) || row.executionId <= 0) {
      throw new Error('Deletion cohort contains an invalid position or execution ID');
    }
    if (ids.has(row.positionId) || executions.has(row.executionId)) {
      throw new Error('Deletion cohort contains duplicate position or execution IDs');
    }
    ids.add(row.positionId);
    executions.add(row.executionId);
  }

  const executionColumns = await columns(executor, 'executions');
  const hasTombstones = executionColumns.has('paper_position_deleted_at');
  const eligible: PaperPositionDeletionCandidate[] = [];
  const excluded: PaperPositionDeletionExcluded[] = [];
  const alreadyDeleted: PaperPositionDeletionCohortRow[] = [];
  const missing: PaperPositionDeletionCohortRow[] = [];

  for (const expected of cohort) {
    const result = await executor.execute({
      sql: `SELECT bp.*, e.dry_run, e.source AS execution_source, e.success AS execution_success,
        e.kalshi_order, e.polymarket_order, e.result AS execution_result, e.steps AS execution_steps
        ${hasTombstones ? ', e.paper_position_deleted_at, e.paper_position_deletion_reason' : ''}
        FROM executions e LEFT JOIN bot_positions bp ON bp.execution_id=e.id AND bp.id=? WHERE e.id=?`,
      args: [expected.positionId, expected.executionId],
    });
    const row = result.rows[0] as Row | undefined;
    if (!row) {
      missing.push(expected);
      continue;
    }
    if (row.id == null) {
      if (hasTombstones && row.paper_position_deleted_at != null) alreadyDeleted.push(expected);
      else missing.push(expected);
      continue;
    }

    const reasons: string[] = [];
    if (Number(row.execution_id) !== expected.executionId) reasons.push('position/execution immutable ID mismatch');
    if (String(row.exposure_identity_status) !== expected.exposureIdentity) reasons.push('BUG-172 exposure cohort changed');
    if (row.execution_mode !== 'paper' || Number(row.dry_run) !== 1) reasons.push('execution is not paper/dry-run');
    const payloads = [row.kalshi_order, row.polymarket_order, row.execution_result, row.execution_steps].map(parseJson);
    if (payloads.includes(MALFORMED_JSON)) reasons.push('execution audit payload is malformed');
    const orderIds = collectOrderIds(payloads.filter((value) => value !== MALFORMED_JSON));
    if (orderIds.some((value) => !isSimulatedOrderId(value))) reasons.push('live-like venue order ID exists');
    const settlements = await settlementRows(executor, expected.positionId);
    if (settlements.legs.some((leg) => leg.execution_mode != null && leg.execution_mode !== 'paper')) {
      reasons.push('settlement leg is not paper mode');
    }
    if (hasSettlementCredit(row, settlements)) reasons.push('authoritative settlement credit or payout exists');

    if (reasons.length > 0) {
      excluded.push({ ...expected, reasons });
      continue;
    }
    eligible.push({
      ...expected,
      revision: candidateRevision(positionForRevision(row), {
        id: expected.executionId,
        dry_run: row.dry_run,
        source: row.execution_source,
        success: row.execution_success,
        kalshi_order: row.kalshi_order,
        polymarket_order: row.polymarket_order,
        result: row.execution_result,
        steps: row.execution_steps,
      }, settlements),
      pairKey: pairKey(row.kalshi_ticker, row.pm_condition_id),
      proof: {
        positionMode: String(row.execution_mode),
        executionDryRun: Number(row.dry_run),
        simulatedOrderIds: orderIds,
        settlementRows: settlements.summaries.length + settlements.legs.length,
      },
    });
  }

  const sourceRevision = `sha256:${sha256({ cohort, eligible, excluded, alreadyDeleted, missing })}`;
  return {
    version: 1,
    sourceRevision,
    counts: {
      requested: cohort.length,
      eligible: eligible.length,
      excluded: excluded.length,
      alreadyDeleted: alreadyDeleted.length,
      missing: missing.length,
    },
    eligible,
    excluded,
    alreadyDeleted,
    missing,
  };
}

export async function ensurePaperPositionDeletionSchema(executor: Executor): Promise<void> {
  const executionColumns = await columns(executor, 'executions');
  for (const [name, definition] of [
    ['paper_position_deleted_at', 'TEXT'],
    ['paper_position_deletion_reason', 'TEXT'],
    ['paper_position_deletion_source_revision', 'TEXT'],
  ] as const) {
    if (!executionColumns.has(name)) {
      try {
        await executor.execute(`ALTER TABLE executions ADD COLUMN ${name} ${definition}`);
      } catch (error) {
        const refreshed = await columns(executor, 'executions');
        if (!refreshed.has(name)) throw error;
      }
    }
  }
  await executor.execute(`CREATE TABLE IF NOT EXISTS bot_paper_position_deletion_runs (
    source_revision TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    positions_deleted INTEGER NOT NULL,
    manifest_json TEXT NOT NULL
  )`);
}

async function deleteWhereIn(
  executor: Executor,
  table: string,
  column: string,
  values: number[],
): Promise<number> {
  if (values.length === 0 || !await tableExists(executor, table)) return 0;
  const result = await executor.execute({
    sql: `DELETE FROM ${JSON.stringify(table)} WHERE ${JSON.stringify(column)} IN (${placeholders(values.length)})`,
    args: values,
  });
  return Number(result.rowsAffected);
}

export async function applyPaperPositionDeletion(
  client: Client,
  plan: PaperPositionDeletionPlan,
  metadata: { appliedAt: string; reason: string },
): Promise<PaperPositionDeletionApplyResult> {
  if (!Number.isFinite(Date.parse(metadata.appliedAt)) || !metadata.reason.trim()) {
    throw new Error('Deletion apply metadata is invalid');
  }
  const result: PaperPositionDeletionApplyResult = {
    positionsDeleted: 0,
    executionsTombstoned: 0,
    settlementRowsDeleted: 0,
    recoveryDecisionRowsDeleted: 0,
    recoveryEvidenceRowsDeleted: 0,
    reservationsDeleted: 0,
    alreadyDeleted: plan.counts.alreadyDeleted,
  };
  if (plan.eligible.length === 0) return result;

  const transaction = await client.transaction('write');
  try {
    await ensurePaperPositionDeletionSchema(transaction);
    const current = await auditPaperPositionDeletion(transaction, plan.eligible.map((row) => ({
      positionId: row.positionId,
      executionId: row.executionId,
      exposureIdentity: row.exposureIdentity,
    })));
    for (const expected of plan.eligible) {
      const now = current.eligible.find((row) => row.positionId === expected.positionId);
      if (!now || now.revision !== expected.revision) {
        throw new Error(`Position ${expected.positionId} changed after deletion audit`);
      }
    }

    const positionIds = plan.eligible.map((row) => row.positionId);
    const executionIds = plan.eligible.map((row) => row.executionId);
    result.settlementRowsDeleted += await deleteWhereIn(transaction, 'bot_position_settlement_legs', 'position_id', positionIds);
    result.settlementRowsDeleted += await deleteWhereIn(transaction, 'bot_position_settlements', 'position_id', positionIds);
    result.recoveryDecisionRowsDeleted += await deleteWhereIn(transaction, 'bot_entry_recovery_decisions', 'position_id', positionIds);
    if (await tableExists(transaction, 'bot_entry_recovery_evidence')) {
      const evidence = await transaction.execute({
        sql: `DELETE FROM bot_entry_recovery_evidence
          WHERE execution_id IN (${placeholders(executionIds.length)})
            AND NOT EXISTS (SELECT 1 FROM bot_entry_recovery_decisions d WHERE d.evidence_id=bot_entry_recovery_evidence.id)`,
        args: executionIds,
      });
      result.recoveryEvidenceRowsDeleted = Number(evidence.rowsAffected);
    }
    const deleted = await transaction.execute({
      sql: `DELETE FROM bot_positions WHERE id IN (${placeholders(positionIds.length)})
        AND execution_mode='paper' AND execution_id IN (${placeholders(executionIds.length)})`,
      args: [...positionIds, ...executionIds],
    });
    result.positionsDeleted = Number(deleted.rowsAffected);
    if (result.positionsDeleted !== plan.eligible.length) {
      throw new Error(`Deletion count mismatch: expected ${plan.eligible.length}, deleted ${result.positionsDeleted}`);
    }
    const tombstones = await transaction.execute({
      sql: `UPDATE executions SET paper_position_deleted_at=?, paper_position_deletion_reason=?,
        paper_position_deletion_source_revision=?
        WHERE id IN (${placeholders(executionIds.length)}) AND dry_run=1 AND paper_position_deleted_at IS NULL`,
      args: [metadata.appliedAt, metadata.reason, plan.sourceRevision, ...executionIds] as InValue[],
    });
    result.executionsTombstoned = Number(tombstones.rowsAffected);
    if (result.executionsTombstoned !== plan.eligible.length) {
      throw new Error('Execution tombstone count mismatch');
    }
    if (await tableExists(transaction, 'bot_position_reservations')) {
      for (const candidate of plan.eligible) {
        if (!candidate.pairKey) continue;
        const reservation = await transaction.execute({
          sql: `DELETE FROM bot_position_reservations WHERE pair_key=? AND execution_mode='paper'
            AND NOT EXISTS (
              SELECT 1 FROM bot_positions
              WHERE execution_mode='paper' AND status='open'
                AND lower(kalshi_ticker) || char(0) || lower(pm_condition_id) = ?
            )`,
          args: [candidate.pairKey, candidate.pairKey],
        });
        result.reservationsDeleted += Number(reservation.rowsAffected);
      }
    }
    await transaction.execute({
      sql: `INSERT INTO bot_paper_position_deletion_runs
        (source_revision,applied_at,reason,positions_deleted,manifest_json) VALUES (?,?,?,?,?)`,
      args: [plan.sourceRevision, metadata.appliedAt, metadata.reason, result.positionsDeleted, JSON.stringify(plan)],
    });
    await transaction.commit();
  } catch (error) {
    if (!transaction.closed) await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
  return result;
}
