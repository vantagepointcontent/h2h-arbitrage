import { createClient } from '@libsql/client';
import { writeFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:3000';
const cutoff = new Date().toISOString();

async function getJson(path) {
  const response = await fetch(`${base}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function classify(items) {
  const total = items.length;
  const states = reasonDistribution(items, (item) => item.state);
  const available = states.available ?? 0;
  const notApplicable = states.not_applicable ?? 0;
  const unavailable = states.unavailable ?? 0;
  const applicable = available + unavailable;
  const unavailableReasons = reasonDistribution(
    items.filter((item) => item.state === 'unavailable'),
    (item) => item.reason,
  );
  const notApplicableReasons = reasonDistribution(
    items.filter((item) => item.state === 'not_applicable'),
    (item) => item.reason,
  );
  return {
    total,
    available,
    notApplicable,
    unavailable,
    otherLegitimateStates: total - available - notApplicable - unavailable,
    applicable,
    availabilityPct: applicable === 0 ? null : Number(((available / applicable) * 100).toFixed(3)),
    unavailablePct: applicable === 0 ? null : Number(((unavailable / applicable) * 100).toFixed(3)),
    states,
    unavailableReasons,
    notApplicableReasons,
  };
}

function fieldCensus(rows, field, { statusField, reasonField, noArbReasonField } = {}) {
  return classify(rows.map((row) => {
    const value = row[field];
    if (value !== null && value !== undefined && value !== '') return { state: 'available', reason: null };
    if (statusField && row[statusField] === 'not_applicable') return { state: 'not_applicable', reason: 'confirmed_no_arbitrage' };
    if (statusField && row[statusField] === 'unavailable') return { state: 'unavailable', reason: row[reasonField] };
    if (noArbReasonField && row[noArbReasonField] === 'no_canonical_arbitrage') {
      return { state: 'not_applicable', reason: 'confirmed_no_arbitrage' };
    }
    return { state: 'unavailable', reason: reasonField ? row[reasonField] : 'field_projection_missing' };
  }));
}

function historicalFieldCensus(rows, field) {
  return classify(rows.map((row) => {
    const item = row.historical_financials?.fields?.[field] ?? null;
    if (item?.status === 'available') return { state: 'available', reason: null };
    if (item?.reasonCode === 'confirmed_no_arbitrage') return { state: 'not_applicable', reason: item.reasonCode };
    if (item?.reasonCode === 'not_scanned') return { state: 'not_scanned', reason: item.reasonCode };
    if (item?.reasonCode === 'loading' || item?.reasonCode === 'refreshing') return { state: 'loading', reason: item.reasonCode };
    if (item?.reasonCode === 'stale_last_known') return { state: 'stale', reason: item.reasonCode };
    return { state: 'unavailable', reason: item?.reasonCode ?? item?.reason ?? 'historical_field_projection_missing' };
  }));
}

function reasonDistribution(rows, selector) {
  const result = {};
  for (const row of rows) {
    const key = selector(row) ?? 'missing_reason';
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

const health = await getJson('/api/health');
const savedFull = await getJson('/api/saved-markets');
const savedBasic = await getJson('/api/saved-markets?fields=basic');

const logPages = [];
let before;
for (let page = 0; page < 3; page += 1) {
  const params = new URLSearchParams({ limit: '500', toDate: cutoff });
  if (before) params.set('before', before);
  const payload = await getJson(`/api/logs?${params}`);
  logPages.push(payload);
  before = payload.nextCursor;
  if (!before) break;
}
const logs = logPages.flatMap((page) => page.logs);

const exportResponse = await fetch(`${base}/api/logs/export?limit=1500&toDate=${encodeURIComponent(cutoff)}`, { cache: 'no-store' });
if (!exportResponse.ok) throw new Error(`/api/logs/export returned ${exportResponse.status}`);
const exportText = await exportResponse.text();
const exportLines = exportText.trimEnd().split('\n');
const exportHeader = exportLines[0] ?? '';
const exportUnavailableCells = (exportText.match(/Unavailable/g) ?? []).length;

const [botStatus, botPositions, botAnalytics] = await Promise.all([
  getJson('/api/bot-trader/status'),
  getJson('/api/bot-trader/positions?limit=500'),
  getJson('/api/bot-trader/analytics'),
]);

const markets = savedBasic.markets;
const positiveMarkets = markets.filter((market) => Number(market.canonicalCurrentRoiPct) > 0);
const fullArbs = savedFull.markets.flatMap((market) => (market.lastScanResult?.allArbs ?? []).map((arb) => ({ ...arb, marketId: market.id })));
const positiveArbs = fullArbs.filter((arb) => Number(arb.roiPct) > 0 && arb.strategy !== 'No arb' && !String(arb.strategy).startsWith('Unavailable'));

const db = createClient({ url: 'file:data/edgefinder.db' });
const tableRows = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
const tables = tableRows.rows.map((row) => String(row.name));
const dbSummary = (await db.execute({
  sql: `SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN scan_status = 'completed' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN positive_arb_count > 0 AND arb_valid = 1 THEN 1 ELSE 0 END) AS positive,
    SUM(CASE WHEN best_roi_pct IS NOT NULL THEN 1 ELSE 0 END) AS roi_present,
    SUM(CASE WHEN best_profit IS NOT NULL THEN 1 ELSE 0 END) AS profit_present,
    SUM(CASE WHEN apy_pct IS NOT NULL THEN 1 ELSE 0 END) AS apy_present,
    SUM(CASE WHEN total_stake IS NOT NULL THEN 1 ELSE 0 END) AS stake_present,
    SUM(CASE WHEN expiry_at IS NOT NULL THEN 1 ELSE 0 END) AS expiry_present,
    SUM(CASE WHEN historical_financials_revision IS NOT NULL THEN 1 ELSE 0 END) AS historical_revision_present,
    SUM(CASE WHEN historical_financials_provenance IS NOT NULL THEN 1 ELSE 0 END) AS historical_provenance_present
  FROM scan_results WHERE scanned_at <= ?`,
  args: [cutoff],
})).rows[0];

const integrity = String((await db.execute('PRAGMA integrity_check')).rows[0].integrity_check);
const foreignKeyViolations = (await db.execute('PRAGMA foreign_key_check')).rows.length;
db.close();

const report = {
  censusAt: cutoff,
  deployment: health.deployment,
  scope: {
    canonicalDbRows: Number(dbSummary.total),
    apiRowsSampled: logs.length,
    apiPagesSampled: logPages.length,
    apiPageSizes: logPages.map((page) => page.logs.length),
    apiPageOverlap: logs.length - new Set(logs.map((row) => row.id)).size,
    savedMarkets: markets.length,
    persistedArbs: fullArbs.length,
    positivePersistedArbs: positiveArbs.length,
    exportRowsSampled: Math.max(0, exportLines.length - 1),
  },
  canonicalPersistence: {
    scanResults: Object.fromEntries(Object.entries(dbSummary).map(([key, value]) => [key, Number(value)])),

    tables,
    integrity,
    foreignKeyViolations,
  },
  logsApi: {
    rowFields: {
      scanTimeRoi: historicalFieldCensus(logs, 'roiPct'),
      scanTimeProfit: historicalFieldCensus(logs, 'profitUsd'),
      scanTimeApy: historicalFieldCensus(logs, 'apyPct'),
      scanTimeStake: historicalFieldCensus(logs, 'stakeUsd'),
      expiryAt: historicalFieldCensus(logs, 'expiryAt'),
      marketName: fieldCensus(logs, 'market_name'),
      strategy: fieldCensus(logs, 'strategy'),
      calculationEnvelope: fieldCensus(logs, 'calculation_envelope'),
    },
    scanStatuses: reasonDistribution(logs, (row) => row.scan_status),
    botTraderStatuses: reasonDistribution(logs, (row) => row.botTraderEvaluationStatus),
    summary: logPages[0]?.summary,
    dataQuality: logPages[0]?.dataQuality,
    total: logPages[0]?.total,
  },
  savedMarketsApi: {
    allRows: {
      expiryDate: fieldCensus(markets, 'expiryDate', { reasonField: 'expirySource' }),
      canonicalCurrentRoiPct: fieldCensus(markets, 'canonicalCurrentRoiPct', {
        statusField: 'canonicalCurrentRoiStatus', reasonField: 'canonicalCurrentRoiUnavailableReason',
        noArbReasonField: 'canonicalApyUnavailableReason',
      }),
      canonicalCurrentProfit: fieldCensus(markets, 'canonicalCurrentProfit', {
        statusField: 'canonicalCurrentProfitStatus', reasonField: 'canonicalCurrentProfitUnavailableReason',
        noArbReasonField: 'canonicalApyUnavailableReason',
      }),
      canonicalApyPct: fieldCensus(markets, 'canonicalApyPct', {
        reasonField: 'canonicalApyUnavailableReason', noArbReasonField: 'canonicalApyUnavailableReason',
      }),
      canonicalCurrentRevision: fieldCensus(markets, 'canonicalCurrentRevision'),
    },
    positiveRoiRows: {
      count: positiveMarkets.length,
      expiryDate: fieldCensus(positiveMarkets, 'expiryDate', { reasonField: 'expirySource' }),
      canonicalCurrentRoiPct: fieldCensus(positiveMarkets, 'canonicalCurrentRoiPct'),
      canonicalCurrentProfit: fieldCensus(positiveMarkets, 'canonicalCurrentProfit', {
        statusField: 'canonicalCurrentProfitStatus', reasonField: 'canonicalCurrentProfitUnavailableReason',
      }),
      canonicalApyPct: fieldCensus(positiveMarkets, 'canonicalApyPct', { reasonField: 'canonicalApyUnavailableReason' }),
      canonicalCurrentRevision: fieldCensus(positiveMarkets, 'canonicalCurrentRevision'),
    },
    scanStatuses: reasonDistribution(markets, (market) => market.lastScanResult?.matchStatus ?? 'not_scanned'),
    explicitApyReasons: reasonDistribution(markets.filter((market) => market.canonicalApyPct == null), (market) => market.canonicalApyUnavailableReason),
    fullVsBasicCountMatches: savedFull.markets.length === savedBasic.markets.length,
    persistedArbFields: {
      roiPct: fieldCensus(positiveArbs, 'roiPct'),
      expectedProfit: fieldCensus(positiveArbs, 'expectedProfit'),
      apyPct: fieldCensus(positiveArbs, 'apyPct', { reasonField: 'apyUnavailableReason' }),
      daysToExpiry: fieldCensus(positiveArbs, 'daysToExpiry', { reasonField: 'apyUnavailableReason' }),
      expiryAt: fieldCensus(positiveArbs, 'expiryAt', { reasonField: 'apyUnavailableReason' }),
      totalStake: fieldCensus(positiveArbs, 'totalStake'),
      calculationEnvelope: fieldCensus(positiveArbs, 'calculationEnvelope'),
    },
  },
  logsExport: {
    headerColumns: exportHeader.split(',').length,
    sampledRows: Math.max(0, exportLines.length - 1),
    literalUnavailableCells: exportUnavailableCells,
    hasRequiredReasonColumns: [
      'ROI Unavailable Reason', 'Current ROI Unavailable Reason', 'APY Unavailable Reason',
      'Profit Unavailable Reason', 'Stake Unavailable Reason', 'BotTrader Evaluation Reason',
    ].every((column) => exportHeader.includes(column)),
  },
  botTrader: {
    status: botStatus,
    positionsTopLevel: Object.keys(botPositions),
    positionCount: Array.isArray(botPositions.positions) ? botPositions.positions.length : null,
    analytics: botAnalytics,
    sampledLogEvaluationStatuses: reasonDistribution(logs, (row) => row.botTraderEvaluationStatus),
  },
};

function reconciles(field, expectedTotal) {
  return field.total === expectedTotal
    && field.total === field.available + field.notApplicable + field.unavailable + field.otherLegitimateStates
    && Object.values(field.states).reduce((sum, count) => sum + count, 0) === field.total
    && Object.values(field.unavailableReasons).reduce((sum, count) => sum + count, 0) === field.unavailable
    && Object.values(field.notApplicableReasons).reduce((sum, count) => sum + count, 0) === field.notApplicable;
}

const integrityChecks = {
  canonicalDbIntegrityOk: report.canonicalPersistence.integrity === 'ok'
    && report.canonicalPersistence.foreignKeyViolations === 0,
  logsPaginationReconciles: report.scope.apiRowsSampled === logs.length
    && report.scope.apiRowsSampled === report.scope.apiPageSizes.reduce((sum, size) => sum + size, 0)
    && report.scope.apiPageOverlap === 0,
  logsFieldsReconcile: Object.values(report.logsApi.rowFields).every((field) => reconciles(field, logs.length)),
  savedFieldsReconcile: Object.values(report.savedMarketsApi.allRows).every((field) => reconciles(field, markets.length)),
  positiveSavedFieldsReconcile: Object.entries(report.savedMarketsApi.positiveRoiRows)
    .filter(([key]) => key !== 'count')
    .every(([, field]) => reconciles(field, positiveMarkets.length)),
  exportRowsReconcile: report.logsExport.sampledRows === logs.length,
  exportReasonColumnsPresent: report.logsExport.hasRequiredReasonColumns,
  summaryReconcilesWithNoArbitrageSample: Object.values(report.logsApi.rowFields)
    .slice(0, 4)
    .every((field) => field.notApplicable === logs.length)
      ? report.logsApi.summary?.totalArbs === 0
        && report.logsApi.summary?.avgRoi == null
        && report.logsApi.summary?.bestRoi == null
        && report.logsApi.summary?.totalProfit == null
      : true,
};
report.integrity = {
  ...integrityChecks,
  allChecksPassed: Object.values(integrityChecks).every(Boolean),
};

await writeFile(process.env.BUG857_CENSUS_OUTPUT ?? 'artifacts/bug857-before-census.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
