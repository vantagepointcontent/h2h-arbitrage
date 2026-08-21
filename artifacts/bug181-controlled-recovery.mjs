import { createClient } from '@libsql/client';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const mode = process.argv[2];
const expectedCommit = process.argv[3];
const baselinePath = path.join(process.cwd(), 'artifacts', 'bug181-controlled-recovery-baseline.json');
const reportPath = path.join(process.cwd(), 'artifacts', 'bug181-controlled-recovery.json');
if (!['baseline', 'verify'].includes(mode)) throw new Error('Usage: node artifacts/bug181-controlled-recovery.mjs baseline|verify <expected-commit>');
if (mode === 'verify' && !/^[a-f0-9]{40}$/.test(expectedCommit ?? '')) throw new Error('verify requires the expected deployed commit');

async function json(route) {
  const response = await fetch(`http://127.0.0.1:3000${route}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response.json();
}

async function pm2Snapshot() {
  const { stdout } = await execFileAsync('pm2', ['jlist'], { maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout)
    .filter((item) => ['h2h-arbitrage', 'h2h-poller', 'h2h-ragnar', 'h2h-scan-supervisor'].includes(item.name))
    .map((item) => ({
      name: item.name,
      status: item.pm2_env.status,
      pid: item.pid,
      restarts: item.pm2_env.restart_time,
      uptimeAt: new Date(item.pm2_env.pm_uptime).toISOString(),
      script: item.pm2_env.pm_exec_path,
      cwd: item.pm2_env.pm_cwd,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function databaseSnapshot() {
  const db = createClient({ url: 'file:data/edgefinder.db' });
  try {
    const [integrity, foreignKeys, scans, cursor, evaluations, duplicateCandidates] = await Promise.all([
      db.execute('PRAGMA integrity_check'),
      db.execute('PRAGMA foreign_key_check'),
      db.execute(`SELECT COUNT(*) AS completed_count,MAX(id) AS max_scan_id,
        SUM(CASE WHEN positive_arb_count>0 THEN 1 ELSE 0 END) AS positive_count
        FROM scan_results WHERE scan_status='completed'`),
      db.execute(`SELECT consumer,last_scan_id,updated_at FROM bot_scan_cursor WHERE consumer='ragnar-v1'`),
      db.execute(`SELECT COUNT(*) AS positive_scans,
        SUM(CASE WHEN e.scan_id IS NULL THEN 1 ELSE 0 END) AS missing_evaluations,
        SUM(CASE WHEN e.scan_id IS NULL
          OR e.candidate_count<>(CASE WHEN json_valid(s.raw_result) AND json_type(s.raw_result,'$.allArbs')='array'
            THEN json_array_length(json_extract(s.raw_result,'$.allArbs')) ELSE s.positive_arb_count END)
          OR e.evaluated_count<>e.candidate_count
          OR json_array_length(e.missing_candidate_indexes)>0
          OR e.skipped_count+e.placed_count+e.failure_count<>e.candidate_count
          OR (SELECT COUNT(*) FROM bot_opportunity_decisions o WHERE o.scan_id=s.id AND o.final_result IS NOT NULL)<>e.candidate_count
          OR (SELECT COALESCE(MIN(o.candidate_index),0) FROM bot_opportunity_decisions o WHERE o.scan_id=s.id)<>0
          OR (SELECT COALESCE(MAX(o.candidate_index),-1) FROM bot_opportunity_decisions o WHERE o.scan_id=s.id)<>e.candidate_count-1
          OR e.failure_count<>(SELECT COUNT(*) FROM bot_opportunity_decisions o
            WHERE o.scan_id=s.id AND (o.state='failed' OR o.final_result='failed'))
          OR e.status<>CASE WHEN EXISTS (SELECT 1 FROM bot_opportunity_decisions o
            WHERE o.scan_id=s.id AND (o.state='failed' OR o.final_result='failed')) THEN 'failed' ELSE 'completed' END
          OR e.completed<>CASE WHEN EXISTS (SELECT 1 FROM bot_opportunity_decisions o
            WHERE o.scan_id=s.id AND (o.state='failed' OR o.final_result='failed')) THEN 0 ELSE 1 END
          OR e.skipped_count<>(SELECT COUNT(*) FROM bot_opportunity_decisions o
            WHERE o.scan_id=s.id AND o.final_result IS NOT NULL AND o.state<>'failed'
              AND o.final_result NOT IN ('failed','accepted'))
          OR e.placed_count<>(SELECT COUNT(*) FROM bot_opportunity_decisions o
            WHERE o.scan_id=s.id AND o.final_result='accepted')
          OR e.failing_candidate_indexes<>COALESCE((SELECT json_group_array(candidate_index) FROM
            (SELECT candidate_index FROM bot_opportunity_decisions o
              WHERE o.scan_id=s.id AND (o.state='failed' OR o.final_result='failed') ORDER BY candidate_index)), '[]')
          THEN 1 ELSE 0 END) AS unreconciled,
        COALESCE(SUM(e.failure_count),0) AS candidate_failures
        FROM scan_results s LEFT JOIN bot_scan_evaluations e ON e.scan_id=s.id
        WHERE s.scan_status='completed' AND s.positive_arb_count>0`),
      db.execute(`SELECT COUNT(*) AS duplicate_groups FROM (
        SELECT scan_id,candidate_index FROM bot_opportunity_decisions
        GROUP BY scan_id,candidate_index HAVING COUNT(*)>1)`),
    ]);
    return {
      integrity: integrity.rows[0]?.integrity_check ?? null,
      foreignKeyViolations: foreignKeys.rows.length,
      scans: scans.rows[0],
      cursor: cursor.rows[0] ?? null,
      evaluations: evaluations.rows[0],
      duplicateCandidateGroups: duplicateCandidates.rows[0]?.duplicate_groups ?? null,
    };
  } finally {
    db.close();
  }
}

async function snapshot(label) {
  const [health, bot, markets, positive, processes, database] = await Promise.all([
    json('/api/health'),
    json('/api/bot-trader/status'),
    json('/api/saved-markets?fields=basic'),
    json('/api/logs?limit=500&positiveArbOnly=true'),
    pm2Snapshot(),
    databaseSnapshot(),
  ]);
  const projections = markets.markets.reduce((summary, market) => {
    if (market.lastScanResult?.scannedAt) summary.scanned += 1;
    if (market.canonicalApyPct == null && !market.canonicalApyUnavailableReason) summary.unavailableWithoutReason += 1;
    if (market.canonicalCurrentRoiPct === 0) summary.falseZeroCurrentRoi += 1;
    return summary;
  }, { total: markets.markets.length, scanned: 0, unavailableWithoutReason: 0, falseZeroCurrentRoi: 0 });
  const positiveReconciliation = positive.logs.reduce((summary, row) => {
    const evaluation = row.botTraderEvaluation;
    const reconciled = evaluation != null
      && evaluation.evaluatedCount === evaluation.candidateCount
      && (evaluation.missingCandidateIndexes?.length ?? 0) === 0
      && evaluation.skippedCount + evaluation.placedCount + evaluation.failureCount === evaluation.candidateCount;
    if (reconciled) summary.reconciled += 1;
    else summary.unreconciled += 1;
    if ((evaluation?.failureCount ?? 0) > 0) summary.truthfulFailures += 1;
    return summary;
  }, { returned: positive.logs.length, total: positive.total, reconciled: 0, unreconciled: 0, truthfulFailures: 0 });
  return {
    label,
    at: new Date().toISOString(),
    deployment: health.deployment,
    components: health.components,
    scheduler: health.savedMarketScheduler,
    botWorkflow: bot.workflow,
    markets: projections,
    positiveLogs: positiveReconciliation,
    processes,
    database,
  };
}

function processByName(state, name) {
  const item = state.processes.find((process) => process.name === name);
  if (!item) throw new Error(`Missing PM2 process ${name}`);
  return item;
}

async function waitFor(label, predicate, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'condition not evaluated';
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
      lastError = 'condition returned false';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label} timed out: ${lastError}`);
}

