#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access, appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { enforceBackupRetention } from './backup-retention.mjs';
import { evaluateDiskCapacity, readDiskCapacitySnapshot } from '../src/lib/disk-capacity.mjs';
import { assessSavedMarketScannerHealth, deriveScannerQueue } from '../src/lib/saved-market-scanner-health.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const HEALTH_FILE = path.join(DATA, 'saved-market-scanner-health.json');
const SCHEDULER_FILE = path.join(DATA, 'saved-market-scheduler.json');
const ALERT_FILE = path.join(DATA, 'saved-market-scanner-alerts.jsonl');
const ALERT_STATE_FILE = path.join(DATA, 'saved-market-scanner-alert-state.json');
const RESTART_COOLDOWN_MS = 5 * 60_000;
const RETENTION_COOLDOWN_MS = 15 * 60_000;
const ALERT_REPEAT_MS = 15 * 60_000;
let lastRestartAt = 0;
let lastRetentionAt = 0;

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function readJsonSource(file, label) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { readable: false, value: null, error: `${label} is not a JSON object: ${file}` };
    }
    return { readable: true, value, error: null };
  } catch (error) {
    return {
      readable: false,
      value: null,
      error: `${label} is missing or malformed at ${file}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readApplicationHealth(options) {
  if (Object.hasOwn(options, 'healthSnapshot')) return options.healthSnapshot;
  const baseUrl = process.env.H2H_BASE_URL || 'http://localhost:3000';
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    return { sqliteContention: {
      readable: false,
      error: `Application health source failed: ${error instanceof Error ? error.message : String(error)}`,
    } };
  }
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

async function sendOperationalAlert(snapshot) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { delivered: false, destination: 'unconfigured', error: 'Telegram operational alert destination is not configured' };
  const text = [
    snapshot.state === 'degraded' ? 'H2H saved-market scanner DEGRADED' : 'H2H saved-market scanner RECOVERED',
    `reason=${snapshot.degradedReason ?? 'cleared'}`,
    `detail=${snapshot.detail ?? 'healthy'}`,
    `commit=${snapshot.owner?.commit ?? 'unknown'} build=${snapshot.owner?.buildId ?? 'unknown'} pollerPid=${snapshot.owner?.pollerPid ?? 'unknown'}`,
    `eligible=${snapshot.queue?.eligibleCount ?? 'unknown'} due=${snapshot.queue?.dueCount ?? 'unknown'} overdue=${snapshot.queue?.overdueCount ?? 'unknown'} failed=${snapshot.queue?.failedCount ?? 'unknown'}`,
    `oldestSuccessAgeMs=${snapshot.oldestSuccessAgeMs ?? 'unknown'} lastAttempt=${snapshot.lastAttemptAt ?? 'none'} lastCompletion=${snapshot.lastCompletionAt ?? 'none'}`,
    `recovery=${snapshot.recoveryAction?.type ?? 'none'}`,
    `checkedAt=${snapshot.checkedAt}`,
  ].join('\n');
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.description || `HTTP ${response.status}`);
    return { delivered: true, destination: 'telegram' };
  } catch (error) {
    return { delivered: false, destination: 'telegram', error: error instanceof Error ? error.message : String(error) };
  }
}

async function publishOperationalAlert(snapshot, options, now) {
  const previous = await readJson(ALERT_STATE_FILE, null);
  const changed = previous?.state !== snapshot.state || previous?.degradedReason !== snapshot.degradedReason;
  const repeatDue = snapshot.state === 'degraded'
    && now - Date.parse(previous?.lastAlertAt ?? '') >= ALERT_REPEAT_MS;
  const shouldAlert = snapshot.state === 'degraded'
    ? changed || !previous || repeatDue
    : previous?.state === 'degraded';
  if (!shouldAlert) return { durable: true, delivered: previous?.delivered === true, destination: previous?.destination ?? null, suppressed: true };

  const event = {
    at: new Date(now).toISOString(),
    state: snapshot.state,
    degradedReason: snapshot.degradedReason,
    detail: snapshot.detail,
    owner: snapshot.owner,
    queue: snapshot.queue,
    oldestSuccessAgeMs: snapshot.oldestSuccessAgeMs,
    lastAttemptAt: snapshot.lastAttemptAt,
    lastCompletionAt: snapshot.lastCompletionAt,
    recoveryAction: snapshot.recoveryAction,
  };
  await appendFile(ALERT_FILE, `${JSON.stringify(event)}\n`);
  const delivery = await (options.alertSender ?? sendOperationalAlert)(snapshot);
  await atomicWrite(ALERT_STATE_FILE, {
    state: snapshot.state,
    degradedReason: snapshot.degradedReason,
    lastAlertAt: event.at,
    ...delivery,
  });
  return { durable: true, ...delivery, suppressed: false };
}

export async function inspectSavedMarketScanner(options = {}) {
  const now = options.now ?? Date.now();
  const active = path.join(ROOT, '.h2h-releases', 'active');
  const manifest = await readJson(path.join(active, 'release-manifest.json'), {});
  const workerPath = path.join(active, '.next', 'full-scan-worker.cjs');
  let pollerHealth = await readJson(path.join(DATA, 'poller-health.json'));
  const telemetryPath = path.join(DATA, 'scan-worker-telemetry-health.json');
  const telemetrySource = await readJsonSource(telemetryPath, 'Worker telemetry health');
  const telemetry = telemetrySource.readable
    ? { ...telemetrySource.value, readable: true }
    : { readable: false, error: telemetrySource.error };
  const applicationHealth = await readApplicationHealth(options);
  const applicationSqlite = applicationHealth?.sqliteContention;
  const workerSqlite = applicationHealth?.scanWorkers;
  const exhaustionTimes = [applicationSqlite?.lastExhaustedAt, workerSqlite?.sqliteLastExhaustedAt]
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort();
  const sqlite = applicationSqlite
    ? {
      readable: applicationSqlite.readable !== false,
      busyRetries: (Number(applicationSqlite.busyRetries) || 0) + (Number(workerSqlite?.sqliteBusyRetries) || 0),
      exhaustedWrites: (Number(applicationSqlite.exhaustedWrites) || 0) + (Number(workerSqlite?.sqliteExhaustedWrites) || 0),
      lastBusyAt: workerSqlite?.sqliteLastBusyAt ?? applicationSqlite.lastBusyAt ?? null,
      lastExhaustedAt: exhaustionTimes.at(-1) ?? null,
    }
    : { readable: false, error: 'Application health did not expose sqliteContention metrics' };
  let scheduler;
  let schedulerState = {};
  try {
    const value = JSON.parse(await readFile(SCHEDULER_FILE, 'utf8'));
    schedulerState = value ?? {};
    scheduler = { readable: value && typeof value === 'object' && !Array.isArray(value), entries: Object.values(schedulerState) };
  } catch (error) {
    scheduler = { readable: false, entries: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (scheduler.readable && !pollerHealth?.queue) {
    const markets = await readJson(path.join(DATA, 'saved-markets.json'), []);
    const eligibleEntries = markets
      .filter((market) => market?.kalshiUrl && market?.polymarketUrl)
      .filter((market) => !market.expiryDate
        || Date.parse(market.expiryDate) > now
        || market.lastScanResult?.priceResolved === false)
      .map((market) => schedulerState[market.id])
      .filter(Boolean);
    pollerHealth = {
      ...pollerHealth,
      queue: deriveScannerQueue(eligibleEntries, now, Number(pollerHealth?.freshnessSlaMs) || 60 * 60_000),
    };
  }
  const diskSnapshot = await readDiskCapacitySnapshot('/');
  const disk = evaluateDiskCapacity('scan', diskSnapshot, {
    reserveBytes: Number(process.env.H2H_DISK_RESERVE_BYTES) || 15_000_000_000,
  });
  const result = assessSavedMarketScannerHealth({
    now,
    deployment: { commit: manifest.commit ?? null, buildId: manifest.buildId ?? null },
    workerBundle: { exists: await exists(workerPath), path: workerPath },
    pollerHealth,
    scheduler,
    disk,
    sqlite,
    telemetry,
    expectedSchedulerVersion: 'bug-165-v1',
  });
  let recoveryAction = null;
  if (result.degradedReason === 'disk_capacity') {
    const target = Number(process.env.H2H_DISK_RECOVERY_FREE_BYTES) || 21_000_000_000;
    const requiredReclaimBytes = Math.max(0, target - diskSnapshot.freeBytes);
    if (requiredReclaimBytes > 0 && now - lastRetentionAt >= RETENTION_COOLDOWN_MS) {
      const retention = await enforceBackupRetention({ root: ROOT, live: true, requiredReclaimBytes });
      lastRetentionAt = now;
      recoveryAction = { type: 'capacity_retention', requiredReclaimBytes, reclaimedBytes: retention.reclaimedBytes };
    }
  } else if (result.restartRecommended && now - lastRestartAt >= RESTART_COOLDOWN_MS) {
    if (result.degradedReason === 'scheduler_state_unusable' && await exists(SCHEDULER_FILE)) {
      const quarantine = `${SCHEDULER_FILE}.corrupt.${now}`;
      await rename(SCHEDULER_FILE, quarantine);
      recoveryAction = { type: 'scheduler_state_quarantined', path: quarantine };
    }
    await execFileAsync('pm2', ['restart', 'h2h-poller', '--update-env'], { cwd: ROOT });
    lastRestartAt = now;
    recoveryAction = { ...recoveryAction, type: 'poller_restart', at: new Date(now).toISOString() };
  }
  const alertSubject = { ...result, recoveryAction };
  const operationalAlert = await publishOperationalAlert(alertSubject, options, now);
  const snapshot = { ...alertSubject, operationalAlert };
  await atomicWrite(HEALTH_FILE, snapshot);
  return snapshot;
}

async function main() {
  const daemon = process.argv.includes('--daemon');
  const intervalMs = Math.max(10_000, Number(process.env.H2H_SCAN_SUPERVISOR_INTERVAL_MS) || 60_000);
  do {
    try { console.log(JSON.stringify(await inspectSavedMarketScanner())); }
    catch (error) { console.error(error instanceof Error ? error.stack : String(error)); }
    if (daemon) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (daemon);
}

if ((process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  || process.env.pm_id !== undefined) void main();