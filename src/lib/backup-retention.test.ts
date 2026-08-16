import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { enforceBackupRetention } from '../../scripts/backup-retention.mjs';
import { planBackupRetention } from './backup-retention.mjs';

describe('backup retention', () => {
  it('never selects protected backups and keeps the newest bounded rollback set', () => {
    const now = Date.parse('2026-08-16T00:00:00.000Z');
    const candidates = [
      ['protected-old', 1],
      ['newest', 15],
      ['second', 14],
      ['third', 13],
      ['expired', 1],
    ].map(([name, day]) => ({ name, modifiedAtMs: Date.parse(`2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`) }));

    const plan = planBackupRetention(candidates, {
      now,
      maxAgeDays: 7,
      keepNewest: 3,
      protectedNames: new Set(['protected-old']),
    });

    expect(plan.delete.map((item) => item.name)).toEqual(['expired']);
    expect(plan.keep.map((item) => item.name)).toEqual(expect.arrayContaining(['protected-old', 'newest', 'second', 'third']));
  });

  it('does not delete an eligible regular backup file held open by a process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'backup-retention-open-'));
    const backupRoot = path.join(root, 'backups');
    const candidate = path.join(backupRoot, 'edgefinder-old.db');
    const policyPath = path.join(root, 'backup-retention-policy.json');
    const auditPath = path.join(root, 'backup-retention.jsonl');
    await mkdir(backupRoot, { recursive: true });
    await writeFile(candidate, 'protected while open');
    await writeFile(policyPath, JSON.stringify({ maxAgeDays: -1, keepNewest: 0, protectedNames: [] }));

    const holder = spawn(process.execPath, [
      '-e',
      "const fs=require('fs');fs.openSync(process.argv[1],'r');process.stdout.write('ready');setTimeout(()=>{},30000)",
      candidate,
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await once(holder.stdout, 'data');
      const result = await enforceBackupRetention({ root, policyPath, auditPath, live: true });
      expect(result.events).toEqual([expect.objectContaining({ action: 'skip-open', path: candidate })]);
      await expect(stat(candidate)).resolves.toBeTruthy();
    } finally {
      holder.kill('SIGTERM');
      await once(holder, 'exit');
      await rm(root, { recursive: true, force: true });
    }
  });
});
