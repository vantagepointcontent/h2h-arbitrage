import assert from 'node:assert/strict';
import http from 'node:http';
import {
  buildSchedulerState,
  completeAttempt,
  markAttemptStarted,
  schedulerMetrics,
  selectDueMarkets,
} from './poll-scheduler.mjs';

const SLA_MS = 5 * 60_000;
const START = Date.parse('2026-08-13T20:00:00Z');
const markets = Array.from({ length: 24 }, (_, index) => ({
  id: `market-${String(index).padStart(2, '0')}`,
  eventTitle: `Runtime market ${index}`,
  kalshiUrl: `https://kalshi.example/events/${index}`,
  polymarketUrl: `https://polymarket.example/events/${index}`,
  createdAt: new Date(START - SLA_MS).toISOString(),
  lastScanResult: null,
}));

const requests = [];
const attempts = new Map();
const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const payload = JSON.parse(body);
    requests.push(payload);
    const count = (attempts.get(payload.savedMarketId) || 0) + 1;
    attempts.set(payload.savedMarketId, count);
    if (payload.savedMarketId === 'market-00') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'injected repeated platform failure' }));
      return;
    }
    if (payload.savedMarketId === 'market-01' && count === 1) {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ fullScanPersisted: true }));
      }, 500);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ fullScanPersisted: true }));
  });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
let state = buildSchedulerState(markets, {}, START, SLA_MS);
const cycles = [];

async function scanMarket(market, now, timeoutMs = 200) {
  const payload = {
    savedMarketId: market.id,
    kalshiUrl: market.kalshiUrl,
    polymarketUrl: market.polymarketUrl,
  };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json();
    completeAttempt(state[market.id], response.ok && result.fullScanPersisted === true
      ? { ok: true }
      : { ok: false, error: result.error || `HTTP ${response.status}` }, now, SLA_MS, SLA_MS);
    return response.ok && result.fullScanPersisted === true;
  } catch (error) {
    completeAttempt(state[market.id], { ok: false, error: error.name === 'TimeoutError' ? 'scan timeout' : error.message }, now, SLA_MS, SLA_MS);
    return false;
  }
}

async function runCycle(now) {
  const due = selectDueMarkets(markets, state, now, markets.length);
  const completed = [];
  const failed = [];
  for (let offset = 0; offset < due.length; offset += 4) {
    const batch = due.slice(offset, offset + 4);
    for (const market of batch) markAttemptStarted(state[market.id], now);
    const outcomes = await Promise.all(batch.map(market => scanMarket(market, now + 1_000)));
    outcomes.forEach((ok, index) => (ok ? completed : failed).push(batch[index].id));
  }
  const metrics = schedulerMetrics(markets, state, now + 1_000, SLA_MS);
  cycles.push({ now: new Date(now).toISOString(), due: due.length, completed, failed, metrics });
}

try {
  await runCycle(START);
  assert(cycles[0].completed.includes('market-23'), 'later queue entries must complete after prefix failures');
  assert.deepEqual(cycles[0].failed.sort(), ['market-00', 'market-01']);

  const restartAt = START + 2 * SLA_MS;
  state['market-02'].nextDueAt = new Date(restartAt).toISOString();
  markAttemptStarted(state['market-02'], restartAt);
  state = buildSchedulerState(markets, JSON.parse(JSON.stringify(state)), restartAt, SLA_MS);
  assert.equal(state['market-02'].inProgress, false);
  assert.match(state['market-02'].failureReason, /worker restarted/);
  assert(selectDueMarkets(markets, state, restartAt, markets.length).some(market => market.id === 'market-02'));

  await runCycle(restartAt);
  assert(cycles[1].completed.includes('market-23'), 'second cycle must reach the final queue entry');
  assert.equal(new Set(cycles[1].completed).size, cycles[1].completed.length, 'restart must not duplicate concurrent scans');

  for (const payload of requests) {
    const market = markets.find(candidate => candidate.id === payload.savedMarketId);
    assert.deepEqual(Object.keys(payload).sort(), ['kalshiUrl', 'polymarketUrl', 'savedMarketId']);
    assert.equal(payload.kalshiUrl, market.kalshiUrl);
    assert.equal(payload.polymarketUrl, market.polymarketUrl);
  }

  const report = {
    candidate: 'BUG-140 saved-market scheduler',
    marketCount: markets.length,
    freshnessSlaMs: SLA_MS,
    cycles,
    restartRecovery: {
      interruptedMarket: 'market-02',
      recoveredDue: true,
      duplicateConcurrentScans: false,
    },
    requestScope: {
      capturedRequestCount: requests.length,
      fields: ['savedMarketId', 'kalshiUrl', 'polymarketUrl'],
      linkedEventUrlsOnly: true,
      sample: requests.at(-1),
    },
    fairness: {
      repeatedFailureMarket: 'market-00',
      timeoutMarket: 'market-01',
      laterFinalEntryCompletedEveryCycle: cycles.every(cycle => cycle.completed.includes('market-23')),
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await new Promise(resolve => server.close(resolve));
}
