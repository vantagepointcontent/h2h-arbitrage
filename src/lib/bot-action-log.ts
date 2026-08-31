import { createClient } from '@libsql/client';
import path from 'path';

export type BotActionStatus = 'passed' | 'failed' | 'pending';
export type BotQualificationOutcome = 'qualified' | 'dead';

export interface BotActionLogInput {
  tradeId: string;
  trigger: string;
  marketId: string;
  marketTitle: string;
  timestamp?: string;
  step: string;
  action: string;
  requestPayload?: unknown;
  responsePayload?: unknown;
  responseStatus: BotActionStatus;
  errorReason?: string | null;
  durationMs?: number | null;
  alertMetadata?: unknown;
  qualificationOutcome?: BotQualificationOutcome | null;
}

export interface BotActionLogRow extends Omit<BotActionLogInput, 'requestPayload' | 'responsePayload' | 'alertMetadata' | 'timestamp'> {
  id: number;
  timestamp: string;
  positiveArb: boolean;
  requestPayload: unknown;
  responsePayload: unknown;
  alertMetadata: unknown;
}

const DB_PATH = path.join(process.cwd(), 'data', 'edgefinder.db');
let initialized = false;

function client() {
  const db = createClient({ url: `file:${DB_PATH}` });
  void db.execute('PRAGMA busy_timeout = 5000').catch(() => {});
  return db;
}

async function ensureTable(): Promise<void> {
  if (initialized) return;
  const db = client();
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS bot_action_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      market_id TEXT NOT NULL,
      market_title TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      step TEXT NOT NULL,
      action TEXT NOT NULL,
      request_payload TEXT,
      response_payload TEXT,
      response_status TEXT NOT NULL CHECK(response_status IN ('passed','failed','pending')),
      error_reason TEXT,
      duration_ms INTEGER,
      alert_metadata TEXT
    )`);
    const columns = await db.execute("PRAGMA table_info(bot_action_log)");
    const hasQualificationOutcome = columns.rows.some((row) => String(row.name) === 'qualification_outcome');
    if (!hasQualificationOutcome) {
      await db.execute("ALTER TABLE bot_action_log ADD COLUMN qualification_outcome TEXT CHECK(qualification_outcome IN ('qualified','dead'))");
    }
    await db.execute('CREATE INDEX IF NOT EXISTS idx_bot_action_log_trade ON bot_action_log(trade_id, id)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_bot_action_log_filters ON bot_action_log(timestamp DESC, response_status, market_id)');
    initialized = true;
  } finally {
    db.close();
  }
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

export async function appendBotActionLog(input: BotActionLogInput): Promise<number> {
  await ensureTable();
  const db = client();
  try {
    const result = await db.execute({
      sql: `INSERT INTO bot_action_log
        (trade_id, trigger, market_id, market_title, timestamp, step, action,
         request_payload, response_payload, response_status, error_reason, duration_ms, alert_metadata,
         qualification_outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [input.tradeId, input.trigger, input.marketId, input.marketTitle,
        input.timestamp ?? new Date().toISOString(), input.step, input.action,
        json(input.requestPayload), json(input.responsePayload), input.responseStatus,
        input.errorReason ?? null, input.durationMs ?? null, json(input.alertMetadata), input.qualificationOutcome ?? null],
    });
    return Number(result.lastInsertRowid ?? 0);
  } finally { db.close(); }
}

export async function pruneBotActionLogs(days = 30): Promise<number> {
  await ensureTable();
  const db = client();
  try {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = await db.execute({ sql: 'DELETE FROM bot_action_log WHERE timestamp < ?', args: [cutoff] });
    return Number(result.rowsAffected ?? 0);
  } finally { db.close(); }
}

export async function getBotActionLogs(filters: {
  status?: BotActionStatus;
  marketId?: string;
  since?: string;
  cursor?: number;
  limit?: number;
  qualified?: boolean;
  positiveArb?: boolean;
} = {}): Promise<{ rows: BotActionLogRow[]; nextCursor: number | null }> {
  await ensureTable();
  const conditions: string[] = [];
  const args: Array<string | number> = [];
  if (filters.status) { conditions.push('response_status = ?'); args.push(filters.status); }
  if (filters.marketId) { conditions.push('market_id = ?'); args.push(filters.marketId); }
  if (filters.since) { conditions.push('timestamp >= ?'); args.push(filters.since); }
  if (filters.cursor) { conditions.push('id < ?'); args.push(filters.cursor); }
  if (filters.qualified !== undefined) {
    if (filters.qualified) {
      conditions.push(`trade_id IN (
        SELECT qualified.trade_id FROM bot_action_log AS qualified
        WHERE qualified.qualification_outcome = 'qualified'
          AND qualified.step = 'safety-gate'
          AND EXISTS (
            SELECT 1 FROM bot_action_log AS detected
            WHERE detected.trade_id = qualified.trade_id
              AND detected.step = 'detection'
              AND detected.response_status = 'passed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM bot_action_log AS rejected
            WHERE rejected.trade_id = qualified.trade_id
              AND rejected.qualification_outcome = 'dead'
          )
      )`);
    } else {
      conditions.push(`trade_id IN (SELECT trade_id FROM bot_action_log WHERE qualification_outcome = 'dead')`);
    }
  }
  if (filters.positiveArb) {
    conditions.push(`trade_id IN (
      SELECT positive.trade_id FROM bot_action_log AS positive
      WHERE positive.step = 'detection'
        AND positive.response_status = 'passed'
    )`);
  }
  const limit = Math.min(500, Math.max(1, filters.limit ?? 200));
  args.push(limit + 1);
  const db = client();
  try {
    const result = await db.execute({
      sql: `SELECT bot_action_log.*, EXISTS (
          SELECT 1 FROM bot_action_log AS positive
          WHERE positive.trade_id = bot_action_log.trade_id
            AND positive.step = 'detection'
            AND positive.response_status = 'passed'
        ) AS positive_arb
        FROM bot_action_log ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      args,
    });
    const raw = result.rows as unknown as Array<Record<string, unknown>>;
    const hasMore = raw.length > limit;
    const page = raw.slice(0, limit);
    return {
      rows: page.map((row) => ({
        id: Number(row.id), tradeId: String(row.trade_id), trigger: String(row.trigger), positiveArb: Number(row.positive_arb) === 1,
        marketId: String(row.market_id), marketTitle: String(row.market_title), timestamp: String(row.timestamp),
        step: String(row.step), action: String(row.action), requestPayload: parse(row.request_payload),
        responsePayload: parse(row.response_payload), responseStatus: row.response_status as BotActionStatus,
        errorReason: row.error_reason == null ? null : String(row.error_reason),
        durationMs: row.duration_ms == null ? null : Number(row.duration_ms), alertMetadata: parse(row.alert_metadata),
        qualificationOutcome: row.qualification_outcome == null ? null : row.qualification_outcome as BotQualificationOutcome,
      })),
      nextCursor: hasMore ? Number(page.at(-1)?.id ?? 0) : null,
    };
  } finally { db.close(); }
}
