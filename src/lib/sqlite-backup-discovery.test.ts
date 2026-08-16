import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findLatestSqliteBackup } from './sqlite-backup-discovery.mjs';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('SQLite backup discovery', () => {
  it('selects the newest recovery backup across canonical and legacy locations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sqlite-backup-discovery-'));
    created.push(root);
    const canonical = path.join(root, 'backups', 'edgefinder-canonical.db');
    const legacy = path.join(root, 'data', 'backups', 'edgefinder-legacy.db');
    await mkdir(path.dirname(canonical), { recursive: true });
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(canonical, 'canonical');
    await writeFile(legacy, 'legacy');
    await utimes(canonical, new Date(2_000), new Date(2_000));
    await utimes(legacy, new Date(1_000), new Date(1_000));

    await expect(findLatestSqliteBackup(root)).resolves.toMatchObject({ path: canonical });
  });

  it('returns null when neither backup location exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sqlite-backup-discovery-'));
    created.push(root);
    await expect(findLatestSqliteBackup(root)).resolves.toBeNull();
  });
});