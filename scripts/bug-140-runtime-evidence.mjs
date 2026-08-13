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
    if (active.has(id)) duplicateConcurrentScans = true;
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
  H2H_SAVED_MARKET_FRESHNESS_SLA_MS: String(SLA_MS),
  H2H_SAVED_MARKETS_FILE: files.saved,
  H2H_SAVED_MARKET_SCHEDULER_FILE: files.scheduler,
  H2H_POLLER_BREAKER_FILE: files.breaker,
  H2H_POLLER_HEALTH_FILE: files.health,
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

  for (const { id, payload } of requests) {
    assert.deepEqual(Object.keys(payload).sort(), ['kalshiUrl', 'polymarketUrl']);
    assert.equal(payload.kalshiUrl, `https://kalshi.example/events/${id}`);
    assert.equal(payload.polymarketUrl, `https://polymarket.example/events/${id}`);
  }

  process.stdout.write(`${JSON.stringify({
    candidate: 'BUG-140 production poller lifecycle',
    processRuns: 2,
    marketCount: markets.length,
    freshnessSlaMs: SLA_MS,
    cycles: [firstHealth.queue, secondHealth.queue],
    outcomes: [
      { successCount: firstHealth.successCount, failureCount: firstHealth.failureCount },
      { successCount: secondHealth.successCount, failureCount: secondHealth.failureCount },
    ],
    restartRecovery: {
      productionPollerSpawnedTwice: true,
      schedulerFileSurvived: Boolean(afterRestartScheduler['market-02']),
      breakerFileSurvived: true,
      staleManualSuccessCooldownRestored: false,
      duplicateConcurrentScans,
      maxObservedConcurrency: maxConcurrency,
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
    childOutputCaptured: Boolean(first.stdout && second.stdout),
  }, null, 2)}\n`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
