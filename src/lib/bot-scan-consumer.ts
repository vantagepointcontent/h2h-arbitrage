import { createClient } from '@libsql/client';
import path from 'path';
import { evaluateBotTrade, getBotSettings, maybeExecuteBotTrade, type BotExecutionResult, type BotSettings, type BotTradeInput } from './bot-trader';
import logger from './logger';

export type BotScanSource = 'scan_api' | 'watcher' | 'scheduled' | 'catch_up';
export type BotScanDecisionState =
  | 'received'
  | 'criteria_rejected'
  | 'revalidation_rejected'
  | 'placement_attempted'
  | 'placed'
  | 'partial_or_unhedged'
  | 'failed'
  | 'disabled'
  | 'stale'
  | 'daily_limit'
  | 'duplicate_replay';

export interface BotScanFees {
  kalshiFee: number;
  pmFee: number;
}

export interface BotScanCandidate {
  outcome: string;
  strategy: string;
  roiPct: number;
  apyPct?: number | null;
  expectedProfit: number;
  kalshiStake: number;
  pmStake: number;
  kalshiTicker: string;
  pmConditionId: string;
  kalshiYesAsk: number | null;
  kalshiNoAsk: number | null;
  pmYesAsk: number | null;
  pmNoAsk: number | null;
  kalshiYesDepth: number;
  kalshiNoDepth: number;
  pmYesDepth: number;
  pmNoDepth: number;
  fees: BotScanFees | null;
  expiryDate?: string | null;
  category?: string;
  stale?: boolean;
}

export interface PersistedBotScan {
  id: number;
  marketId: string;
  marketTitle: string;
  scannedAt: string;
  positiveArbCount: number;
  candidates: BotScanCandidate[];
}

export interface BotScanDecision {
  scanId: number;
  idempotencyKey: string;
  source: BotScanSource;
  state: BotScanDecisionState;
  reasonCode: string;
  reason: string;
  receivedAt: string;
  updatedAt: string;
  attempts: number;
  placementCount: number;
  details: unknown;
  leaseOwner?: string | null;
}

type DecisionUpdate = Pick<BotScanDecision, 'state' | 'reasonCode' | 'reason'> & Partial<Pick<BotScanDecision, 'attempts' | 'placementCount' | 'details'>>;

export interface BotScanConsumerDeps {
  now(): Date;
  getSettings(): Promise<BotSettings>;
  loadScan(scanId: number): Promise<PersistedBotScan | null>;
  listBacklog(limit: number): Promise<PersistedBotScan[]>;
  acquire(scan: PersistedBotScan, source: BotScanSource): Promise<BotScanDecision | null>;
  transition(scanId: number, leaseOwner: string, update: DecisionUpdate): Promise<BotScanDecision>;
  finish(scanId: number, leaseOwner: string, update: DecisionUpdate): Promise<BotScanDecision>;
  recordReplay(scanId: number, source: BotScanSource): Promise<void>;
  advanceCursor(scanId: number): Promise<void>;
  revalidate(scan: PersistedBotScan): Promise<BotScanCandidate[]>;
  execute(input: BotTradeInput): Promise<BotExecutionResult>;
  reserveOpportunity?(candidate: BotScanCandidate): Promise<boolean>;
  releaseOpportunity?(candidate: BotScanCandidate): Promise<void>;
  retainOpportunityForExposure?(candidate: BotScanCandidate): Promise<void>;
  maxScanAgeMs?: number;
}

export interface BotScanConsumer {
  consume(scanId: number, source?: BotScanSource): Promise<BotScanDecision>;
  processBacklog(limit?: number): Promise<BotScanDecision[]>;
}

