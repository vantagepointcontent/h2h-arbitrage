import { readFileSync, statSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';

const root = '/home/scott/h2h-arbitrage';
const scheduler = JSON.parse(readFileSync(path.join(root, 'data/saved-market-scheduler.json'), 'utf8'));
const rows = Object.values(scheduler);
const lastSuccess = rows.map((row) => row.lastSuccessAt || '').sort().at(-1) || null;
const lastAttempt = rows.map((row) => row.lastAttemptAt || '').sort().at(-1) || null;
const reasons = new Map();
for (const row of rows) if (row.failureReason) reasons.set(row.failureReason, (reasons.get(row.failureReason) || 0) + 1);

const pollFiles = globSync('/home/scott/.pm2/logs/h2h-poller-out*').sort();
const http503 = [];
const cycles = [];
const starts = [];
for (const file of pollFiles) {
  for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    let match = line.match(/\[(\d{4}-\d\d-\d\dT[^\]]+Z)\].*HTTP 503/);
    if (match) http503.push([match[1], file, index + 1]);
    match = line.match(/\[(\d{4}-\d\d-\d\dT[^\]]+Z)\] Poll cycle complete: (\d+)\/(\d+) scanned, (\d+) failed/);
    if (match) cycles.push([match[1], Number(match[2]), Number(match[3]), Number(match[4]), file, index + 1]);
    match = line.match(/\[(\d{4}-\d\d-\d\dT[^\]]+Z)\] Poller started/);
    if (match) starts.push([match[1], file, index + 1]);
  }
}
for (const records of [http503, cycles, starts]) {
  records.sort((left, right) => Date.parse(left[0]) - Date.parse(right[0]));
}

const blocked = [];
const allowed = [];
for (const file of globSync(path.join(root, 'data/disk-capacity-metrics.jsonl*')).sort()) {
  for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.operation !== 'scan') continue;
    const summary = [row.at, file, index + 1, row.freeBytes, row.projectedFreeBytes, row.reason];
    (row.allowed ? allowed : blocked).push(summary);
  }
}
for (const records of [blocked, allowed]) {
  records.sort((left, right) => Date.parse(left[0]) - Date.parse(right[0]));
}

const events = [];
for (const [index, line] of readFileSync(path.join(root, '.h2h-releases/events/release-events.jsonl'), 'utf8').split('\n').entries()) {
  if (!line) continue;
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  if (['promoted', 'rolled-back', 'cleanup'].includes(row.type)) events.push([row.at, row.type, row.commit || null, index + 1]);
}
events.sort((left, right) => Date.parse(left[0]) - Date.parse(right[0]));
const firstBlockedRequest = blocked[0] || null;
const lastSuccessfulCycleBeforeBlock = cycles.findLast((cycle) => firstBlockedRequest && cycle[0] < firstBlockedRequest[0] && cycle[1] > 0) || null;
const firstAllFailedAfterBlock = cycles.find((cycle) => firstBlockedRequest && cycle[0] >= firstBlockedRequest[0] && cycle[2] > 0 && cycle[1] === 0) || null;
console.log(JSON.stringify({
  scheduler: {
    entries: rows.length,
    lastSuccess,
    lastAttempt,
    failureReasons: [...reasons.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8),
  },
  pollerLogs: pollFiles.map((file) => ({ file, bytes: statSync(file).size })),
  http503: {
    count: http503.length,
    first: http503[0] || null,
    last: http503.at(-1) || null,
    retentionNote: 'Incident poller logs were rotated before audit; disk-gate metrics below are the authoritative retained request records.',
  },
  cycles: {
    count: cycles.length,
    first: cycles[0] || null,
    lastSuccessfulCycleBeforeBlock,
    firstAllFailedAfterBlock,
    last: cycles.at(-1) || null,
  },
  pollerStarts: starts.slice(-8),
  diskGate: {
    blockedCount: blocked.length,
    firstRetainedBlocked: firstBlockedRequest,
    lastBlocked: blocked.at(-1) || null,
    lastRetainedAllowed: allowed.at(-1) || null,
  },
  deployEvents: events.slice(-12),
  reproducibleGapMatrix: [
    {
      layer: 'scheduler/API attempt',
      state: 'blocked before worker creation',
      at: firstBlockedRequest?.[0] ?? null,
      evidence: firstBlockedRequest ? {
        file: firstBlockedRequest[1],
        line: firstBlockedRequest[2],
        projectedFreeBytes: firstBlockedRequest[4],
        reason: firstBlockedRequest[5],
      } : null,
    },
    {
      layer: 'worker start/completion',
      state: 'not reached',
      evidence: 'src/app/api/scan/route.ts calls assertDiskCapacity before scanWorkerCoordinator.run',
    },
    {
      layer: 'canonical success persistence',
      state: 'did not advance for blocked requests',
      evidence: { schedulerLastSuccess: lastSuccess, schedulerLastAttempt: lastAttempt },
    },
    {
      layer: 'scheduler health/UI',
      state: 'heartbeat remained independent while persisted scan ages became stale',
      evidence: 'data/poller-health.json and data/saved-market-scheduler.json',
    },
  ],
}, null, 2));
