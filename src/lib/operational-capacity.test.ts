import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('operator capacity gates', () => {
  it('makes the safe backup path and every migration script run a capacity preflight', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

    expect(pkg.scripts['backup:db']).toBe('node scripts/safe-sqlite-backup.mjs');
    expect(pkg.scripts['backup:db:dry-run']).toBe('node scripts/safe-sqlite-backup.mjs --dry-run');
    expect(pkg.scripts['storage:retention:dry-run']).toBe('node scripts/storage-retention.mjs');
    expect(pkg.scripts['storage:retention']).toBe('node scripts/storage-retention.mjs --live');
    expect(pkg.scripts['migrate:poll-leases']).toMatch(/^node scripts\/disk-capacity-check\.mjs --operation migration/);
    expect(pkg.scripts['migrate:bot-position-pm-identities']).toMatch(/^node scripts\/disk-capacity-check\.mjs --operation migration/);
  });

  it('runs the disk monitor continuously under PM2', async () => {
    const ecosystem = await readFile(path.join(root, 'ecosystem.config.js'), 'utf8');
    expect(ecosystem).toContain("name: 'h2h-disk-monitor'");
    expect(ecosystem).toContain("script: './scripts/disk-capacity-monitor.mjs'");
    expect(ecosystem).toContain("name: 'h2h-storage-retention'");
    expect(ecosystem).toContain("args: '--live --daemon'");
    expect(ecosystem).toContain("cron_restart: '30 3 * * *'");
    const monitor = await readFile(path.join(root, 'scripts', 'disk-capacity-monitor.mjs'), 'utf8');
    const retention = await readFile(path.join(root, 'scripts', 'storage-retention.mjs'), 'utf8');
    expect(monitor).toContain("process.env.pm_id !== undefined");
    expect(retention).toContain("process.env.pm_id !== undefined");
  });
});
