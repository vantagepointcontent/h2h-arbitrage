import { createClient } from '@libsql/client';
import { writeFile } from 'node:fs/promises';
import { getCanonicalSavedMarketsBasicSnapshot } from '../src/lib/saved-markets-list.ts';

const base = 'http://127.0.0.1:3000';
const json = async (path, options) => {
  const response = await fetch(base + path, { cache: 'no-store', ...options });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
};
const invalidCurrentMetric = (market) => market.canonicalApyPct != null && (
  !(Number.isFinite(market.canonicalCurrentRoiPct) && market.canonicalCurrentRoiPct > 0)
  || !(Number.isFinite(market.canonicalCurrentProfit) && market.canonicalCurrentProfit > 0)
  || typeof market.canonicalCurrentStrategy !== 'string'
  || market.canonicalCurrentStrategy === 'No arb'
  || market.canonicalCurrentStrategy.startsWith('Unavailable')
  || !(Number.isFinite(market.canonicalCurrentDaysToExpiry) && market.canonicalCurrentDaysToExpiry > 0)
  || !market.canonicalCurrentExpiryAt
  || !Number.isSafeInteger(market.canonicalApyRevision)
  || market.canonicalApyRevision !== market.canonicalCurrentRevision
);
const fields = [
  'canonicalApyPct', 'canonicalApyUnavailableReason', 'canonicalApyRevision',
  'canonicalCurrentRoiPct', 'canonicalCurrentProfit', 'canonicalCurrentStrategy',
  'canonicalCurrentDaysToExpiry', 'canonicalCurrentExpiryAt', 'canonicalCurrentRevision',
];

const health = await json('/api/health');
const cutoff = new Date().toISOString();
const fixed = `&toDate=${encodeURIComponent(cutoff)}`;
const first = await json(`/api/logs?limit=500${fixed}`);
if (first.logs.length !== 500 || !first.nextCursor) throw new Error('First Logs page is incomplete');
const second = await json(`/api/logs?limit=500&before=${encodeURIComponent(first.nextCursor)}${fixed}`);
const firstIds = new Set(first.logs.map((row) => row.id));
const overlap = second.logs.filter((row) => firstIds.has(row.id)).length;
const direct = await json(`/api/logs?arbType=direct&limit=500${fixed}`);
const directRowsValid = direct.logs.every((row) => row.arb_type === 'direct' && row.arb_valid === 1 && row.positive_arb_count > 0);
const summaryReconciles = first.summary.totalArbs === first.summary.arbTypeCounts.direct
  + first.summary.arbTypeCounts.cross + first.summary.arbTypeCounts.internal;

const csvResponse = await fetch(`${base}/api/logs/export?arbType=direct&limit=500${fixed}`, { cache: 'no-store' });
if (!csvResponse.ok) throw new Error(`Logs CSV returned ${csvResponse.status}`);
const csv = await csvResponse.text();
const csvLines = csv.trimEnd().split('\n');
const csvHeader = csvLines[0];
const csvContract = csvHeader.includes('Arb Type') && csvHeader.includes('Invalidation Reason')
  && csvHeader.includes('Scan Status') && csvHeader.includes('Scan Status Explanation')
  && csvHeader.includes('BotTrader Evaluation Status') && !csv.includes('Invalid arb');

const marketsResponse = await json('/api/saved-markets?fields=basic');
const markets = marketsResponse.markets ?? marketsResponse;
const refreshed = await getCanonicalSavedMarketsBasicSnapshot();
const refreshedById = new Map(refreshed.markets.map((market) => [market.id, market]));
const refreshParityMismatches = [];
for (const market of markets) {
  const peer = refreshedById.get(market.id);
  if (!peer || fields.some((field) => (market[field] ?? null) !== (peer[field] ?? null))) {
    refreshParityMismatches.push(market.id);
    if (refreshParityMismatches.length >= 10) break;
  }
}
const invalidBeforeRace = markets.filter(invalidCurrentMetric).length;
const apyRows = markets.filter((market) => market.canonicalApyPct != null);
const sortedApy = [...apyRows].sort((left, right) => right.canonicalApyPct - left.canonicalApyPct);
const apySortMonotonic = sortedApy.every((market, index) => index === 0
  || sortedApy[index - 1].canonicalApyPct >= market.canonicalApyPct);

