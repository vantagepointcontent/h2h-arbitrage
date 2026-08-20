import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { reconcileSavedMarketMatchSummaries, getSavedMarkets } from '../src/lib/persistence';

async function main() {
const dbPath = process.env.H2H_SQLITE_PATH || path.join(process.cwd(), 'data', 'edgefinder.db');
const before = await getSavedMarkets();
const db = createClient({ url: `file:${dbPath}` });
const integrity = await db.execute('PRAGMA integrity_check');
const rawBefore = await db.execute(`SELECT COUNT(*) AS count FROM saved_markets
  WHERE canonical_apy_pct IS NOT NULL AND (
    canonical_current_roi_pct IS NULL OR canonical_current_roi_pct <= 0
    OR canonical_current_strategy IS NULL OR canonical_current_strategy = 'No arb'
    OR canonical_current_days_to_expiry IS NULL OR canonical_current_days_to_expiry <= 0
    OR canonical_apy_revision IS NULL OR canonical_current_revision IS NULL
    OR canonical_apy_revision <> canonical_current_revision
  )`);
const backupPath = path.join(process.cwd(), 'backups', 'bug179-pre-reconcile-20260820T140712Z.db');
await fs.mkdir(path.dirname(backupPath), { recursive: true });
await fs.rm(backupPath, { force: true });
await db.execute(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
const beforeInvalid = before.filter((market) => market.canonicalApyPct != null && (
  market.canonicalCurrentRoiPct == null
  || market.canonicalCurrentStrategy === 'No arb'
  || market.canonicalCurrentDaysToExpiry == null
  || market.canonicalCurrentRevision !== market.canonicalApyRevision
));
const reconciled = await reconcileSavedMarketMatchSummaries();
await new Promise((resolve) => setTimeout(resolve, 750));
const after = await getSavedMarkets();
const afterInvalid = after.filter((market) => market.canonicalApyPct != null && (
  market.canonicalCurrentRoiPct == null
  || market.canonicalCurrentStrategy === 'No arb'
  || market.canonicalCurrentDaysToExpiry == null
  || market.canonicalCurrentRevision !== market.canonicalApyRevision
));
const alertCount = await db.execute('SELECT COUNT(*) AS count FROM saved_market_metric_alerts');
const triggerRows = await db.execute(`SELECT name FROM sqlite_master
  WHERE type = 'trigger' AND name IN ('saved_market_metric_revision_guard', 'saved_market_apy_invariant_guard')
  ORDER BY name`);
const remainingRaw = await db.execute(`SELECT id, event_title, canonical_apy_pct,
    canonical_current_roi_pct, canonical_current_strategy, canonical_current_days_to_expiry,
    canonical_apy_revision, canonical_current_revision
  FROM saved_markets
  WHERE canonical_apy_pct IS NOT NULL AND (
    canonical_current_roi_pct IS NULL OR canonical_current_roi_pct <= 0
    OR canonical_current_strategy IS NULL OR canonical_current_strategy = 'No arb'
    OR canonical_current_days_to_expiry IS NULL OR canonical_current_days_to_expiry <= 0
    OR canonical_apy_revision IS NULL OR canonical_current_revision IS NULL
    OR canonical_apy_revision <> canonical_current_revision
  ) ORDER BY event_title`);
db.close();
const report = {
  generatedAt: new Date().toISOString(),
  integrityCheck: integrity.rows.map((row) => String(row.integrity_check)),
  backupPath,
  marketCount: after.length,
  reconciledRows: reconciled,
  beforeInvalidCount: beforeInvalid.length,
  beforeRawInvalidCount: Number(rawBefore.rows[0]?.count ?? 0),
  afterInvalidCount: afterInvalid.length,
  telemetryAlertCount: Number(alertCount.rows[0]?.count ?? 0),
  installedGuards: triggerRows.rows.map((row) => String(row.name)),
  unrepairedRows: remainingRaw.rows,
};
await fs.mkdir(path.join(process.cwd(), 'artifacts'), { recursive: true });
await fs.writeFile(path.join(process.cwd(), 'artifacts', 'bug179-reconciliation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
