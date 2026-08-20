#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { appendFile, lstat, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { planBackupRetention } from '../src/lib/backup-retention.mjs';

const execFileAsync = promisify(execFile);

async function appendBounded(file, row) {
  try {
    if ((await stat(file)).size >= 1_000_000) {
      await rm(`${file}.1`, { force: true });
      await rename(file, `${file}.1`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await appendFile(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o640 });
}

async function bytes(root) {
  const info = await lstat(root);
  if (!info.isDirectory()) return info.size;
  let total = info.size;
  for (const entry of await readdir(root)) total += await bytes(path.join(root, entry));
  return total;
}

async function hasOpenFiles(candidate) {
  try {
    const info = await lstat(candidate);
    const args = info.isDirectory() ? ['+D', candidate] : ['--', candidate];
    await execFileAsync('lsof', args, { timeout: 30_000 });
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}

export async function enforceBackupRetention(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const backupRoot = path.join(root, 'backups');
  const policyPath = options.policyPath ?? path.join(root, 'data', 'backup-retention-policy.json');
  let policy;
  try {
    policy = JSON.parse(await readFile(policyPath, 'utf8'));
  } catch (error) {
    throw new Error(`Backup retention policy is missing or unreadable at ${policyPath}; refusing all deletes. ${error instanceof Error ? error.message : String(error)}`);
  }
  let entries = [];
  try {
    entries = await readdir(backupRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    // No backups directory is not permission to delete anything.
    return { at: new Date().toISOString(), mode: options.live ? 'live' : 'dry-run', protected: policy.protectedNames, kept: [], events: [], reclaimedBytes: 0, note: 'backups directory does not exist' };
  }
  const candidates = await Promise.all(entries
    .filter((entry) => /^(?:ops|bug|edgefinder|snapshot)/i.test(entry.name))
    .map(async (entry) => ({
      name: entry.name,
      path: path.join(backupRoot, entry.name),
      modifiedAtMs: (await lstat(path.join(backupRoot, entry.name))).mtimeMs,
      bytes: await bytes(path.join(backupRoot, entry.name)),
    })));
  const plan = planBackupRetention(candidates, {
    maxAgeDays: policy.maxAgeDays,
    keepNewest: policy.keepNewest,
    protectedNames: new Set(policy.protectedNames),
    requiredReclaimBytes: options.requiredReclaimBytes,
  });

  const events = [];
  for (const candidate of plan.delete) {
    const candidateBytes = await bytes(candidate.path);
    if (await hasOpenFiles(candidate.path)) {
      events.push({ action: 'skip-open', path: candidate.path, bytes: candidateBytes });
      continue;
    }
    if (!options.live) {
      events.push({ action: 'would-delete', path: candidate.path, bytes: candidateBytes });
      continue;
    }
    await rm(candidate.path, { recursive: true, force: false });
    events.push({ action: 'deleted', path: candidate.path, bytes: candidateBytes });
  }
  const result = {
    at: new Date().toISOString(),
    mode: options.live ? 'live' : 'dry-run',
    protected: policy.protectedNames,
    kept: plan.keep.map((entry) => entry.name),
    events,
    reclaimedBytes: events.filter((event) => event.action === 'deleted').reduce((sum, event) => sum + event.bytes, 0),
  };
  const auditPath = options.auditPath ?? path.join(root, 'data', 'backup-retention-metrics.jsonl');
  await appendBounded(auditPath, result);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requiredFreeIndex = process.argv.indexOf('--required-free-bytes');
  let requiredReclaimBytes;
  if (requiredFreeIndex >= 0) {
    const requiredFreeBytes = Number(process.argv[requiredFreeIndex + 1]);
    const { bavail, bsize } = await import('node:fs/promises')
      .then(({ statfs }) => statfs('/', { bigint: true }));
    requiredReclaimBytes = Math.max(0, requiredFreeBytes - Number(bavail * bsize));
  }
  enforceBackupRetention({ live: process.argv.includes('--live'), requiredReclaimBytes })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