const db = createClient({ url: 'file:data/edgefinder.db' });
const integrity = String((await db.execute('PRAGMA integrity_check')).rows[0].integrity_check);
const foreignKeyViolations = (await db.execute('PRAGMA foreign_key_check')).rows.length;
const triggers = (await db.execute(`SELECT name FROM sqlite_master WHERE type='trigger'
  AND name IN ('saved_market_apy_invariant_guard','saved_market_metric_revision_guard') ORDER BY name`)).rows.map((row) => String(row.name));
const dbInvalidBeforeRace = Number((await db.execute(`SELECT COUNT(*) AS count FROM saved_markets
  WHERE canonical_apy_pct IS NOT NULL AND (
    canonical_current_roi_pct IS NULL OR canonical_current_roi_pct <= 0
    OR canonical_current_profit IS NULL OR canonical_current_profit <= 0
    OR canonical_current_strategy IS NULL OR canonical_current_strategy = 'No arb'
    OR canonical_current_strategy LIKE 'Unavailable%'
    OR canonical_current_days_to_expiry IS NULL OR canonical_current_days_to_expiry <= 0
    OR canonical_current_expiry_at IS NULL
    OR canonical_apy_revision IS NULL OR canonical_current_revision IS NULL
    OR canonical_apy_revision <> canonical_current_revision)`)).rows[0].count);
await new Promise((resolve) => setTimeout(resolve, 35_000));
const afterRaceResponse = await json('/api/saved-markets?fields=basic');
const afterRaceMarkets = afterRaceResponse.markets ?? afterRaceResponse;
const invalidAfterRace = afterRaceMarkets.filter(invalidCurrentMetric).length;
const dbInvalidAfterRace = Number((await db.execute(`SELECT COUNT(*) AS count FROM saved_markets
  WHERE canonical_apy_pct IS NOT NULL AND (
    canonical_current_roi_pct IS NULL OR canonical_current_roi_pct <= 0
    OR canonical_current_profit IS NULL OR canonical_current_profit <= 0
    OR canonical_current_strategy IS NULL OR canonical_current_strategy = 'No arb'
    OR canonical_current_days_to_expiry IS NULL OR canonical_current_days_to_expiry <= 0
    OR canonical_apy_revision IS NULL OR canonical_current_revision IS NULL
    OR canonical_apy_revision <> canonical_current_revision)`)).rows[0].count);
db.close();

const report = {
  verifiedAt: new Date().toISOString(),
  deployment: health.deployment,
  logs: {
    total: first.total,
    firstPageRows: first.logs.length,
    secondPageRows: second.logs.length,
    secondPageOverlap: overlap,
    firstPageFirstId: first.logs[0]?.id ?? null,
    secondPageFirstId: second.logs[0]?.id ?? null,
    summary: first.summary,
    summaryReconciles,
    directFilterTotal: direct.total,
    directRowsValid,
    csvRows: Math.max(0, csvLines.length - 1),
    csvContract,
  },
  markets: {
    apiCount: markets.length,
    listRefreshCount: refreshed.markets.length,
    listRefreshRevision: refreshed.revision,
    refreshParityMismatches,
    apyRows: apyRows.length,
    invalidBeforeRace,
    invalidAfterRace,
    dbInvalidBeforeRace,
    dbInvalidAfterRace,
    apySortMonotonic,
  },
  integrity: { sqlite: integrity, foreignKeyViolations, triggers },
};
const failures = [];
if (first.logs.length !== 500 || second.logs.length !== 500 || overlap !== 0) failures.push('Logs cursor pagination');
if (!summaryReconciles || !directRowsValid || !csvContract || csvLines.length !== direct.logs.length + 1) failures.push('Logs classification/summary/filter/CSV');
if (markets.length !== 476 || refreshed.markets.length !== 476 || refreshParityMismatches.length) failures.push('Markets/list-refresh parity');
if (invalidBeforeRace || invalidAfterRace || dbInvalidBeforeRace || dbInvalidAfterRace || !apySortMonotonic) failures.push('Markets current metric invariant/race');
if (integrity !== 'ok' || foreignKeyViolations !== 0 || triggers.length !== 2) failures.push('SQLite integrity/guards');
report.failures = failures;
await writeFile('artifacts/ops859-live-verification.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (failures.length) process.exitCode = 1;