function pipelineHealthy(state) {
  return state.components?.scanner?.state === 'healthy'
    && state.components?.persistence?.state === 'healthy'
    && state.components?.markets?.state === 'healthy'
    && state.components?.botTrader?.state === 'healthy'
    && Number(state.scheduler?.queue?.overdueCount ?? 0) === 0
    && Number(state.botWorkflow?.cursorLag ?? -1) === 0
    && Number(state.botWorkflow?.pendingScans ?? -1) === 0
    && state.markets.scanned === state.markets.total
    && state.markets.unavailableWithoutReason === 0
    && state.markets.falseZeroCurrentRoi === 0
    && state.positiveLogs.unreconciled === 0
    && state.database.integrity === 'ok'
    && state.database.foreignKeyViolations === 0
    && Number(state.database.duplicateCandidateGroups) === 0;
}

async function crashAndRecover(name, before) {
  const expectedScripts = {
    'h2h-poller': path.join(process.cwd(), 'scripts', 'poll.mjs'),
    'h2h-ragnar': path.join(process.cwd(), '.h2h-releases', 'active', '.next', 'ragnar-consumer.mjs'),
  };
  const expectedScript = expectedScripts[name];
  if (!expectedScript) throw new Error(`Refusing to signal non-whitelisted process ${name}`);
  const prior = processByName(before, name);
  const immediate = processByName({ processes: await pm2Snapshot() }, name);
  if (prior.status !== 'online' || immediate.status !== 'online'
    || !Number.isSafeInteger(immediate.pid) || immediate.pid <= 1
    || immediate.pid !== prior.pid || immediate.restarts !== prior.restarts
    || immediate.cwd !== process.cwd() || path.resolve(immediate.script) !== expectedScript) {
    throw new Error(`Refusing to signal ${name}: PM2 identity changed or does not match the controlled target`);
  }
  process.kill(immediate.pid, 'SIGKILL');
  await waitFor(`${name} PM2 restart`, async () => {
    const processes = await pm2Snapshot();
    const current = processes.find((process) => process.name === name);
    return current?.status === 'online' && current.pid !== prior.pid ? current : false;
  });
  const recovered = await waitFor(`${name} pipeline recovery`, async () => {
    const state = await snapshot(`after-${name}-crash`);
    return pipelineHealthy(state) ? state : false;
  });
  return { process: name, action: 'SIGKILL', before: prior, after: processByName(recovered, name), recovered };
}

