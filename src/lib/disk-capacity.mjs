import { appendFile, mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';

const GB = 1_000_000_000;
const DEFAULT_RESERVE_BYTES = 15 * GB;
const DEFAULT_RESERVE_INODES = 100_000;
const DEFAULT_BURST_BYTES = Object.freeze({
  scan: 128_000_000,
  build: 4 * GB,
  backup: 2 * GB,
  migration: 4 * GB,
  promotion: 2 * GB,
  maintenance: 256_000_000,
});

export class DiskCapacityError extends Error {
  constructor(result) {
    super(`Disk capacity gate blocked ${result.operation}: ${result.reason}`);
    this.name = 'DiskCapacityError';
    this.code = 'DISK_CAPACITY';
    this.result = result;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function evaluateDiskCapacity(operation, snapshot, options = {}) {
  const reserveBytes = positiveInteger(options.reserveBytes, DEFAULT_RESERVE_BYTES);
  const reserveInodes = positiveInteger(options.reserveInodes, DEFAULT_RESERVE_INODES);
  const burstBytes = positiveInteger(
    options.burstBytes,
    DEFAULT_BURST_BYTES[operation] ?? DEFAULT_BURST_BYTES.maintenance,
  );
  const burstInodes = positiveInteger(options.burstInodes, operation === 'build' ? 50_000 : 1_000);
  const projectedFreeBytes = snapshot.freeBytes - burstBytes;
  const projectedAvailableInodes = snapshot.availableInodes - burstInodes;
  let reason = null;
  if (projectedFreeBytes < reserveBytes) {
    reason = `projected free bytes ${projectedFreeBytes} would breach reserved headroom ${reserveBytes}`;
  } else if (projectedAvailableInodes < reserveInodes) {
    reason = `projected available inodes ${projectedAvailableInodes} would breach inode reserve ${reserveInodes}`;
  }
  return {
    at: new Date().toISOString(),
    operation,
    allowed: reason === null,
    reason,
    totalBytes: snapshot.totalBytes,
    freeBytes: snapshot.freeBytes,
    usedBytes: snapshot.totalBytes - snapshot.freeBytes,
    usagePct: snapshot.totalBytes > 0
      ? ((snapshot.totalBytes - snapshot.freeBytes) / snapshot.totalBytes) * 100
      : 0,
    totalInodes: snapshot.totalInodes,
    availableInodes: snapshot.availableInodes,
    inodeUsagePct: snapshot.totalInodes > 0
      ? ((snapshot.totalInodes - snapshot.availableInodes) / snapshot.totalInodes) * 100
      : 0,
    burstBytes,
    burstInodes,
    reserveBytes,
    reserveInodes,
    projectedFreeBytes,
    projectedAvailableInodes,
  };
}

export function forecastDiskExhaustion(samples, reserveBytes = DEFAULT_RESERVE_BYTES) {
  const ordered = samples
    .filter((sample) => Number.isFinite(Date.parse(sample.at)) && Number.isFinite(sample.usedBytes))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  if (ordered.length < 2) return null;
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const elapsedDays = (Date.parse(last.at) - Date.parse(first.at)) / 86_400_000;
  if (elapsedDays < 1 / 24) return null;
  const growthBytesPerDay = (last.usedBytes - first.usedBytes) / elapsedDays;
  if (growthBytesPerDay <= 0) return { growthBytesPerDay, daysUntilReserve: null };
  const remainingBeforeReserve = last.totalBytes - reserveBytes - last.usedBytes;
  return {
    growthBytesPerDay,
    daysUntilReserve: Math.max(0, remainingBeforeReserve / growthBytesPerDay),
  };
}

export function classifyDiskAlert(snapshot, forecast) {
  const saturation = Math.max(snapshot.usagePct, snapshot.inodeUsagePct);
  if (saturation >= 95) return 'emergency';
  if (saturation >= 90 || (forecast?.daysUntilReserve != null && forecast.daysUntilReserve <= 3)) return 'critical';
  if (saturation >= 75 || (forecast?.daysUntilReserve != null && forecast.daysUntilReserve <= 7)) return 'warning';
  return 'ok';
}

export async function readDiskCapacitySnapshot(targetPath = '/') {
  const stats = await statfs(targetPath, { bigint: true });
  const totalBytes = Number(stats.blocks * stats.bsize);
  const freeBytes = Number(stats.bavail * stats.bsize);
  return {
    totalBytes,
    freeBytes,
    totalInodes: Number(stats.files),
    availableInodes: Number(stats.ffree),
  };
}

async function appendMetric(metricsPath, result) {
  await mkdir(path.dirname(metricsPath), { recursive: true });
  try {
    if ((await stat(metricsPath)).size >= 5_000_000) {
      await rm(`${metricsPath}.1`, { force: true });
      await rename(metricsPath, `${metricsPath}.1`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await appendFile(metricsPath, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o640 });
}

export async function assertDiskCapacity(operation, options = {}) {
  const snapshot = options.snapshot ?? await readDiskCapacitySnapshot(options.path ?? '/');
  const result = evaluateDiskCapacity(operation, snapshot, {
    reserveBytes: options.reserveBytes
      ?? positiveInteger(process.env.H2H_DISK_RESERVE_BYTES, DEFAULT_RESERVE_BYTES),
    reserveInodes: options.reserveInodes
      ?? positiveInteger(process.env.H2H_DISK_RESERVE_INODES, DEFAULT_RESERVE_INODES),
    burstBytes: options.burstBytes,
    burstInodes: options.burstInodes,
  });
  if (options.now) result.at = new Date(options.now).toISOString();
  const metricsPath = options.metricsPath
    ?? process.env.H2H_DISK_METRICS_PATH
    ?? path.join(process.cwd(), 'data', 'disk-capacity-metrics.jsonl');
  await appendMetric(metricsPath, result);
  if (!result.allowed) throw new DiskCapacityError(result);
  return result;
}
