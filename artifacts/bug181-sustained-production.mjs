import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const expectedCommit = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? '')) throw new Error('Expected deployed commit argument');
const sampleCount = Math.max(2, Number(process.env.BUG181_SAMPLE_COUNT) || 6);
const intervalMs = Math.max(1_000, Number(process.env.BUG181_SAMPLE_INTERVAL_MS) || 30_000);

async function json(route) {
  const response = await fetch(`http://127.0.0.1:3000${route}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response.json();
}

async function pm2Snapshot() {
  const { stdout } = await execFileAsync('pm2', ['jlist'], { maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout).filter((process) => process.name.startsWith('h2h-')).map((process) => ({
    name: process.name,
    status: process.pm2_env.status,
    pid: process.pid,
    restarts: process.pm2_env.restart_time,
    uptimeAt: new Date(process.pm2_env.pm_uptime).toISOString(),
  }));
}

const samples = [];
for (let index = 0; index < sampleCount; index += 1) {
  const [health, bot, markets, positive, processes] = await Promise.all([
    json('/api/health'),
    json('/api/bot-trader/status'),
    json('/api/saved-markets?fields=basic'),
    json('/api/logs?limit=500&positiveArbOnly=true'),
    pm2Snapshot(),
  ]);
  const projection = markets.markets.reduce((summary, market) => {
    if (market.lastScanResult?.scannedAt) summary.scanned += 1;
    if (market.canonicalApyPct == null && !market.canonicalApyUnavailableReason) summary.unavailableWithoutReason += 1;
    if (market.canonicalCurrentRoiPct === 0) summary.zeroCurrentRoi += 1;
    return summary;
  }, { scanned: 0, unavailableWithoutReason: 0, zeroCurrentRoi: 0 });
  samples.push({
    at: new Date().toISOString(),
    deployment: health.deployment,
    components: health.components,
    scheduler: health.savedMarketScheduler,
    botWorkflow: bot.workflow,
    markets: { total: markets.markets.length, ...projection },
    positiveLogs: {
      total: positive.total,
      rows: positive.logs.length,
      completed: positive.logs.filter((row) => row.botTraderEvaluationCompleted === true).length,
      failed: positive.logs.filter((row) => row.botTraderEvaluationStatus === 'failed').length,
      missingCandidateGaps: positive.logs.filter((row) => (row.botTraderEvaluation?.missingCandidateIndexes?.length ?? 0) > 0).length,
      terminallyReconciled: positive.logs.filter((row) => {
        const evaluation = row.botTraderEvaluation;
        return evaluation != null
          && evaluation.evaluatedCount === evaluation.candidateCount
          && (evaluation.missingCandidateIndexes?.length ?? 0) === 0
          && evaluation.skippedCount + evaluation.placedCount + evaluation.failureCount === evaluation.candidateCount;
      }).length,
    },
    processes,
  });
  if (index + 1 < sampleCount) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

const first = samples[0];
const last = samples.at(-1);
const processBaseline = new Map(first.processes.map((process) => [process.name, process.restarts]));
const checks = {
  identityStable: samples.every((sample) => sample.deployment?.commit === expectedCommit),
  scannerHealthy: samples.every((sample) => sample.components?.scanner?.state === 'healthy'),
  persistenceHealthy: samples.every((sample) => sample.components?.persistence?.state === 'healthy'),
  marketsHealthy: samples.every((sample) => sample.components?.markets?.state === 'healthy'),
  botTraderHealthy: samples.every((sample) => sample.components?.botTrader?.state === 'healthy'),
  noOverdueMarkets: samples.every((sample) => Number(sample.scheduler?.queue?.overdueCount ?? 0) === 0),
  cursorAlwaysCaughtUp: samples.every((sample) => sample.components?.botTrader?.cursorLag === 0
    && sample.components?.botTrader?.pendingScans === 0)
    && last.botWorkflow?.cursorLag === 0 && last.botWorkflow?.pendingScans === 0
    && last.botWorkflow?.cursorScanId === last.botWorkflow?.latestCompletedScanId,
  canonicalPopulationComplete: samples.every((sample) => sample.markets.total === 476 && sample.markets.scanned === 476
    && sample.markets.unavailableWithoutReason === 0 && sample.markets.zeroCurrentRoi === 0),
  positiveHistoryTerminal: samples.every((sample) => sample.positiveLogs.rows === 500
    && sample.positiveLogs.terminallyReconciled === 500
    && sample.positiveLogs.missingCandidateGaps === 0),
  noProcessRestartDuringWindow: samples.every((sample) => sample.processes.every((process) =>
    process.status === 'online' && process.restarts === processBaseline.get(process.name))),
  scanIdsAdvanced: Number(last.botWorkflow?.latestCompletedScanId ?? 0) > Number(first.botWorkflow?.latestCompletedScanId ?? 0),
};
const report = {
  schemaVersion: 1,
  startedAt: first.at,
  completedAt: last.at,
  intervalMs,
  sampleCount,
  checks,
  passed: Object.values(checks).every(Boolean),
  samples,
};
const output = path.join(process.cwd(), 'artifacts', 'bug181-sustained-production.json');
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, passed: report.passed, checks }, null, 2));
if (!report.passed) process.exitCode = 1;
