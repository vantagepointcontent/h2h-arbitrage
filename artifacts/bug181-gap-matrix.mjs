import { createClient } from '@libsql/client';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const db = createClient({ url: `file:${path.join(root, 'data', 'edgefinder.db')}` });
const saved = JSON.parse(await readFile(path.join(root, 'data', 'saved-markets.json'), 'utf8'));
const scheduler = JSON.parse(await readFile(path.join(root, 'data', 'saved-market-scheduler.json'), 'utf8'));
const poller = JSON.parse(await readFile(path.join(root, 'data', 'poller-health.json'), 'utf8'));
const ragnar = JSON.parse(await readFile(path.join(root, 'data', 'ragnar-consumer-health.json'), 'utf8'));
const telemetry = JSON.parse(await readFile(path.join(root, 'data', 'scan-worker-telemetry-health.json'), 'utf8'));

async function one(sql, args = []) {
  return (await db.execute({ sql, args })).rows[0] ?? {};
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

const [health, botStatus, marketsApi] = await Promise.all([
  json('http://127.0.0.1:3000/api/health'),
  json('http://127.0.0.1:3000/api/bot-trader/status'),
  json('http://127.0.0.1:3000/api/saved-markets?fields=basic'),
]);

const now = Date.now();
const since = new Date(now - 60 * 60_000).toISOString();
const scanWindow = await one(`SELECT COUNT(*) AS completions, COUNT(DISTINCT market_id) AS markets,
  MIN(id) AS first_id, MAX(id) AS last_id, MIN(scanned_at) AS first_at, MAX(scanned_at) AS last_at,
  SUM(CASE WHEN positive_arb_count>0 THEN 1 ELSE 0 END) AS positive
  FROM scan_results WHERE scan_status='completed' AND scanned_at>=?`, [since]);
const consumerWindow = await one(`SELECT COUNT(*) AS decisions, MIN(scan_id) AS first_scan_id, MAX(scan_id) AS last_scan_id,
  MIN(updated_at) AS first_at, MAX(updated_at) AS last_at
  FROM bot_scan_decisions WHERE updated_at>=?`, [since]);
const cursor = await one(`SELECT last_scan_id,updated_at FROM bot_scan_cursor WHERE consumer='bot_trader'`);
const gaps = await one(`SELECT
  SUM(CASE WHEN s.positive_arb_count>0 AND d.scan_id IS NULL THEN 1 ELSE 0 END) AS positive_without_scan_decision,
  SUM(CASE WHEN s.positive_arb_count>0 AND (e.scan_id IS NULL
    OR e.evaluated_count<>e.candidate_count
    OR json_array_length(e.missing_candidate_indexes)>0
    OR e.skipped_count+e.placed_count+e.failure_count<>e.candidate_count)
    THEN 1 ELSE 0 END) AS positive_without_terminal_evaluation,
  SUM(CASE WHEN s.positive_arb_count<=0 AND e.status='not_applicable_no_positive_arb' THEN 1 ELSE 0 END) AS zero_arb_na
  FROM scan_results s
  LEFT JOIN bot_scan_decisions d ON d.scan_id=s.id
  LEFT JOIN bot_scan_evaluations e ON e.scan_id=s.id
  WHERE s.scan_status='completed'`);
const positiveEvaluationStatuses = (await db.execute(`SELECT COALESCE(e.status,'missing') AS status,
  COALESCE(d.state,'missing') AS decision_state, COALESCE(d.reason_code,'missing') AS reason_code, COUNT(*) AS count
  FROM scan_results s
  LEFT JOIN bot_scan_decisions d ON d.scan_id=s.id
  LEFT JOIN bot_scan_evaluations e ON e.scan_id=s.id
  WHERE s.scan_status='completed' AND s.positive_arb_count>0
  GROUP BY COALESCE(e.status,'missing'),COALESCE(d.state,'missing'),COALESCE(d.reason_code,'missing')
  ORDER BY count DESC`)).rows;
const positiveCandidateAudit = await one(`SELECT
  COUNT(*) AS candidate_decisions,
  SUM(CASE WHEN o.final_result IS NOT NULL THEN 1 ELSE 0 END) AS terminal_candidate_decisions,
  SUM(CASE WHEN o.final_result='legacy_incomplete' THEN 1 ELSE 0 END) AS legacy_incomplete
  FROM bot_opportunity_decisions o JOIN scan_results s ON s.id=o.scan_id
  WHERE s.scan_status='completed' AND s.positive_arb_count>0`);
const projectionDb = await one(`SELECT COUNT(*) AS total,
  SUM(CASE WHEN last_scan_result IS NOT NULL THEN 1 ELSE 0 END) AS scanned,
  SUM(CASE WHEN canonical_apy_pct IS NOT NULL THEN 1 ELSE 0 END) AS apy_available,
  SUM(CASE WHEN canonical_apy_pct IS NULL AND canonical_apy_unavailable_reason IS NOT NULL THEN 1 ELSE 0 END) AS unavailable_with_reason,
  SUM(CASE WHEN canonical_apy_pct IS NULL AND canonical_apy_unavailable_reason IS NULL THEN 1 ELSE 0 END) AS unavailable_without_reason,
  SUM(CASE WHEN canonical_current_roi_pct=0 THEN 1 ELSE 0 END) AS zero_current_roi
  FROM saved_markets`);
const integrity = await one('PRAGMA integrity_check');
const foreignKeys = (await db.execute('PRAGMA foreign_key_check')).rows.length;

const indexes = [...new Set([0, Math.floor(saved.length / 2), Math.max(0, saved.length - 1)])];
const queueSamples = indexes.map((index) => {
  const market = saved[index];
  const entry = scheduler[market.id] ?? null;
  return {
    position: index === 0 ? 'early' : index === saved.length - 1 ? 'late' : 'middle',
    index,
    marketId: market.id,
    title: market.eventTitle,
    linkedUrlsPresent: Boolean(market.kalshiUrl && market.polymarketUrl),
    persistedScanAt: market.lastScanResult?.scannedAt ?? null,
    schedulerLastAttemptAt: entry?.lastAttemptAt ?? null,
    schedulerLastSuccessAt: entry?.lastSuccessAt ?? null,
    nextDueAt: entry?.nextDueAt ?? null,
    inProgress: entry?.inProgress === true,
    failureReason: entry?.failureReason ?? null,
  };
});

const apiProjection = marketsApi.markets.reduce((summary, market) => {
  summary.total += 1;
  if (market.lastScanResult?.scannedAt) summary.scanned += 1;
  if (market.canonicalApyPct != null) summary.apyAvailable += 1;
  else if (market.canonicalApyUnavailableReason) summary.unavailableWithReason += 1;
  else summary.unavailableWithoutReason += 1;
  if (market.canonicalCurrentRoiPct === 0) summary.zeroCurrentRoi += 1;
  return summary;
}, { total: 0, scanned: 0, apyAvailable: 0, unavailableWithReason: 0, unavailableWithoutReason: 0, zeroCurrentRoi: 0 });

const report = {
  schemaVersion: 1,
  capturedAt: new Date(now).toISOString(),
  window: { since, ...scanWindow },
  gapMatrix: {
    scheduler: {
      heartbeatAt: poller.heartbeatAt ?? null,
      status: poller.status ?? null,
      queue: poller.queue ?? null,
      progress: poller.progress ?? null,
      samples: queueSamples,
    },
    persistedScans: scanWindow,
    marketsProjection: { database: projectionDb, api: apiProjection },
    botTrader: {
      consumerWindow,
      cursor,
      workflow: botStatus.workflow ?? null,
      heartbeat: ragnar,
      gaps,
      positiveEvaluationStatuses,
      positiveCandidateAudit,
    },
    workerTelemetry: telemetry,
    uiApiHealth: health.components ?? null,
  },
  integrity: {
    sqlite: integrity.integrity_check ?? null,
    foreignKeyViolations: foreignKeys,
    savedJsonCount: saved.length,
    apiSavedMarketCount: marketsApi.markets.length,
  },
};

const output = path.join(root, 'artifacts', 'bug181-gap-matrix.json');
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
db.close();
console.log(output);
