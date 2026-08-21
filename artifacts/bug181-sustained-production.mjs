import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);
const expectedCommit = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? '')) throw new Error('Expected deployed commit argument');
const sampleCount = Math.max(2, Number(process.env.BUG181_SAMPLE_COUNT) || 6);
const intervalMs = Math.max(1_000, Number(process.env.BUG181_SAMPLE_INTERVAL_MS) || 30_000);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid == null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function terminateBrowser(browser) {
  if (browser.exitCode !== null || browser.signalCode !== null || browser.pid == null) return;
  browser.kill('SIGTERM');
  if (await waitForChildExit(browser, 5_000)) return;
  browser.kill('SIGKILL');
  if (!await waitForChildExit(browser, 5_000)) {
    throw new Error(`Chromium process ${browser.pid} did not exit after SIGKILL`);
  }
}

async function startMarketsUiProbe() {
  const port = Number(process.env.BUG181_CHROME_PORT) || 9231;
  const profile = await mkdtemp(path.join(tmpdir(), 'bug181-chromium-'));
  let browser;
  let socket;
  let tab;
  let cleanupPromise;
  let startupError = null;
  const endpoint = `http://127.0.0.1:${port}`;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      if (socket) {
        socket.terminate();
        socket = null;
      }
      if (tab?.id) {
        await fetch(`${endpoint}/json/close/${tab.id}`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
      }
      try {
        if (browser) await terminateBrowser(browser);
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    })();
    return cleanupPromise;
  };

  try {
    browser = spawn(process.env.BUG181_CHROMIUM || '/snap/bin/chromium', [
      '--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    browser.once('error', (error) => { startupError = error; });

    let version = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (browser.exitCode !== null || browser.signalCode !== null) {
        throw new Error(`Chromium exited before CDP became ready (${browser.exitCode ?? browser.signalCode})`);
      }
      try {
        const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) { version = await response.json(); break; }
      } catch {}
      await sleep(250);
    }
    if (!version) throw new Error('Chromium CDP did not become ready');

    const tabResponse = await fetch(`${endpoint}/json/new?${encodeURIComponent('http://127.0.0.1:3000/?view=markets')}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(10_000),
    });
    if (!tabResponse.ok) throw new Error(`Chromium tab creation failed: HTTP ${tabResponse.status}`);
    tab = await tabResponse.json();
    if (!tab?.id || !tab?.webSocketDebuggerUrl) throw new Error('Chromium tab response did not include a CDP socket');

    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off('open', onOpen);
        socket.off('error', onError);
        reject(new Error('Chromium CDP socket did not open within 10 seconds'));
      }, 10_000);
      const onOpen = () => {
        clearTimeout(timer);
        resolve();
      };
      const onError = (error) => {
        clearTimeout(timer);
        socket.off('open', onOpen);
        reject(error);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });

    let requestId = 1;
    const pending = new Map();
    const lifecycleEvents = [];
    const lifecycleWaiters = new Set();
    const rejectPending = (error) => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      pending.clear();
      for (const waiter of lifecycleWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      lifecycleWaiters.clear();
    };
    socket.on('close', () => rejectPending(new Error('Chromium CDP socket closed')));
    socket.on('error', (error) => rejectPending(error));
    socket.on('message', (payload) => {
      const message = JSON.parse(payload.toString());
      if (message.id != null) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
        return;
      }
      if (message.method !== 'Page.lifecycleEvent') return;
      lifecycleEvents.push(message.params);
      for (const waiter of lifecycleWaiters) {
        if (!waiter.matches(message.params)) continue;
        lifecycleWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message.params);
      }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error(`Cannot send ${method}: Chromium CDP socket is not open`));
        return;
      }
      const id = requestId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chromium CDP ${method} timed out`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const waiter = pending.get(id);
        if (!waiter) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const waitForLifecycle = (matches, timeoutMs) => {
      const observed = lifecycleEvents.find(matches);
      if (observed) return Promise.resolve(observed);
      return new Promise((resolve, reject) => {
        const waiter = { matches, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          lifecycleWaiters.delete(waiter);
          reject(new Error('Timed out waiting for the navigation document lifecycle'));
        }, timeoutMs);
        lifecycleWaiters.add(waiter);
      });
    };
    await Promise.all([
      send('Page.enable'),
      send('Runtime.enable'),
      send('Page.setLifecycleEventsEnabled', { enabled: true }),
    ]);

    return {
      async collect(expectedMarketCount) {
        const navigation = await send('Page.navigate', { url: 'http://127.0.0.1:3000/?view=markets' });
        if (navigation.errorText) throw new Error(`Markets navigation failed: ${navigation.errorText}`);
        if (!navigation.loaderId) throw new Error('Markets navigation did not create a new document');
        await waitForLifecycle((event) => event.name === 'DOMContentLoaded'
          && event.loaderId === navigation.loaderId
          && event.frameId === navigation.frameId, 120_000);

        const snapshotExpression = `(() => {
          const expected = ${Number(expectedMarketCount)};
          const nodes = [...document.querySelectorAll('[data-market-freshness]')];
          const counts = { fresh: 0, stale: 0, refreshing: 0, not_scanned: 0 };
          const unrecognized = [];
          for (const node of nodes) {
            const state = node.getAttribute('data-market-freshness');
            if (state in counts) counts[state] += 1;
            else unrecognized.push(state);
          }
          const total = nodes.length;
          const recognizedTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
          const staleWithoutReason = nodes.filter((node) => node.getAttribute('data-market-freshness') === 'stale'
            && !(node.getAttribute('title') || '').trim()).length;
          const renderedRows = document.querySelectorAll('table tbody tr').length;
          const hydrated = total === expected && recognizedTotal === total && renderedRows === expected;
          return { hydrated, total, recognizedTotal, unrecognized, ...counts, staleWithoutReason, renderedRows };
        })()`;
        const readyBy = Date.now() + 120_000;
        let snapshot;
        while (Date.now() < readyBy) {
          snapshot = await evaluate(snapshotExpression);
          if (snapshot.total === expectedMarketCount && snapshot.recognizedTotal !== snapshot.total) {
            throw new Error(`Unrecognized Markets freshness states: ${JSON.stringify(snapshot.unrecognized)}`);
          }
          if (snapshot.hydrated) return snapshot;
          await sleep(500);
        }
        throw new Error(`Markets UI did not hydrate after navigation: ${JSON.stringify(snapshot)}`);
      },
      close: cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Markets UI probe initialization and cleanup failed');
    }
    throw error;
  }
}

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
const uiProbe = await startMarketsUiProbe();
try {
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
  const uiFreshness = await uiProbe.collect(markets.markets.length);
  samples.push({
    at: new Date().toISOString(),
    deployment: health.deployment,
    components: health.components,
    scheduler: health.savedMarketScheduler,
    botWorkflow: bot.workflow,
    markets: { total: markets.markets.length, ...projection },
    uiFreshness,
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
} finally {
  await uiProbe.close();
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
    && last.botWorkflow?.latestDecisionScanId === last.botWorkflow?.latestCompletedScanId,
  canonicalPopulationComplete: samples.every((sample) => sample.markets.total === 476 && sample.markets.scanned === 476
    && sample.markets.unavailableWithoutReason === 0 && sample.markets.zeroCurrentRoi === 0),
  hydratedMarketsWithinSla: samples.every((sample) => sample.uiFreshness.hydrated
    && sample.uiFreshness.total === sample.markets.total
    && sample.uiFreshness.recognizedTotal === sample.uiFreshness.total
    && sample.uiFreshness.fresh + sample.uiFreshness.stale + sample.uiFreshness.refreshing + sample.uiFreshness.not_scanned === sample.uiFreshness.total
    && sample.uiFreshness.renderedRows === sample.markets.total
    && sample.uiFreshness.stale * 2 < sample.uiFreshness.total
    && sample.uiFreshness.staleWithoutReason === 0
    && sample.uiFreshness.not_scanned === 0),
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
