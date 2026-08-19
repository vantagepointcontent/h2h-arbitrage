#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { assertDiskCapacity } from '../src/lib/disk-capacity.mjs';

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertAbsent(file) {
  try {
    const handle = await open(file, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Refusing to overwrite existing backup: ${file}`);
    throw error;
  }
  await import('node:fs/promises').then(({ rm }) => rm(file));
}

function sqliteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function createSqliteBackup(options) {
  const source = path.resolve(options.source);
  const destination = path.resolve(options.destination);
  const sourceStat = await stat(source);
  const metricsPath = options.metricsPath ?? path.join(path.dirname(source), 'backup-capacity-metrics.jsonl');
  const capacity = await assertDiskCapacity('backup', {
    snapshot: options.capacitySnapshot,
    burstBytes: sourceStat.size + 256_000_000,
    metricsPath,
  });

  if (options.dryRun) {
    return { dryRun: true, source, destination, sourceBytes: sourceStat.size, capacity };
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await assertAbsent(destination);
  const sourceDb = createClient({ url: `file:${source}` });
  try {
    const sourceIntegrity = await sourceDb.execute('PRAGMA integrity_check');
    if (String(sourceIntegrity.rows[0]?.integrity_check ?? '') !== 'ok') {
      throw new Error('Source SQLite integrity check failed; backup aborted');
    }
    await sourceDb.execute(`VACUUM INTO ${sqliteLiteral(destination)}`);
  } finally {
    sourceDb.close();
  }

  const backupDb = createClient({ url: `file:${destination}` });
  let integrity;
  try {
    const checked = await backupDb.execute('PRAGMA integrity_check');
    integrity = String(checked.rows[0]?.integrity_check ?? 'unknown');
  } finally {
    backupDb.close();
  }
  if (integrity !== 'ok') throw new Error(`Backup SQLite integrity check failed: ${integrity}`);

  const result = {
    at: new Date().toISOString(),
    dryRun: false,
    source,
    destination,
    sourceBytes: sourceStat.size,
    backupBytes: (await stat(destination)).size,
    sha256: await sha256(destination),
    integrity,
  };
  const auditPath = options.auditPath ?? path.join(path.dirname(source), 'backup-audit.jsonl');
  await appendFile(auditPath, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o640 });
  return result;
}

function parseArgs(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const source = value('--source') ?? path.join(process.cwd(), 'data', 'edgefinder.db');
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  return {
    source,
    destination: value('--destination') ?? path.join(process.cwd(), 'backups', `edgefinder-${stamp}.db`),
    dryRun: argv.includes('--dry-run'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createSqliteBackup(parseArgs(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