const TERMINAL_REPLAY: BotScanDecision = {
  scanId: 0,
  idempotencyKey: '',
  source: 'catch_up',
  state: 'duplicate_replay',
  reasonCode: 'duplicate_replay',
  reason: 'Scan was already claimed or processed; no duplicate placement was attempted',
  receivedAt: '',
  updatedAt: '',
  attempts: 0,
  placementCount: 0,
  details: null,
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validFees(fees: BotScanFees | null): fees is BotScanFees {
  return fees != null && finite(fees.kalshiFee) && fees.kalshiFee >= 0 && finite(fees.pmFee) && fees.pmFee >= 0;
}

function candidateToInput(scan: PersistedBotScan, item: BotScanCandidate, settings: BotSettings): BotTradeInput {
  return {
    pairId: scan.marketId,
    marketTitle: scan.marketTitle,
    outcome: item.outcome,
    strategy: item.strategy,
    roiPct: item.roiPct,
    apyPct: item.apyPct ?? null,
    expectedProfit: item.expectedProfit,
    kalshiStake: item.kalshiStake,
    pmStake: item.pmStake,
    kalshiTicker: item.kalshiTicker,
    pmConditionId: item.pmConditionId,
    kalshiYesAsk: item.kalshiYesAsk,
    kalshiNoAsk: item.kalshiNoAsk,
    pmYesAsk: item.pmYesAsk,
    pmNoAsk: item.pmNoAsk,
    kalshiYesDepth: item.kalshiYesDepth,
    kalshiNoDepth: item.kalshiNoDepth,
    pmYesDepth: item.pmYesDepth,
    pmNoDepth: item.pmNoDepth,
    expiryDate: item.expiryDate ?? null,
    category: item.category,
    selectionMethod: settings.selectionMethod,
  };
}

function sameProposition(before: BotScanCandidate, current: BotScanCandidate): boolean {
  return before.outcome === current.outcome
    && before.strategy === current.strategy
    && before.kalshiTicker === current.kalshiTicker
    && before.pmConditionId === current.pmConditionId;
}

function sameNamedCandidate(before: BotScanCandidate, current: BotScanCandidate): boolean {
  return before.outcome === current.outcome && before.strategy === current.strategy;
}

function rejection(
  state: Extract<BotScanDecisionState, 'criteria_rejected' | 'revalidation_rejected' | 'disabled' | 'stale'>,
  reasonCode: string,
  reason: string,
  details: unknown = null,
): DecisionUpdate {
  return { state, reasonCode, reason, placementCount: 0, details };
}

export function createBotScanConsumer(deps: BotScanConsumerDeps): BotScanConsumer {
  const maxScanAgeMs = deps.maxScanAgeMs ?? 5 * 60_000;

  async function consume(scanId: number, source: BotScanSource = 'catch_up'): Promise<BotScanDecision> {
    const scan = await deps.loadScan(scanId);
    if (!scan) {
      return { ...TERMINAL_REPLAY, scanId, idempotencyKey: `scan:${scanId}`, source, reasonCode: 'scan_not_found', reason: `Persisted scan ${scanId} was not found` };
    }

    const claimed = await deps.acquire(scan, source);
    if (!claimed) {
      await deps.recordReplay(scanId, source);
      return { ...TERMINAL_REPLAY, scanId, idempotencyKey: `scan:${scanId}`, source, receivedAt: scan.scannedAt, updatedAt: deps.now().toISOString() };
    }

    const finish = async (update: DecisionUpdate) => {
      const result = await deps.finish(scanId, claimed.leaseOwner ?? '', update);
      await deps.advanceCursor(scanId);
      return result;
    };

    const settings = await deps.getSettings();
    if (!settings.enabled) {
      return finish(rejection('disabled', 'bot_disabled', 'BotTrader was disabled when this persisted scan was consumed'));
    }

    const scannedAtMs = Date.parse(scan.scannedAt);
    const ageMs = deps.now().getTime() - scannedAtMs;
    if (!Number.isFinite(scannedAtMs) || ageMs < 0 || ageMs > maxScanAgeMs) {
      return finish(rejection('stale', 'scan_stale', `Persisted scan is stale or has an invalid timestamp (age ${Number.isFinite(ageMs) ? ageMs : 'unknown'}ms)`, { ageMs, maxScanAgeMs }));
    }

    if (scan.positiveArbCount <= 0 || scan.candidates.length === 0) {
      return finish(rejection('criteria_rejected', 'malformed_scan', 'Positive-arbitrage scan has no parseable candidate rows'));
    }

    const initiallyEligible = scan.candidates.filter((item) => validFees(item.fees) && evaluateBotTrade(candidateToInput(scan, item, settings), settings).shouldTrade);
    if (initiallyEligible.length === 0) {
      return finish(rejection('criteria_rejected', 'scan_criteria_rejected', 'No scan-time candidate satisfies the active BotTrader criteria with complete fee and depth data'));
    }

    let currentCandidates: BotScanCandidate[];
    try {
      currentCandidates = await deps.revalidate(scan);
    } catch (error) {
      return finish({
        state: 'failed',
        reasonCode: 'revalidation_failed',
        reason: `Executable revalidation failed before placement: ${error instanceof Error ? error.message : String(error)}`,
        placementCount: 0,
        details: { retryable: true },
      });
    }

    const executable: BotScanCandidate[] = [];
    const rejections: Array<{ outcome: string; code: string; reason: string }> = [];
    for (const original of initiallyEligible) {
      const current = currentCandidates.find((item) => sameProposition(original, item));
      if (!current) {
        const changed = currentCandidates.find((item) => sameNamedCandidate(original, item));
        rejections.push({
          outcome: original.outcome,
          code: 'market_identity_changed',
          reason: changed
            ? `Exact market identity changed (${original.kalshiTicker}/${original.pmConditionId} -> ${changed.kalshiTicker}/${changed.pmConditionId})`
            : 'Exact market/outcome identity was not present in the refreshed executable result',
        });
        continue;
      }
      if (current.stale) {
        rejections.push({ outcome: original.outcome, code: 'current_quote_stale', reason: 'Current executable quote is stale' });
        continue;
      }
      if (!validFees(current.fees)) {
        rejections.push({ outcome: original.outcome, code: 'fees_unavailable', reason: 'Authoritative current fee values are unavailable for one or both legs' });
        continue;
      }
      const evaluation = evaluateBotTrade(candidateToInput(scan, current, settings), settings);
      if (!evaluation.shouldTrade) {
        rejections.push({ outcome: original.outcome, code: 'current_criteria_rejected', reason: evaluation.reason });
        continue;
      }
      executable.push(current);
    }

    if (executable.length === 0) {
      const primary = rejections[0] ?? { code: 'current_criteria_rejected', reason: 'No refreshed candidate remained executable', outcome: '' };
      return finish(rejection('revalidation_rejected', primary.code, primary.reason, { rejections }));
    }

    const reserved: BotScanCandidate[] = [];
    for (const item of executable) {
      if (deps.reserveOpportunity && !(await deps.reserveOpportunity(item))) {
        rejections.push({ outcome: item.outcome, code: 'opportunity_already_claimed', reason: 'Exact economic legs are already reserved or have an open BotTrader position' });
        continue;
      }
      reserved.push(item);
    }
    if (reserved.length === 0) {
      return finish(rejection('criteria_rejected', 'opportunity_already_claimed', 'Every executable opportunity was already claimed by another scan', { rejections }));
    }

    await deps.transition(scanId, claimed.leaseOwner ?? '', {
      state: 'placement_attempted',
      reasonCode: 'placement_attempted',
      reason: `Attempting ${reserved.length} revalidated candidate placement(s)`,
      attempts: claimed.attempts + reserved.length,
      details: { rejections },
    });

    const results: Array<{ outcome: string; result?: BotExecutionResult; error?: string }> = [];
    const releaseRemaining = async (startIndex: number) => {
      for (const pending of reserved.slice(startIndex)) {
        await deps.releaseOpportunity?.(pending).catch((error) => {
          logger.warn('[bot-scan-consumer] failed to release unattempted opportunity reservation', { error: String(error) });
        });
      }
    };
    for (let index = 0; index < reserved.length; index++) {
      const item = reserved[index];
      try {
        const result = await deps.execute(candidateToInput(scan, item, settings));
        results.push({ outcome: item.outcome, result });
        if (result.executionResult?.unhedged === true) {
          await deps.retainOpportunityForExposure?.(item).catch((error) => {
            logger.error('[bot-scan-consumer] failed to retain reservation for unhedged exposure', { error: String(error) });
          });
          await releaseRemaining(index + 1);
          break;
        } else if (!result.executed) {
          await deps.releaseOpportunity?.(item).catch((error) => {
            logger.warn('[bot-scan-consumer] failed to release rejected opportunity reservation', { error: String(error) });
          });
        }
      } catch (error) {
        results.push({ outcome: item.outcome, error: error instanceof Error ? error.message : String(error) });
        // executeArb can throw after one venue accepted an order. Preserve this
        // reservation as possible exposure and stop all further placements.
        await deps.retainOpportunityForExposure?.(item).catch((retainError) => {
          logger.error('[bot-scan-consumer] failed to retain reservation after unknown execution outcome', { error: String(retainError) });
        });
        await releaseRemaining(index + 1);
        break;
      }
    }

    const unhedged = results.find((item) => item.result?.executionResult?.unhedged === true);
    const unknownExposure = results.find((item) => item.error);
    const placed = results.filter((item) => item.result?.executed === true);
    const dailyLimit = results.find((item) => /daily .*limit/i.test(item.result?.reason ?? ''));
    const failures = results.filter((item) => item.error || (!item.result?.executed && !/daily .*limit/i.test(item.result?.reason ?? '')));
    const dryRun = results.every((item) => item.result?.dryRun !== false);
    const details = { dryRun, results, rejections };

    if (unhedged) {
      return finish({ state: 'partial_or_unhedged', reasonCode: 'partial_or_unhedged', reason: unhedged.result?.reason ?? 'Placement left partial or unhedged exposure', placementCount: placed.length, attempts: claimed.attempts + reserved.length, details });
    }
    if (unknownExposure) {
      return finish({ state: 'partial_or_unhedged', reasonCode: 'execution_outcome_unknown', reason: `Execution outcome is unknown and may include venue exposure: ${unknownExposure.error}`, placementCount: placed.length, attempts: claimed.attempts + results.length, details });
    }
    if (placed.length > 0) {
      return finish({ state: 'placed', reasonCode: dryRun ? 'paper_placed' : 'production_placed', reason: `${placed.length} revalidated ${dryRun ? 'paper ' : ''}placement(s) completed`, placementCount: placed.length, attempts: claimed.attempts + reserved.length, details });
    }
    if (dailyLimit) {
      return finish({ state: 'daily_limit', reasonCode: 'daily_limit', reason: dailyLimit.result?.reason ?? 'Daily BotTrader limit reached', placementCount: 0, attempts: claimed.attempts + reserved.length, details });
    }
    const firstFailure = failures[0];
    return finish({ state: 'failed', reasonCode: 'placement_failed', reason: firstFailure?.error ?? firstFailure?.result?.reason ?? 'All placement attempts failed', placementCount: 0, attempts: claimed.attempts + reserved.length, details });
  }

  async function processBacklog(limit = 100): Promise<BotScanDecision[]> {
    const scans = await deps.listBacklog(Math.min(1000, Math.max(1, limit)));
    const results: BotScanDecision[] = [];
    for (const item of scans) results.push(await consume(item.id, 'catch_up'));
    return results;
  }

  return { consume, processBacklog };
}

const DB_PATH = path.join(process.cwd(), 'data', 'edgefinder.db');
let schemaReady = false;

function dbClient() {
  const db = createClient({ url: `file:${DB_PATH}` });
  void db.execute('PRAGMA busy_timeout = 5000').catch(() => {});
  return db;
}

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const db = dbClient();
  try {
    await db.batch([
      `CREATE TABLE IF NOT EXISTS bot_scan_decisions (
        scan_id INTEGER PRIMARY KEY REFERENCES scan_results(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        reason TEXT NOT NULL,
        received_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        placement_count INTEGER NOT NULL DEFAULT 0,
        details TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS bot_scan_decision_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        details TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_bot_scan_decisions_state ON bot_scan_decisions(state, scan_id)`,
      `CREATE INDEX IF NOT EXISTS idx_bot_scan_events_scan ON bot_scan_decision_events(scan_id, id)`,
      `CREATE TABLE IF NOT EXISTS bot_scan_cursor (consumer TEXT PRIMARY KEY, last_scan_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
    ], 'write');
    schemaReady = true;
  } finally {
    db.close();
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function parseDepth(value: unknown): number {
  if (finite(value)) return value > 0 ? value : 0;
  if (typeof value !== 'string') return 0;
  const match = value.trim().replace(/^\$/, '').match(/^(\d[\d,]*(?:\.\d+)?)\s*([KMB]?)$/i);
  if (!match) return 0;
  let amount = Number(match[1].replaceAll(',', ''));
  const suffix = match[2].toUpperCase();
  if (suffix === 'K') amount *= 1_000;
  if (suffix === 'M') amount *= 1_000_000;
  if (suffix === 'B') amount *= 1_000_000_000;
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export function parseBotScanCandidate(value: unknown, expiryDate?: string | null, category?: string): BotScanCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const fees = row.fees && typeof row.fees === 'object' ? row.fees as Record<string, unknown> : null;
  const pmFee = fees?.pmFee ?? fees?.polymarketFee;
  if (typeof row.artist !== 'string' || typeof row.strategy !== 'string'
      || !finite(row.roiPct) || !finite(row.expectedProfit)
      || typeof row.kalshiTicker !== 'string' || typeof row.pmConditionId !== 'string') return null;
  return {
    outcome: row.artist,
    strategy: row.strategy,
    roiPct: row.roiPct,
    apyPct: finite(row.apyPct) ? row.apyPct : null,
    expectedProfit: row.expectedProfit,
    kalshiStake: finite(row.kalshiStake) ? row.kalshiStake : 0,
    pmStake: finite(row.pmStake) ? row.pmStake : 0,
    kalshiTicker: row.kalshiTicker,
    pmConditionId: row.pmConditionId,
    kalshiYesAsk: finite(row.kalshiYesAsk) ? row.kalshiYesAsk : null,
    kalshiNoAsk: finite(row.kalshiNoAsk) ? row.kalshiNoAsk : null,
    // `pmYesPrice` may be a CLOB/Gamma midpoint and is never executable.
    pmYesAsk: finite(row.pmBestAsk) ? row.pmBestAsk : finite(row.pmYesAsk) ? row.pmYesAsk : null,
    pmNoAsk: finite(row.pmNoPrice) ? row.pmNoPrice : finite(row.pmNoAsk) ? row.pmNoAsk : null,
    kalshiYesDepth: parseDepth(row.kalshiYesDepth),
    kalshiNoDepth: parseDepth(row.kalshiNoDepth),
    pmYesDepth: parseDepth(row.pmYesDepth),
    pmNoDepth: parseDepth(row.pmNoDepth),
    fees: fees && finite(fees.kalshiFee) && finite(pmFee) ? { kalshiFee: fees.kalshiFee, pmFee } : null,
    expiryDate: typeof row.expiryDate === 'string' ? row.expiryDate : expiryDate,
    category: typeof row.category === 'string' ? row.category : category,
    stale: row.stale === true,
  };
}

function rowToScan(row: Record<string, unknown>): PersistedBotScan {
  const raw = parseJson(row.raw_result) as { allArbs?: unknown[]; expiryDate?: string; category?: string } | null;
  return {
    id: Number(row.id),
    marketId: String(row.market_id),
    marketTitle: String(row.market_title || row.market_id),
    scannedAt: String(row.scanned_at),
    positiveArbCount: Number(row.positive_arb_count ?? 0),
    candidates: (raw?.allArbs ?? []).map((item) => parseBotScanCandidate(item, raw?.expiryDate, raw?.category)).filter((item): item is BotScanCandidate => item != null),
  };
}

function rowToDecision(row: Record<string, unknown>): BotScanDecision {
  return {
    scanId: Number(row.scan_id), idempotencyKey: String(row.idempotency_key), source: row.source as BotScanSource,
    state: row.state as BotScanDecisionState, reasonCode: String(row.reason_code), reason: String(row.reason),
    receivedAt: String(row.received_at), updatedAt: String(row.updated_at), attempts: Number(row.attempts ?? 0),
    placementCount: Number(row.placement_count ?? 0), details: parseJson(row.details),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
  };
}

async function loadScan(scanId: number): Promise<PersistedBotScan | null> {
  await ensureSchema();
  const db = dbClient();
  try {
    const result = await db.execute({ sql: 'SELECT * FROM scan_results WHERE id = ? AND positive_arb_count > 0', args: [scanId] });
    const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
    return row ? rowToScan(row) : null;
  } finally { db.close(); }
}

async function listBacklog(limit: number): Promise<PersistedBotScan[]> {
  await ensureSchema();
  const db = dbClient();
  try {
    const result = await db.execute({
      sql: `SELECT s.* FROM scan_results s
        LEFT JOIN bot_scan_decisions d ON d.scan_id = s.id
        WHERE s.positive_arb_count > 0 AND (
          d.scan_id IS NULL OR d.state IN ('received','disabled')
          OR (d.state = 'failed' AND d.reason_code = 'revalidation_failed')
        )
        ORDER BY s.id ASC LIMIT ?`,
      args: [limit],
    });
    return (result.rows as unknown as Record<string, unknown>[]).map(rowToScan);
  } finally { db.close(); }
}

async function acquire(scan: PersistedBotScan, source: BotScanSource): Promise<BotScanDecision | null> {
  await ensureSchema();
  const db = dbClient();
  const owner = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + 15 * 60_000).toISOString();
  try {
    await db.execute({
      sql: `INSERT INTO bot_scan_decisions
        (scan_id,idempotency_key,source,state,reason_code,reason,received_at,updated_at)
        VALUES (?,?,?,'received','scan_received','Persisted positive-arbitrage scan received',?,?)
        ON CONFLICT(scan_id) DO NOTHING`,
      args: [scan.id, `scan:${scan.id}`, source, now.toISOString(), now.toISOString()],
    });
    const claimed = await db.execute({
      sql: `UPDATE bot_scan_decisions SET lease_owner=?, lease_expires_at=?, source=?, state='received',
        reason_code='scan_received', reason='Persisted positive-arbitrage scan received', updated_at=?
        WHERE scan_id=?
          AND (state IN ('received','disabled') OR (state='failed' AND reason_code='revalidation_failed'))
          AND (lease_owner IS NULL OR lease_expires_at < ?)
        RETURNING *`,
      args: [owner, expires, source, now.toISOString(), scan.id, now.toISOString()],
    });
    const row = claimed.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!row) return null;
    await appendEvent(db, scan.id, source, 'received', 'scan_received', 'Persisted positive-arbitrage scan received', null);
    return rowToDecision(row);
  } finally { db.close(); }
}

async function appendEvent(db: ReturnType<typeof createClient>, scanId: number, source: BotScanSource, state: BotScanDecisionState, code: string, reason: string, details: unknown) {
  await db.execute({
    sql: `INSERT INTO bot_scan_decision_events (scan_id,source,state,reason_code,reason,created_at,details) VALUES (?,?,?,?,?,?,?)`,
    args: [scanId, source, state, code, reason, new Date().toISOString(), details == null ? null : JSON.stringify(details)],
  });
}

async function updateDecision(scanId: number, leaseOwner: string, update: DecisionUpdate, release: boolean): Promise<BotScanDecision> {
  await ensureSchema();
  const db = dbClient();
  try {
    const current = await db.execute({ sql: 'SELECT source, attempts, placement_count FROM bot_scan_decisions WHERE scan_id=? AND lease_owner=?', args: [scanId, leaseOwner] });
    const prior = current.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!prior) throw new Error(`Bot scan ${scanId} lease was lost before decision update`);
    const now = new Date().toISOString();
    const result = await db.execute({
      sql: `UPDATE bot_scan_decisions SET state=?,reason_code=?,reason=?,updated_at=?,attempts=?,placement_count=?,details=?,
        lease_owner=${release ? 'NULL' : 'lease_owner'},lease_expires_at=${release ? 'NULL' : 'lease_expires_at'} WHERE scan_id=? AND lease_owner=? RETURNING *`,
      args: [update.state, update.reasonCode, update.reason, now, update.attempts ?? Number(prior.attempts ?? 0), update.placementCount ?? Number(prior.placement_count ?? 0), update.details == null ? null : JSON.stringify(update.details), scanId, leaseOwner],
    });
    const updated = result.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!updated) throw new Error(`Bot scan ${scanId} lease expired during decision update`);
    await appendEvent(db, scanId, prior.source as BotScanSource, update.state, update.reasonCode, update.reason, update.details);
    return rowToDecision(updated);
  } finally { db.close(); }
}

async function recordReplay(scanId: number, source: BotScanSource) {
  await ensureSchema();
  const db = dbClient();
  try { await appendEvent(db, scanId, source, 'duplicate_replay', 'duplicate_replay', 'Scan was already claimed or processed; no duplicate placement was attempted', null); }
  finally { db.close(); }
}

async function advanceCursor(scanId: number) {
  await ensureSchema();
  const db = dbClient();
  const now = new Date().toISOString();
  try {
    await db.execute({
      sql: `INSERT INTO bot_scan_cursor (consumer,last_scan_id,updated_at) VALUES ('bot_trader',?,?)
        ON CONFLICT(consumer) DO UPDATE SET last_scan_id=MAX(last_scan_id,excluded.last_scan_id),updated_at=excluded.updated_at`,
      args: [scanId, now],
    });
  } finally { db.close(); }
}

async function revalidate(scan: PersistedBotScan): Promise<BotScanCandidate[]> {
  const [{ getSavedMarketById }, { getManualMatches }, { refreshSingleMarket }] = await Promise.all([
    import('./persistence'), import('./manual-matches'), import('@/app/api/saved-markets/refresh/refresh-single'),
  ]);
  const market = await getSavedMarketById(scan.marketId);
  if (!market) throw new Error(`Saved market ${scan.marketId} is unavailable for exact revalidation`);
  const refreshed = await refreshSingleMarket(market, await getManualMatches());
  return (refreshed.allArbs as unknown[])
    .map((item) => parseBotScanCandidate(item, refreshed.expiryDate, market.category))
    .filter((item): item is BotScanCandidate => item != null);
}

async function reserveOpportunity(candidate: BotScanCandidate): Promise<boolean> {
  const { reserveBotMarketPair } = await import('./bot-positions');
  return reserveBotMarketPair(candidate.kalshiTicker, candidate.pmConditionId);
}

async function releaseOpportunity(candidate: BotScanCandidate): Promise<void> {
  const { releaseBotMarketPair } = await import('./bot-positions');
  await releaseBotMarketPair(candidate.kalshiTicker, candidate.pmConditionId);
}

async function retainOpportunityForExposure(candidate: BotScanCandidate): Promise<void> {
  const { retainBotMarketPairForExposure } = await import('./bot-positions');
  await retainBotMarketPairForExposure(candidate.kalshiTicker, candidate.pmConditionId);
}

const productionDeps: BotScanConsumerDeps = {
  now: () => new Date(), getSettings: getBotSettings, loadScan, listBacklog, acquire,
  transition: (id, owner, update) => updateDecision(id, owner, update, false),
  finish: (id, owner, update) => updateDecision(id, owner, update, true),
  recordReplay, advanceCursor, revalidate, execute: maybeExecuteBotTrade,
  reserveOpportunity, releaseOpportunity, retainOpportunityForExposure,
};

const consumer = createBotScanConsumer(productionDeps);

export async function consumePersistedBotScan(scanId: number, source: BotScanSource): Promise<BotScanDecision> {
  return consumer.consume(scanId, source);
}

export async function processBotScanBacklog(limit = 100): Promise<BotScanDecision[]> {
  return consumer.processBacklog(limit);
}

export async function getBotScanDecisions(limit = 100): Promise<BotScanDecision[]> {
  await ensureSchema();
  const db = dbClient();
  try {
    const result = await db.execute({ sql: 'SELECT * FROM bot_scan_decisions ORDER BY scan_id DESC LIMIT ?', args: [Math.min(500, Math.max(1, limit))] });
    return (result.rows as unknown as Record<string, unknown>[]).map(rowToDecision);
  } finally { db.close(); }
}

export async function persistAndConsumeBotScan(
  marketId: string,
  result: Parameters<typeof import('./persistence').saveScanResult>[1],
  source: BotScanSource,
): Promise<{ id: number; decision: BotScanDecision | null; backlogProcessed: number }> {
  const { saveScanResult } = await import('./persistence');
  const saved = await saveScanResult(marketId, result);
  const decision = (result.positiveArbCount ?? 0) > 0
    ? await consumePersistedBotScan(saved.id, source)
    : null;
  // Every completed scan tick, including a zero-arb scan, is a restart/downtime
  // catch-up opportunity. This keeps backlog progress independent of the UI and
  // does not require a new positive arb to wake the durable consumer.
  const backlog = await processBotScanBacklog(25).catch((error) => {
    logger.warn('[bot-scan-consumer] backlog processing failed', { error: String(error) });
    return [];
  });
  return { ...saved, decision, backlogProcessed: backlog.length };
}
