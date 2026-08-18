#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { enforceBackupRetention } from './backup-retention.mjs';
import { evaluateDiskCapacity, readDiskCapacitySnapshot } from '../src/lib/disk-capacity.mjs';
import { assessSavedMarketScannerHealth } from '../src/lib/saved-market-scanner-health.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const HEALTH_FILE = path.join(DATA, 'saved-market-scanner-health.json');
const SCHEDULER_FILE = path.join(DATA, 'saved-market-scheduler.json');
const RESTART_COOLDOWN_MS = 5 * 60_000;
const RETENTION_COOLDOWN_MS = 15 * 60_000;
let lastRestartAt = 0;
let lastRetentionAt = 0;

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

export async function inspectSavedMarketScanner(options = {}) {
  const now = options.now ?? Date.now();
  const active = path.join(ROOT, '.h2h-releases', 'active');
  const manifest = await readJson(path.join(active, 'release-manifest.json'), {});
  const workerPath = path.join(active, '.next', 'full-scan-worker.cjs');
  const pollerHealth = await readJson(path.join(DATA, 'poller-health.json'));
  const telemetry = await readJson(path.join(DATA, 'scan-worker-telemetry-health.json'), {});
  let scheduler;
  try {
    const value = JSON.parse(await readFile(SCHEDULER_FILE, 'utf8'));
    scheduler = { readable: value && typeof value === 'object' && !Array.isArray(value), entries: Object.values(value ?? {}) };
  } catch (error) {
    scheduler = { readable: false, entries: [], error: error instanceof Error ? error.message : String(error) };
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
    sqlite: { exhaustedWrites: 0 },
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
  const snapshot = { ...result, recoveryAction };
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