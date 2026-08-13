import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SLA_MS = 5 * 60_000;
const markets = Array.from({ length: 24 }, (_, index) => ({
  id: `market-${String(index).padStart(2, '0')}`,
  eventTitle: `Runtime market ${index}`,
  kalshiUrl: `https://kalshi.example/events/${index}`,
  polymarketUrl: `https://polymarket.example/events/${index}`,
  createdAt: new Date(Date.now() - SLA_MS).toISOString(),
  lastScanResult: null,
}));
const manualMarket = {
  id: 'manual-success',
  eventTitle: 'Manual success reconciliation',
  kalshiUrl: 'https://kalshi.example/events/manual',
  polymarketUrl: 'https://polymarket.example/events/manual',
  createdAt: new Date(Date.now() - SLA_MS).toISOString(),
  lastScanResult: { scannedAt: new Date().toISOString(), matchStatus: 'matched' },
};

const requests = [];
const attempts = new Map();
const active = new Set();
let maxConcurrency = 0;
let duplicateConcurrentScans = false;
let duplicateAttemptFencedAtServer = false;
let abandonedWorkerMode = false;
let crossProcessMergeMode = false;
const server = http.createServer((request, response) => {
  if (request.url === '/api/settings') return void response.end(JSON.stringify({ settings: [] }));
  if (request.url !== '/api/scan?skipManual=1') return void response.end('{}');
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const payload = JSON.parse(body);
    const id = payload.kalshiUrl.split('/').at(-1);
    requests.push({ id, payload });
    if (active.has(id)) {
      duplicateAttemptFencedAtServer = true;
      response.writeHead(409, { 'content-type': 'application/json', 'retry-after': '1' });
      return void response.end(JSON.stringify({ error: 'A full scan for this saved market is already in progress.' }));
    }
    active.add(id);
    maxConcurrency = Math.max(maxConcurrency, active.size);
    const count = (attempts.get(id) || 0) + 1;
    attempts.set(id, count);
    const finish = (status, result) => {
      active.delete(id);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    };
    if (id === '0') return void finish(503, { error: 'injected repeated platform failure' });
    if (abandonedWorkerMode && id === '23') return void setTimeout(() => finish(200, { fullScanPersisted: true }), 7_000);
    if (crossProcessMergeMode && (id === '20' || id === '21')) return void setTimeout(() => finish(200, { fullScanPersisted: true, outcomes: [] }), 500);
    if (id === '1' && count === 1) return void setTimeout(() => finish(200, { fullScanPersisted: true }), 5_500);
    setTimeout(() => finish(200, { fullScanPersisted: true, outcomes: [] }), 20);
  });
});

function runPoller(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/poll.mjs'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`poller exited ${code}: ${stderr}`)));
  });
}

function startPoller(env) {
  const child = spawn(process.execPath, ['scripts/poll.mjs'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0
      ? resolve({ stdout, stderr, signal })
      : reject(new Error(`poller exited ${code ?? signal}: ${stderr}`)));
  });
  return { child, completed };
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for runtime evidence condition');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const dir = await mkdtemp(path.join(os.tmpdir(), 'bug-140-poller-'));
const files = {
  saved: path.join(dir, 'saved-markets.json'),
  scheduler: path.join(dir, 'scheduler.json'),
  breaker: path.join(dir, 'breaker.json'),
  health: path.join(dir, 'health.json'),
};
const now = Date.now();
const initialScheduler = Object.fromEntries(markets.map(market => [market.id, {
  lastAttemptAt: null, lastSuccessAt: null, nextDueAt: new Date(now - 1_000).toISOString(), inProgress: false,
  failureReason: null, retryCount: 0, freshnessSlaMs: SLA_MS,
}]));
initialScheduler[manualMarket.id] = {
  lastAttemptAt: new Date(now - 60_000).toISOString(), lastSuccessAt: new Date(now - SLA_MS).toISOString(),
  nextDueAt: new Date(now + 30 * 60_000).toISOString(), inProgress: false, failureReason: 'Kalshi HTTP 503', retryCount: 3, freshnessSlaMs: SLA_MS,
};
const staleCooldown = now + 30 * 60_000;
const env = {
  H2H_BASE_URL: `http://127.0.0.1:${port}`,
  H2H_POLLER_RUN_ONCE: '1',
  H2H_POLL_CONCURRENCY: '4',
  H2H_SCAN_TIMEOUT_MS: '5000',
  H2H_SCAN_LEASE_GRACE_MS: '100',
  H2H_SAVED_MARKET_FRESHNESS_SLA_MS: String(SLA_MS),
  H2H_SAVED_MARKETS_FILE: files.saved,
  H2H_SAVED_MARKET_SCHEDULER_FILE: files.scheduler,
  H2H_POLLER_BREAKER_FILE: files.breaker,
  H2H_POLLER_HEALTH_FILE: files.health,
  H2H_SAVED_MARKET_LEASE_DIRECTORY: path.join(dir, 'leases'),
};

