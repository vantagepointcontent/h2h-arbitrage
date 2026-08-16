import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectDiskCapacityHealth } from '../../scripts/disk-capacity-monitor.mjs';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('disk capacity monitoring', () => {
  it('emits health, Prometheus metrics, forecasts, and a durable warning alert', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'disk-monitor-'));
    created.push(root);
    const data = path.join(root, 'data');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(data));
    await writeFile(path.join(data, 'disk-capacity-metrics.jsonl'), `${JSON.stringify({
      at: '2026-08-15T00:00:00.000Z',
      operation: 'monitor',
      usedBytes: 60_000_000_000,
      totalBytes: 80_000_000_000,
    })}\n`);

    const health = await collectDiskCapacityHealth({
      root,
      now: new Date('2026-08-16T00:00:00.000Z'),
      snapshot: {
        totalBytes: 80_000_000_000,
        freeBytes: 18_000_000_000,
        totalInodes: 10_000_000,
        availableInodes: 9_000_000,
      },
    });

    expect(health.alert).toBe('critical');
    expect(health.forecast).not.toBeNull();
    if (!health.forecast) throw new Error('expected forecast');
    expect(health.forecast.daysUntilReserve).toBeCloseTo(1.5);
    expect(await readFile(path.join(data, 'disk-capacity.prom'), 'utf8')).toContain('h2h_disk_usage_percent 77.5');
    expect(await readFile(path.join(data, 'disk-capacity-health.json'), 'utf8')).toContain('"alert": "critical"');
    expect(await readFile(path.join(data, 'disk-capacity-alerts.jsonl'), 'utf8')).toContain('"level":"critical"');
  });
});