if (mode === 'baseline') {
  const baseline = await snapshot('before-release-promotion');
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(JSON.stringify({ output: baselinePath, deployment: baseline.deployment, pipelineHealthy: pipelineHealthy(baseline) }, null, 2));
  if (!pipelineHealthy(baseline)) process.exitCode = 1;
} else {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const afterPromotion = await waitFor('release promotion health', async () => {
    const state = await snapshot('after-release-promotion');
    return state.deployment?.commit === expectedCommit && pipelineHealthy(state) ? state : false;
  });
  const pollerRecovery = await crashAndRecover('h2h-poller', afterPromotion);
  const scanAdvance = await waitFor('saved-market scan advancement after poller crash', async () => {
    const state = await snapshot('after-poller-natural-cycle');
    return pipelineHealthy(state)
      && Number(state.botWorkflow?.latestCompletedScanId ?? 0) > Number(pollerRecovery.recovered.botWorkflow?.latestCompletedScanId ?? 0)
      ? state : false;
  });
  const ragnarRecovery = await crashAndRecover('h2h-ragnar', scanAdvance);
  const beforeAppRestart = ragnarRecovery.recovered;
  const appBefore = processByName(beforeAppRestart, 'h2h-arbitrage');
  await execFileAsync('pm2', ['restart', 'h2h-arbitrage', '--update-env'], { cwd: process.cwd() });
  const afterAppRestart = await waitFor('application PM2 restart recovery', async () => {
    const state = await snapshot('after-app-pm2-restart');
    const app = processByName(state, 'h2h-arbitrage');
    return app.pid !== appBefore.pid
      && state.deployment?.commit === expectedCommit && pipelineHealthy(state) ? state : false;
  });
  const finalNaturalCycle = await waitFor('post-fault natural scan cycle', async () => {
    const state = await snapshot('post-fault-natural-cycle');
    return Number(state.botWorkflow?.latestCompletedScanId ?? 0) > Number(afterAppRestart.botWorkflow?.latestCompletedScanId ?? 0)
      && pipelineHealthy(state) ? state : false;
  });
  const checks = {
    baselineHealthy: pipelineHealthy(baseline),
    releasePromoted: baseline.deployment?.commit !== expectedCommit && afterPromotion.deployment?.commit === expectedCommit,
    releaseRestartedAllWorkers: ['h2h-arbitrage', 'h2h-poller', 'h2h-ragnar'].every((name) => {
      const before = processByName(baseline, name);
      const after = processByName(afterPromotion, name);
      return after.status === 'online' && after.pid !== before.pid;
    }),
    pollerCrashRecovered: pollerRecovery.after.pid !== pollerRecovery.before.pid,
    scansAdvancedAfterPollerCrash: Number(scanAdvance.botWorkflow?.latestCompletedScanId ?? 0)
      > Number(pollerRecovery.recovered.botWorkflow?.latestCompletedScanId ?? 0),
    ragnarCrashRecovered: ragnarRecovery.after.pid !== ragnarRecovery.before.pid,
    appRestartRecovered: processByName(afterAppRestart, 'h2h-arbitrage').pid !== appBefore.pid,
    finalPipelineHealthy: pipelineHealthy(finalNaturalCycle),
    noLostOrDuplicateCandidateAudits: Number(finalNaturalCycle.database.evaluations?.missing_evaluations ?? -1) === 0
      && Number(finalNaturalCycle.database.evaluations?.unreconciled ?? -1) === 0
      && Number(finalNaturalCycle.database.duplicateCandidateGroups) === 0,
    sqliteIntegrity: finalNaturalCycle.database.integrity === 'ok' && finalNaturalCycle.database.foreignKeyViolations === 0,
  };
  const report = {
    schemaVersion: 1,
    startedAt: baseline.at,
    completedAt: finalNaturalCycle.at,
    expectedCommit,
    checks,
    passed: Object.values(checks).every(Boolean),
    baseline,
    afterPromotion,
    recoveries: { poller: pollerRecovery, ragnar: ragnarRecovery, app: { before: appBefore, after: afterAppRestart } },
    scanAdvance,
    finalNaturalCycle,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: reportPath, passed: report.passed, checks }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