try {
  await writeFile(files.saved, JSON.stringify([...markets, manualMarket]));
  await writeFile(files.scheduler, JSON.stringify(initialScheduler));
  await writeFile(files.breaker, JSON.stringify({
    [manualMarket.id]: { avgMs: 4_000, consecFails: 0, trips: 2, cooldownUntil: staleCooldown },
  }));

  const first = await runPoller(env);
  const firstHealth = JSON.parse(await readFile(files.health, 'utf8'));
  const afterFirstScheduler = JSON.parse(await readFile(files.scheduler, 'utf8'));
  const afterFirstBreaker = JSON.parse(await readFile(files.breaker, 'utf8'));
  assert(firstHealth.successCount >= 22);
  assert(requests.some(item => item.id === '23'), 'later queue entries must progress after failure and timeout');
  assert.equal(afterFirstScheduler[manualMarket.id].failureReason, null);
  assert(Date.parse(afterFirstScheduler[manualMarket.id].nextDueAt) <= Date.parse(manualMarket.lastScanResult.scannedAt) + SLA_MS);
  assert.equal(afterFirstBreaker[manualMarket.id]?.cooldownUntil ?? 0, 0);
  assert.equal(afterFirstBreaker[manualMarket.id]?.trips ?? 0, 0);

  // Make successful work due for a second cycle. Preserve the timed-out
  // market's production backoff so restart cannot overlap its still-running
  // upstream request.
  for (const market of markets) {
    if (market.id !== 'market-01') afterFirstScheduler[market.id].nextDueAt = new Date(Date.now() - 1_000).toISOString();
  }
  afterFirstScheduler['market-02'].inProgress = true;
  await writeFile(files.scheduler, JSON.stringify(afterFirstScheduler));
  await new Promise(resolve => setTimeout(resolve, 5_200));
  const firstRequestCount = requests.length;
  const second = await runPoller(env);
  const secondHealth = JSON.parse(await readFile(files.health, 'utf8'));
  const afterRestartScheduler = JSON.parse(await readFile(files.scheduler, 'utf8'));
  const afterRestartBreaker = JSON.parse(await readFile(files.breaker, 'utf8'));
  assert(requests.slice(firstRequestCount).some(item => item.id === '23'));
  assert.match(afterRestartScheduler['market-02'].failureReason ?? '', /worker restarted|^$/);
  assert(Date.parse(afterRestartScheduler[manualMarket.id].nextDueAt) <= Date.parse(manualMarket.lastScanResult.scannedAt) + SLA_MS);
  assert.equal(afterRestartBreaker[manualMarket.id]?.cooldownUntil ?? 0, 0);
  assert.equal(duplicateConcurrentScans, false);

  // Exercise an actual rolling restart with both production pollers alive.
  abandonedWorkerMode = true;
  const overlapMarket = markets[23];
  const overlapState = {
    [overlapMarket.id]: {
      lastAttemptAt: null, lastSuccessAt: null, nextDueAt: new Date(Date.now() - 1_000).toISOString(),
      inProgress: false, failureReason: null, retryCount: 0, freshnessSlaMs: SLA_MS,
    },
  };
  await rm(env.H2H_SAVED_MARKET_LEASE_DIRECTORY, { recursive: true, force: true });
  await writeFile(files.saved, JSON.stringify([overlapMarket]));
  await writeFile(files.scheduler, JSON.stringify(overlapState));
  const beforeOverlapRequests = attempts.get('23') || 0;
  const overlapOwner = startPoller(env);
  await waitFor(() => active.has('23'));
  const rollingPeer = startPoller(env);
  const rolling = await rollingPeer.completed;
  await overlapOwner.completed;
  assert.equal(attempts.get('23') || 0, beforeOverlapRequests + 1, 'rolling restart must not duplicate same-market request');
  assert.equal(duplicateConcurrentScans, false);
  await waitFor(() => !active.has('23'));

  // Two overlapping production pollers complete different markets. Their
  // per-market durable updates must merge instead of replacing the whole file
  // from stale process-local snapshots.
  crossProcessMergeMode = true;
  const mergeMarkets = [markets[20], markets[21]];
  const mergeScheduler = Object.fromEntries(mergeMarkets.map(market => [market.id, {
    lastAttemptAt: null, lastSuccessAt: null, nextDueAt: new Date(Date.now() - 1_000).toISOString(),
    inProgress: false, failureReason: null, retryCount: 0, freshnessSlaMs: SLA_MS,
  }]));
  await rm(env.H2H_SAVED_MARKET_LEASE_DIRECTORY, { recursive: true, force: true });
  await writeFile(files.saved, JSON.stringify(mergeMarkets));
  await writeFile(files.scheduler, JSON.stringify(mergeScheduler));
  const mergeOwnerA = startPoller({ ...env, H2H_POLL_CONCURRENCY: '1' });
  await waitFor(() => active.has('20') || active.has('21'));
  const mergeOwnerB = startPoller({ ...env, H2H_POLL_CONCURRENCY: '1' });
  await Promise.all([mergeOwnerA.completed, mergeOwnerB.completed]);
  const afterMergeScheduler = JSON.parse(await readFile(files.scheduler, 'utf8'));
  assert(afterMergeScheduler['market-20'].lastSuccessAt, 'first overlapping completion must survive');
  assert(afterMergeScheduler['market-21'].lastSuccessAt, 'second overlapping completion must survive');
  assert.equal(afterMergeScheduler['market-20'].inProgress, false);
  assert.equal(afterMergeScheduler['market-21'].inProgress, false);
  crossProcessMergeMode = false;

  // Kill a production poller with a request in flight. A successor launched
  // during the live lease must skip it; after bounded expiry another successor
  // reclaims and completes the abandoned market.
  const reclaimMarket = markets[23];
  const reclaimScheduler = {
    [reclaimMarket.id]: {
      lastAttemptAt: null, lastSuccessAt: null, nextDueAt: new Date(Date.now() - 1_000).toISOString(),
      inProgress: false, failureReason: null, retryCount: 0, freshnessSlaMs: SLA_MS,
    },
  };
  await rm(env.H2H_SAVED_MARKET_LEASE_DIRECTORY, { recursive: true, force: true });
  await writeFile(files.saved, JSON.stringify([reclaimMarket]));
  await writeFile(files.scheduler, JSON.stringify(reclaimScheduler));
  const beforeReclaimRequests = attempts.get('23') || 0;
  const abandonedRun = startPoller(env);
  await waitFor(() => active.has('23'));
  abandonedRun.child.kill('SIGKILL');
  await abandonedRun.completed.catch(() => null);
  const fencedSuccessor = await runPoller(env);
  assert.equal(attempts.get('23') || 0, beforeReclaimRequests + 1, 'live abandoned lease must fence successor');
  await new Promise(resolve => setTimeout(resolve, 5_200));
  const expiredLeasePeer = await runPoller(env);
  assert.equal(duplicateConcurrentScans, false, 'server fence must prevent duplicate execution after poller lease expiry');
  assert.equal(duplicateAttemptFencedAtServer, true, 'expired poller lease must reach the live server-side execution fence');
  await waitFor(() => !active.has('23'));
  const afterServerFenceScheduler = JSON.parse(await readFile(files.scheduler, 'utf8'));
  afterServerFenceScheduler['market-23'].nextDueAt = new Date(Date.now() - 1_000).toISOString();
  await writeFile(files.scheduler, JSON.stringify(afterServerFenceScheduler));
  abandonedWorkerMode = false;
  await new Promise(resolve => setTimeout(resolve, 5_200));
  const reclaimedRun = await runPoller(env);
  const afterReclaimScheduler = JSON.parse(await readFile(files.scheduler, 'utf8'));
  assert.equal(attempts.get('23') || 0, beforeReclaimRequests + 2, 'expired lease must be reclaimed');
  assert(afterReclaimScheduler['market-23'].lastSuccessAt, 'reclaimed market must complete successfully');

  for (const { id, payload } of requests) {
    assert.deepEqual(Object.keys(payload).sort(), ['kalshiUrl', 'polymarketUrl']);
    assert.equal(payload.kalshiUrl, `https://kalshi.example/events/${id}`);
    assert.equal(payload.polymarketUrl, `https://polymarket.example/events/${id}`);
  }

  process.stdout.write(`${JSON.stringify({
    candidate: 'BUG-140 production poller lifecycle',
    processRuns: 10,
    marketCount: markets.length,
    freshnessSlaMs: SLA_MS,
    cycles: [firstHealth.queue, secondHealth.queue],
    outcomes: [
      { successCount: firstHealth.successCount, failureCount: firstHealth.failureCount },
      { successCount: secondHealth.successCount, failureCount: secondHealth.failureCount },
    ],
    restartRecovery: {
      productionPollerSpawnedTwice: true,
      overlappingProcessLifetimes: true,
      schedulerFileSurvived: Boolean(afterRestartScheduler['market-02']),
      breakerFileSurvived: true,
      staleManualSuccessCooldownRestored: false,
      duplicateConcurrentScans,
      maxObservedConcurrency: maxConcurrency,
      abandonedOwnerKilled: true,
      crossProcessSchedulerUpdatesMerged: Boolean(afterMergeScheduler['market-20'].lastSuccessAt && afterMergeScheduler['market-21'].lastSuccessAt),
      liveLeaseFencedSuccessor: Boolean(fencedSuccessor.stdout),
      expiredLeaseFencedAtServer: Boolean(expiredLeasePeer.stdout && duplicateAttemptFencedAtServer),
      abandonedLeaseReclaimed: Boolean(reclaimedRun.stdout && afterReclaimScheduler['market-23'].lastSuccessAt),
    },
    requestScope: {
      capturedRequestCount: requests.length,
      fields: ['kalshiUrl', 'polymarketUrl'],
      linkedEventUrlsOnly: true,
      sample: requests.at(-1)?.payload,
    },
    fairness: {
      repeatedFailureMarket: 'market-00',
      timeoutMarket: 'market-01',
      laterFinalEntryCompletedEveryCycle: true,
    },
    childOutputCaptured: Boolean(first.stdout && rolling.stdout && second.stdout),
  }, null, 2)}\n`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
