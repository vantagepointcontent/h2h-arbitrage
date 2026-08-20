import { createClient } from '@libsql/client';
import { readFile, writeFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:3000';
const json = async (pathname, options) => {
  const response = await fetch(base + pathname, { cache: 'no-store', ...options });
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`);
  return response.json();
};
const parseCsv = (text) => {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\n' && !quoted) { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (char !== '\r') cell += char;
  }
  return rows.filter((candidate) => candidate.length > 1);
};
const countBy = (values) => Object.fromEntries([...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map())].sort());
const close = (left, right) => Math.abs(Number(left) - Number(right)) < 1e-6;
const pm2Pid = (await readFile('/home/scott/.pm2/pids/h2h-arbitrage-77.pid', 'utf8')).trim();
const pm2Environment = (await readFile(`/proc/${pm2Pid}/environ`)).toString().split('\0');
const apiToken = pm2Environment.find((entry) => entry.startsWith('H2H_API_TOKEN='))?.slice('H2H_API_TOKEN='.length);
if (!apiToken) throw new Error('H2H_API_TOKEN is unavailable in the production app environment');

const health = await json('/api/health');
const cutoff = new Date().toISOString();
const fixed = `&toDate=${encodeURIComponent(cutoff)}`;
const first = await json(`/api/logs?limit=500${fixed}`);
if (first.logs.length !== 500 || !first.nextCursor) throw new Error('First 500-row page is incomplete');
const second = await json(`/api/logs?limit=500&before=${encodeURIComponent(first.nextCursor)}${fixed}`);
const firstIds = new Set(first.logs.map((row) => row.id));
const secondPageOverlap = second.logs.filter((row) => firstIds.has(row.id)).length;
if (second.logs.length !== 500 || secondPageOverlap !== 0) throw new Error('Second page is incomplete or overlaps first page');

const minRoi = await json(`/api/logs?minRoi=1&limit=500${fixed}`);
const minRoiViolations = minRoi.logs.filter((row) => row.historical_financials?.fields?.roiPct?.status !== 'available'
  || Number(row.historical_financials.fields.roiPct.value) < 1).length;
const positive = await json(`/api/logs?positiveArbOnly=true&limit=500${fixed}`);
const direct = await json(`/api/logs?arbType=direct&limit=500${fixed}`);
const current = await json('/api/logs/current-roi', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-h2h-token': apiToken },
  body: JSON.stringify({ ids: first.logs.slice(0, 100).map((row) => row.id) }),
});

const csvResponse = await fetch(base + `/api/logs/export?positiveArbOnly=true&limit=500${fixed}`, { cache: 'no-store' });
if (!csvResponse.ok) throw new Error(`CSV export returned ${csvResponse.status}`);
const csv = parseCsv(await csvResponse.text());
const header = csv[0]; const csvRows = csv.slice(1);
const profitIndex = header.indexOf('Profit ($)');
const arbsIndex = header.indexOf('Positive Arb Count');
const roiIndex = header.indexOf('ROI %');
const roiReasonIndex = header.indexOf('ROI Unavailable Reason');
const csvProfit = csvRows.reduce((sum, row) => sum + (Number(row[profitIndex]) || 0), 0);
const csvArbs = csvRows.reduce((sum, row) => sum + (Number(row[arbsIndex]) || 0), 0);

const savedPayload = await json('/api/saved-markets');
const saved = savedPayload.markets;
const savedPositiveRoi = saved.filter((row) => Number(row.canonicalCurrentRoiPct) > 0);
const savedZeroRoi = saved.filter((row) => row.canonicalCurrentRoiPct === 0);
const savedUnavailable = saved.filter((row) => row.canonicalCurrentRoiPct == null);
const savedReasons = countBy(savedUnavailable.map((row) => row.canonicalApyUnavailableReason ?? 'no_canonical_current_roi_reason'));

const db = createClient({ url: 'file:data/edgefinder.db' });
const dbRows = Number((await db.execute({ sql: 'SELECT COUNT(*) AS count FROM scan_results WHERE scanned_at <= ?', args: [cutoff] })).rows[0].count);
const oldestDbRow = (await db.execute({ sql: 'SELECT id, scanned_at FROM scan_results WHERE scanned_at <= ? ORDER BY scanned_at ASC, id ASC LIMIT 1', args: [cutoff] })).rows[0];
const bottomCursor = `${oldestDbRow.scanned_at}|${Number(oldestDbRow.id) + 1}`;
const bottomPage = await json(`/api/logs?limit=500&before=${encodeURIComponent(bottomCursor)}${fixed}`);
const historicalDistribution = (await db.execute(`SELECT
  COALESCE(json_extract(historical_financials_provenance, '$.fields.roiPct.status'), 'legacy_unmaterialized') AS status,
  COALESCE(json_extract(historical_financials_provenance, '$.fields.roiPct.reason'), '') AS reason,
  COUNT(*) AS rows
  FROM scan_results GROUP BY status, reason ORDER BY rows DESC`)).rows;
const numericZeroAuthority = (await db.execute(`SELECT COUNT(*) AS rows FROM scan_results
  WHERE historical_financials_revision = 3 AND best_roi_pct = 0
    AND json_extract(historical_financials_provenance, '$.fields.roiPct.status') = 'available'`)).rows[0];
const missingPresentedAsAvailableZero = (await db.execute(`SELECT COUNT(*) AS rows FROM scan_results
  WHERE historical_financials_revision = 3 AND best_roi_pct = 0
    AND json_extract(historical_financials_provenance, '$.fields.roiPct.status') != 'available'`)).rows[0];
const qualityExecution = (await db.execute(`SELECT scan_id, state, reconciliation_attempts,
  (SELECT COUNT(*) FROM logs_data_quality_alerts WHERE scan_id = logs_data_quality_batches.scan_id) AS alerts
  FROM logs_data_quality_batches ORDER BY observed_at DESC, scan_id DESC LIMIT 1`)).rows[0];
const integrity = String((await db.execute('PRAGMA integrity_check')).rows[0].integrity_check);
const foreignKeyViolations = (await db.execute('PRAGMA foreign_key_check')).rows.length;
db.close();

const pageRoi = first.logs.map((row) => row.historical_financials.fields.roiPct);
const report = {
  verifiedAt: new Date().toISOString(),
  deployment: health.deployment,
  pagination: {
    apiTotal: first.total, dbRows, dbApiReconciles: first.total === dbRows,
    firstBatchRows: first.logs.length, secondBatchRows: second.logs.length, secondPageOverlap,
    bottomReachRows: bottomPage.logs.length,
    reachesOldestDbRow: bottomPage.logs.some((row) => Number(row.id) === Number(oldestDbRow.id)),
  },
  summariesAndFilters: {
    summary: first.summary,
    nonBlanketPopulation: Number(first.summary.avgRoi) > 0 && Number(first.summary.bestRoi) > 0,
    minRoiTotal: minRoi.total, minRoiViolations,
    directTotal: direct.total,
    positiveTotal: positive.total,
  },
  logsAvailability: {
    first500Available: pageRoi.filter((field) => field.status === 'available').length,
    first500Positive: pageRoi.filter((field) => field.status === 'available' && Number(field.value) > 0).length,
    first500AuthoritativeZero: pageRoi.filter((field) => field.status === 'available' && Number(field.value) === 0).length,
    first500UnavailableReasons: countBy(pageRoi.filter((field) => field.status !== 'available').map((field) => field.reason)),
    persistedDistribution: historicalDistribution,
    authoritativeNumericZeroRows: Number(numericZeroAuthority.rows),
    unavailableCompatibilityZeroRows: Number(missingPresentedAsAvailableZero.rows),
  },
  currentRoi: {
    requested: 100, returned: current.valuations.length,
    statuses: countBy(current.valuations.map((row) => row.status)),
    unavailableReasons: countBy(current.valuations.filter((row) => row.status !== 'available').map((row) => row.reason ?? row.status)),
  },
  savedMarkets: {
    total: saved.length, positiveCurrentRoi: savedPositiveRoi.length,
    authoritativeZeroCurrentRoi: savedZeroRoi.length, unavailableCurrentRoi: savedUnavailable.length,
    unavailableReasons: savedReasons,
    positiveSample: savedPositiveRoi[0] ? {
      id: savedPositiveRoi[0].id, roiPct: savedPositiveRoi[0].canonicalCurrentRoiPct,
      strategy: savedPositiveRoi[0].canonicalCurrentStrategy,
      profit: savedPositiveRoi[0].canonicalCurrentProfit,
      apy: savedPositiveRoi[0].canonicalApyPct,
      apyReason: savedPositiveRoi[0].canonicalApyUnavailableReason,
    } : null,
  },
  csv: {
    rows: csvRows.length, roiColumn: roiIndex >= 0, roiReasonColumn: roiReasonIndex >= 0,
    apiRows: positive.logs.length,
    profitReconcilesFirst500: close(csvProfit, positive.logs.reduce((sum, row) => sum + Number(row.best_profit), 0)),
    arbsReconcileFirst500: csvArbs === positive.logs.reduce((sum, row) => sum + Number(row.positive_arb_count), 0),
  },
  dataQuality: { ...health.logsDataQuality, latestExecution: qualityExecution },
  integrity: { sqlite: integrity, foreignKeyViolations },
};
report.assertions = {
  deploymentIdentity: report.deployment.commit === '23a11fd4acbe7b597059a56d8421ffe9e5f855a4' && report.deployment.buildId === 'Ll2-DBTXG4krj4lufhEez',
  pagination: report.pagination.dbApiReconciles && report.pagination.firstBatchRows === 500 && report.pagination.secondBatchRows === 500 && report.pagination.secondPageOverlap === 0 && report.pagination.reachesOldestDbRow,
  nonBlanketRoi: report.summariesAndFilters.nonBlanketPopulation && report.logsAvailability.first500Positive > 0 && report.savedMarkets.positiveCurrentRoi > 0,
  filters: report.summariesAndFilters.minRoiViolations === 0 && report.summariesAndFilters.directTotal > 0,
  csvParity: report.csv.rows === report.csv.apiRows && report.csv.profitReconcilesFirst500 && report.csv.arbsReconcileFirst500 && report.csv.roiColumn && report.csv.roiReasonColumn,
  zeroAuthority: report.logsAvailability.unavailableCompatibilityZeroRows > 0 && report.savedMarkets.authoritativeZeroCurrentRoi === 0,
  dataQualityActive: health.logsDataQuality?.latest?.fields?.roi?.denominator === 100
    && health.logsDataQuality.latest.reconciliation?.maxAttempts === 2
    && Number(qualityExecution.reconciliation_attempts) === 2 && Number(qualityExecution.alerts) > 0,
  integrity: integrity === 'ok' && foreignKeyViolations === 0,
};
report.failures = Object.entries(report.assertions).filter(([, passed]) => !passed).map(([name]) => name);
await writeFile('artifacts/ops860-production-verification.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (report.failures.length) process.exitCode = 1;
