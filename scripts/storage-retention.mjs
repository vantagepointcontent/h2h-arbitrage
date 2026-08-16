#!/usr/bin/env node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runStorageRetention(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const live = options.live === true;
  const commands = [
    ['node', ['scripts/workspace-cleanup.mjs', live ? '--live' : '--dry-run', '--include-node-modules', '--log', 'artifacts/storage-retention.jsonl', '--metrics', 'data/workspace-cleanup-metrics.jsonl']],
    ['node', ['scripts/backup-retention.mjs', ...(live ? ['--live'] : [])]],
    ['node', ['scripts/artifact-retention.mjs', ...(live ? ['--live'] : [])]],
    ...(live ? [['node', ['scripts/release-manager.mjs', 'cleanup', '--keep', '2']]] : []),
  ];
  const results = [];
  for (const [command, args] of commands) {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: root, timeout: 10 * 60_000 });
    results.push({ command: [command, ...args].join(' '), stdout: stdout.trim(), stderr: stderr.trim() });
  }
  return { at: new Date().toISOString(), mode: live ? 'live' : 'dry-run', results };
}

if ((process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  || process.env.pm_id !== undefined) {
  const daemon = process.argv.includes('--daemon');
  const live = process.argv.includes('--live');
  (async () => {
    do {
      console.log(JSON.stringify(await runStorageRetention({ live })));
      if (daemon) await new Promise((resolve) => setTimeout(resolve, 24 * 60 * 60_000));
    } while (daemon);
  })().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
