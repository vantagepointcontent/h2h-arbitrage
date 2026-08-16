#!/usr/bin/env node
import { appendFile, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDiskCapacity,
  classifyDiskAlert,
  forecastDiskExhaustion,
} from '../src/lib/disk-capacity.mjs';

async function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(file), { recursive: true }));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(temporary, content, { mode: 0o640 }));
  await rename(temporary, file);
}

async function readSamples(file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendBounded(file, row, maxBytes = 1_000_000) {
  try {
    if ((await stat(file)).size >= maxBytes) {
      await rm(`${file}.1`, { force: true });
      await rename(file, `${file}.1`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o640 });
}

function prometheus(health) {
  const days = health.forecast?.daysUntilReserve ?? -1;
  const levels = { ok: 0, warning: 1, critical: 2, emergency: 3 };
  return [
    '# HELP h2h_disk_usage_percent Root filesystem byte usage.',
    '# TYPE h2h_disk_usage_percent gauge',
    `h2h_disk_usage_percent ${health.usagePct}`,
    '# HELP h2h_disk_inode_usage_percent Root filesystem inode usage.',
    '# TYPE h2h_disk_inode_usage_percent gauge',
    `h2h_disk_inode_usage_percent ${health.inodeUsagePct}`,
    '# HELP h2h_disk_free_bytes Root filesystem available bytes.',
    '# TYPE h2h_disk_free_bytes gauge',
    `h2h_disk_free_bytes ${health.freeBytes}`,
    '# HELP h2h_disk_days_until_reserve Forecast days until production reserve is breached; -1 means no growth forecast.',
    '# TYPE h2h_disk_days_until_reserve gauge',
    `h2h_disk_days_until_reserve ${days}`,
    '# HELP h2h_disk_alert_level Alert severity (0 ok, 1 warning, 2 critical, 3 emergency).',
    '# TYPE h2h_disk_alert_level gauge',
    `h2h_disk_alert_level ${levels[health.alert]}`,
    '',
  ].join('\n');
}

export async function collectDiskCapacityHealth(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const data = path.join(root, 'data');
  const metricsPath = path.join(data, 'disk-capacity-metrics.jsonl');
  const now = options.now ?? new Date();
  let capacity;
  try {
    capacity = await assertDiskCapacity('monitor', {
      snapshot: options.snapshot,
      burstBytes: 0,
      burstInodes: 0,
      metricsPath,
      now,
    });
  } catch (error) {
    if (error?.code !== 'DISK_CAPACITY') throw error;
    capacity = error.result;
  }

  const recentCutoff = Date.parse(new Date(now).toISOString()) - 7 * 86_400_000;
  const samples = (await readSamples(metricsPath)).filter((sample) =>
    sample.operation === 'monitor' && Date.parse(sample.at) >= recentCutoff);
  const forecast = forecastDiskExhaustion(samples, capacity.reserveBytes);
  const alert = classifyDiskAlert(capacity, forecast);
  const health = {
    at: new Date(now).toISOString(),
    alert,
    freeBytes: capacity.freeBytes,
    reserveBytes: capacity.reserveBytes,
    usagePct: capacity.usagePct,
    availableInodes: capacity.availableInodes,
    inodeUsagePct: capacity.inodeUsagePct,
    forecast,
  };
  await atomicWrite(path.join(data, 'disk-capacity-health.json'), `${JSON.stringify(health, null, 2)}\n`);
  await atomicWrite(path.join(data, 'disk-capacity.prom'), prometheus(health));
  if (alert !== 'ok') {
    await appendBounded(path.join(data, 'disk-capacity-alerts.jsonl'), {
      at: health.at,
      level: alert,
      message: `Disk capacity ${alert}: ${health.usagePct.toFixed(1)}% bytes, ${health.inodeUsagePct.toFixed(1)}% inodes, ${forecast?.daysUntilReserve?.toFixed(1) ?? 'unknown'} days until reserve`,
    });
  }
  return health;
}

async function run() {
  const once = process.argv.includes('--once');
  do {
    try {
      const health = await collectDiskCapacityHealth();
      const output = JSON.stringify(health);
      if (health.alert === 'ok') console.log(output);
      else console.error(output);
    } catch (error) {
      console.error(error instanceof Error ? error.stack : String(error));
    }
    if (!once) await new Promise((resolve) => setTimeout(resolve, 60_000));
  } while (!once);
}

if ((process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  || process.env.pm_id !== undefined) {
  run();
}
