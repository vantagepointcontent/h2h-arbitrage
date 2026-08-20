import { createClient } from '@libsql/client';
import path from 'path';
import { evaluateLogsDataQuality } from '../src/lib/logs-data-quality.ts';

const dbPath = path.resolve(process.cwd(), 'data', 'edgefinder.db');
const c = createClient({ url: `file:${dbPath}` });

const LOGS_REQUIRED_FIELDS = ['roi', 'profit', 'apy', 'state', 'currentRoi'];

async function ensureSchema() {
  await c.execute(`CREATE TABLE IF NOT EXISTS logs_data_quality_batches (
    scan_id INTEGER PRIMARY KEY,
    observed_at TEXT NOT NULL,
    state TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    reconciliation_attempts INTEGER NOT NULL DEFAULT 0
  )`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_logs_data_quality_observed ON logs_data_quality_batches(observed_at DESC, scan_id DESC)`);
  await c.execute(`CREATE TABLE IF NOT EXISTS logs_data_quality_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
  )`);
}

function reason(available, code) {
  return available ? undefined : code;
}

function isUsableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0;
}

async function backfill() {
  const hasTable = await c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='logs_data_quality_batches'");
  if (hasTable.rows.length === 0) await ensureSchema();

  const recent = await c.execute(`SELECT id, strategy, positive_arb_count, best_roi_pct, best_profit,
    apy_pct, total_stake, raw_result, calculation_envelope, days_to_expiry, scan_status,
    arb_valid, kalshi_url, polymarket_url, scanned_at
    FROM scan_results WHERE scan_status = 'completed' AND arb_valid = 1 AND positive_arb_count > 0
      AND id NOT IN (SELECT scan_id FROM logs_data_quality_batches)
    ORDER BY scanned_at DESC, id DESC LIMIT 1000`);

  let previousBatch = null;
  const existing = await c.execute('SELECT snapshot_json FROM logs_data_quality_batches ORDER BY observed_at DESC, scan_id DESC LIMIT 1');
  try {
    previousBatch = typeof existing.rows[0]?.snapshot_json === 'string'
      ? JSON.parse(String(existing.rows[0].snapshot_json))
      : null;
  } catch {}

  let inserted = 0;
  for (const row of [...recent.rows].reverse()) {
    const id = Number(row.id);
    const roi = isUsableNumber(row.best_roi_pct) ? row.best_roi_pct : null;
    const profit = isUsableNumber(row.best_profit) ? row.best_profit : null;
    const apy = isUsableNumber(row.apy_pct) ? row.apy_pct : null;
    const stake = isUsableNumber(row.total_stake) ? row.total_stake : null;
    const exactIdentity = typeof row.kalshi_url === 'string' && row.kalshi_url.length > 0
      && typeof row.polymarket_url === 'string' && row.polymarket_url.length > 0;
    const apyEligible = typeof row.days_to_expiry === 'number' && Number.isFinite(row.days_to_expiry) && row.days_to_expiry > 0;

    const snapshot = evaluateLogsDataQuality({
      batchId: `scan:${id}`,
      previousBatch,
      rows: [{
        id,
        scanStatus: 'completed',
        positiveArbCount: Number(row.positive_arb_count),
        arbValid: row.arb_valid === 1,
        roiPct: roi,
        profitUsd: profit,
        apyPct: apy,
        apyEligible,
        state: 'completed',
        exactMarketIdentity: exactIdentity,
        currentRoiPct: exactIdentity ? roi : null,
        reasons: {
          roi: reason(roi != null, 'persistence_field_missing'),
          profit: reason(profit != null, 'persistence_field_missing'),
          apy: reason(apy != null, apyEligible ? 'historical_apy_not_persisted' : 'missing_event_time_tte'),
          state: undefined,
          currentRoi: reason(exactIdentity, 'missing_exact_link_identity'),
        },
      }],
    });

    await c.execute({
      sql: `INSERT OR IGNORE INTO logs_data_quality_batches
        (scan_id, observed_at, state, snapshot_json, reconciliation_attempts) VALUES (?, ?, ?, ?, ?)`,
      args: [id, String(row.scanned_at), snapshot.state, JSON.stringify(snapshot), snapshot.reconciliation.requested ? 2 : 0],
    });
    const changes = await c.execute('SELECT changes()');
    inserted += Number(changes.rows[0]['changes()']);
    previousBatch = snapshot;
  }

  return inserted;
}

async function report() {
  const rows = await c.execute('SELECT state, snapshot_json FROM logs_data_quality_batches ORDER BY observed_at DESC, scan_id DESC LIMIT 500');
  const snapshots = rows.rows.flatMap((row) => { try { return [JSON.parse(String(row.snapshot_json))]; } catch { return []; } });
  const fields = {};
  for (const field of LOGS_REQUIRED_FIELDS) {
    const denominator = snapshots.reduce((sum, s) => sum + (s.fields[field]?.denominator ?? 0), 0);
    const unavailable = snapshots.reduce((sum, s) => sum + (s.fields[field]?.unavailable ?? 0), 0);
    fields[field] = { denominator, unavailable, unavailablePct: denominator === 0 ? 0 : unavailable * 100 / denominator };
  }
  console.log('rolling batches:', snapshots.length, 'degraded:', snapshots.filter((s) => s.state === 'degraded').length);
  for (const [field, m] of Object.entries(fields)) {
    const pct = m.unavailablePct.toFixed(2);
    const ok = m.unavailablePct <= 5 ? 'OK' : 'FAIL';
    console.log(`  ${field}: ${m.denominator - m.unavailable}/${m.denominator} unavailable ${pct}% [${ok}]`);
  }
  if (snapshots[0]) {
    console.log('latest state:', snapshots[0].state, 'breaches:', snapshots[0].breaches.length);
  }
}

async function main() {
  await c.execute('PRAGMA busy_timeout = 5000');
  const inserted = await backfill();
  console.log('backfilled batches:', inserted);
  await report();
  await c.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
