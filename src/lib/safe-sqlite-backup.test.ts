import { createClient } from '@libsql/client';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteBackup } from '../../scripts/safe-sqlite-backup.mjs';

const created: string[] = [];
const roomy = {
  totalBytes: 80_000_000_000,
  freeBytes: 30_000_000_000,
  totalInodes: 10_000_000,
  availableInodes: 5_000_000,
};

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safe-backup-'));
  created.push(root);
  const source = path.join(root, 'source.db');
  const db = createClient({ url: `file:${source}` });
  await db.execute('CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  await db.execute({ sql: 'INSERT INTO evidence(value) VALUES (?)', args: ['retained'] });
  db.close();
  return { root, source, destination: path.join(root, 'backups', 'snapshot.db') };
}

describe('capacity-gated SQLite backups', () => {
  it('checks capacity during dry-run without creating the backup', async () => {
    const { source, destination } = await fixture();
    const result = await createSqliteBackup({ source, destination, dryRun: true, capacitySnapshot: roomy });

    expect(result.dryRun).toBe(true);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails before writing when the backup would breach reserved headroom', async () => {
    const { source, destination } = await fixture();
    await expect(createSqliteBackup({
      source,
      destination,
      capacitySnapshot: { ...roomy, freeBytes: 14_000_000_000 },
    })).rejects.toThrow(/capacity gate|headroom/i);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates and verifies a consistent SQLite snapshot', async () => {
    const { source, destination } = await fixture();
    const result = await createSqliteBackup({ source, destination, capacitySnapshot: roomy });
    expect('integrity' in result).toBe(true);
    if (!('integrity' in result)) throw new Error('expected live backup result');
    expect(result.integrity).toBe('ok');

    const backup = createClient({ url: `file:${destination}` });
    const rows = await backup.execute('SELECT value FROM evidence');
    backup.close();
    expect(rows.rows[0].value).toBe('retained');
  });
});
