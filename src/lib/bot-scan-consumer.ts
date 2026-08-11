import { createHash, randomUUID } from 'crypto';
import { createClient } from '@libsql/client';
import path from 'path';
import type { BotExecutionResult, BotTradeInput } from './bot-trader';

export type BotScanDecisionState =
  | 'received'
  | 'criteria_rejected'
  | 'revalidation_rejected'
  | 'placement_attempted'
  | 'placed'
  | 'partial_unhedged'
  | 'failed'
  | 'duplicate_replay';

export interface CompletedScanOpportunity {
  scanId: number;
  marketId: string;
  marketTitle: string;
  scannedAt: string;
  outcome: string;
  strategy: string;
  roiBps: number;
  kalshiTicker: string;
  pmConditionId: string;
}

export interface RevalidationRejection {
  rejection: { code: string; reason: string };
}

export interface RevalidatedOpportunity {
  input: BotTradeInput;
  roiBps: number;
  feeAuthority: { kalshiFeeCents: number; polymarketFeeCents: number };
  quoteObservedAt: string;
}

export interface ConsumerSettings {
  enabled: boolean;
  mode: 'paper' | 'production';
  minRoiBps: number;
  maxTradesPerDay: number;
}

export interface OpportunityDecision {
  state: Exclude<BotScanDecisionState, 'received' | 'placement_attempted' | 'duplicate_replay'>;
  reasonCode: string;
  reason: string;
  execution?: BotExecutionResult;
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildOpportunityKey(opportunity: CompletedScanOpportunity): string {
  const identity = [
    opportunity.scanId,
    normalized(opportunity.marketId),
    normalized(opportunity.outcome),
    normalized(opportunity.strategy),
    normalized(opportunity.kalshiTicker),
    normalized(opportunity.pmConditionId),
  ].join('|');
  return `scan:${opportunity.scanId}:${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function reject(
  state: 'criteria_rejected' | 'revalidation_rejected' | 'failed' | 'partial_unhedged',
  reasonCode: string,
  reason: string,
  execution?: BotExecutionResult,
): OpportunityDecision {
  return { state, reasonCode, reason, ...(execution ? { execution } : {}) };
}

export async function decideCompletedScanOpportunity(
  opportunity: CompletedScanOpportunity,
  settings: ConsumerSettings,
  revalidate: () => Promise<RevalidatedOpportunity | RevalidationRejection>,
  execute: (input: BotTradeInput) => Promise<BotExecutionResult>,
): Promise<OpportunityDecision> {
  if (!settings.enabled) return reject('criteria_rejected', 'BOT_DISABLED', 'BotTrader is disabled');
  if (settings.mode !== 'paper') {
    return reject('criteria_rejected', 'PRODUCTION_NOT_APPROVED', 'Completed-scan consumer is paper-only until production is explicitly approved');
  }
  if (!Number.isSafeInteger(opportunity.roiBps) || opportunity.roiBps < settings.minRoiBps) {
    return reject('criteria_rejected', 'ROI_BELOW_THRESHOLD', `Scan ROI ${opportunity.roiBps} bps is below the active ${settings.minRoiBps} bps threshold`);
  }
  if (settings.maxTradesPerDay <= 0) {
    return reject('criteria_rejected', 'DAILY_LIMIT_REACHED', 'Daily BotTrader trade limit has been reached');
  }

  const current = await revalidate();
  if ('rejection' in current) {
    return reject('revalidation_rejected', current.rejection.code, current.rejection.reason);
  }

  const sameIdentity =
    normalized(current.input.pairId) === normalized(opportunity.marketId)
    && normalized(current.input.outcome) === normalized(opportunity.outcome)
    && normalized(current.input.strategy) === normalized(opportunity.strategy)
    && normalized(current.input.kalshiTicker ?? '') === normalized(opportunity.kalshiTicker)
    && normalized(current.input.pmConditionId ?? '') === normalized(opportunity.pmConditionId);
  if (!sameIdentity) {
    return reject('revalidation_rejected', 'IDENTITY_MISMATCH', 'Revalidated market, outcome, strategy, or venue identifiers do not match the completed scan');
  }

  const { kalshiFeeCents, polymarketFeeCents } = current.feeAuthority;
  if (![kalshiFeeCents, polymarketFeeCents].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return reject('revalidation_rejected', 'MALFORMED_FEES', 'Both venue fees must be authoritative non-negative integer cents');
  }
  if (!Number.isSafeInteger(current.roiBps) || current.roiBps < settings.minRoiBps) {
    return reject('revalidation_rejected', 'ROI_FELL_BELOW_THRESHOLD', `Executable ROI fell to ${current.roiBps} bps, below the active ${settings.minRoiBps} bps threshold`);
  }

  try {
    const execution = await execute(current.input);
    if (execution.executionResult?.unhedged) {
      return reject('partial_unhedged', 'PARTIAL_UNHEDGED', execution.reason || 'Placement left partial or unhedged exposure', execution);
    }
    if (!execution.executed) {
      return reject('failed', 'PLACEMENT_FAILED', execution.reason || 'Placement failed', execution);
    }
    return { state: 'placed', reasonCode: 'PAPER_PLACED', reason: execution.reason || 'Paper placement completed', execution };
  } catch (error) {
    return reject('failed', 'PLACEMENT_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export interface BotScanDecisionRow {
  id: number;
  idempotencyKey: string;
  scanId: number;
  marketId: string;
  marketTitle: string;
  outcome: string;
  state: BotScanDecisionState;
  reasonCode: string | null;
  reason: string | null;
  receivedAt: string;
  updatedAt: string;
  history: Array<{ state: BotScanDecisionState; at: string; reasonCode?: string; reason?: string }>;
}

/** Durable decision journal. The unique idempotency key is the concurrency gate. */
export class BotScanDecisionStore {
  private readonly db;
  private initialized = false;

  constructor(dbPath = path.join(process.cwd(), 'data', 'edgefinder.db')) {
    this.db = createClient({ url: `file:${dbPath}` });
    void this.db.execute('PRAGMA busy_timeout = 5000').catch(() => {});
  }

  async ensure(): Promise<void> {
    if (this.initialized) return;
    await this.db.execute(`CREATE TABLE IF NOT EXISTS bot_scan_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      scan_id INTEGER NOT NULL,
      market_id TEXT NOT NULL,
      market_title TEXT NOT NULL,
      outcome TEXT NOT NULL,
      state TEXT NOT NULL,
      reason_code TEXT,
      reason TEXT,
      received_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      history_json TEXT NOT NULL
    )`);
    await this.db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_scan_decision_scan_outcome ON bot_scan_decisions(scan_id, idempotency_key)');
    await this.db.execute('CREATE INDEX IF NOT EXISTS idx_bot_scan_decision_updated ON bot_scan_decisions(updated_at DESC)');
    this.initialized = true;
  }

  async receive(opportunity: CompletedScanOpportunity): Promise<{ row: BotScanDecisionRow; inserted: boolean }> {
    await this.ensure();
    const key = buildOpportunityKey(opportunity);
    const now = new Date().toISOString();
    const history = JSON.stringify([{ state: 'received', at: now }]);
    const inserted = await this.db.execute({
      sql: `INSERT OR IGNORE INTO bot_scan_decisions
        (idempotency_key, scan_id, market_id, market_title, outcome, state, received_at, updated_at, history_json)
        VALUES (?, ?, ?, ?, ?, 'received', ?, ?, ?)`,
      args: [key, opportunity.scanId, opportunity.marketId, opportunity.marketTitle, opportunity.outcome, now, now, history],
    });
    const row = await this.get(key);
    if (!row) throw new Error(`Unable to read BotTrader decision ${key}`);
    return { row, inserted: Number(inserted.rowsAffected ?? 0) === 1 };
  }

  async transition(key: string, state: BotScanDecisionState, reasonCode?: string, reason?: string): Promise<BotScanDecisionRow> {
    const current = await this.get(key);
    if (!current) throw new Error(`Unknown BotTrader decision ${key}`);
    const now = new Date().toISOString();
    const history = [...current.history, { state, at: now, ...(reasonCode ? { reasonCode } : {}), ...(reason ? { reason } : {}) }];
    await this.db.execute({
      sql: 'UPDATE bot_scan_decisions SET state = ?, reason_code = ?, reason = ?, updated_at = ?, history_json = ? WHERE idempotency_key = ?',
      args: [state, reasonCode ?? null, reason ?? null, now, JSON.stringify(history), key],
    });
    const updated = await this.get(key);
    if (!updated) throw new Error(`Unable to read updated BotTrader decision ${key}`);
    return updated;
  }

  async get(key: string): Promise<BotScanDecisionRow | null> {
    await this.ensure();
    const result = await this.db.execute({ sql: 'SELECT * FROM bot_scan_decisions WHERE idempotency_key = ?', args: [key] });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? this.map(row) : null;
  }

  async list(limit = 500): Promise<BotScanDecisionRow[]> {
    await this.ensure();
    const result = await this.db.execute({ sql: 'SELECT * FROM bot_scan_decisions ORDER BY id DESC LIMIT ?', args: [Math.min(500, Math.max(1, limit))] });
    return (result.rows as unknown as Record<string, unknown>[]).map((row) => this.map(row));
  }

  close(): void { this.db.close(); }

  private map(row: Record<string, unknown>): BotScanDecisionRow {
    return {
      id: Number(row.id), idempotencyKey: String(row.idempotency_key), scanId: Number(row.scan_id),
      marketId: String(row.market_id), marketTitle: String(row.market_title), outcome: String(row.outcome),
      state: String(row.state) as BotScanDecisionState,
      reasonCode: row.reason_code == null ? null : String(row.reason_code),
      reason: row.reason == null ? null : String(row.reason), receivedAt: String(row.received_at),
      updatedAt: String(row.updated_at), history: JSON.parse(String(row.history_json)),
    };
  }
}

export const BOT_SCAN_CONSUMER_INSTANCE = randomUUID();
