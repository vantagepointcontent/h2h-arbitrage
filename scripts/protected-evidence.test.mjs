import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  evaluateEvidenceDeletion,
  markDelivered,
  readManifest,
  recordIrrecoverableEvidence,
  registerEvidence,
  verifyEvidence,
} from '../src/lib/protected-evidence.mjs';

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'protected-evidence-test-'));
  const root = path.join(base, 'managed');
  const source = path.join(base, 'source.bin');
  writeFileSync(source, Buffer.from('recovery evidence\n'));
  return { base, root, source };
}

test('copies bytes and verifies owner, hash, and delivery state at report time', () => {
  const { root, source } = fixture();
  const registered = registerEvidence({
    root,
    sourcePath: source,
    taskId: 't_1234abcd',
    evidenceId: 'snapshot-1',
    ownerProfile: 'test-owner',
  });
  assert.equal(registered.protected, true);
  assert.equal(registered.delivery.state, 'pending');
  assert.deepEqual(registered.owner, { taskId: 't_1234abcd', profile: 'test-owner', pid: process.pid });
  const verification = verifyEvidence({ root, taskId: 't_1234abcd', evidenceId: 'snapshot-1' });
  assert.equal(verification.preserved, true);
  assert.equal(verification.current, true);
  assert.equal(verification.state, 'verified');
  assert.equal(verification.actual.sha256, registered.payload.sha256);
});

test('does not claim preservation after payload mutation', () => {
  const { root, source } = fixture();
  const registered = registerEvidence({ root, sourcePath: source, taskId: 't_1234abcd', evidenceId: 'snapshot-2' });
  writeFileSync(registered.payload.path, Buffer.from('tampered\n'));
  const verification = verifyEvidence({ root, taskId: 't_1234abcd', evidenceId: 'snapshot-2' });
  assert.equal(verification.preserved, false);
  assert.equal(verification.state, 'corrupt');
  assert.throws(
    () => markDelivered({ root, taskId: 't_1234abcd', evidenceId: 'snapshot-2', reference: 'attachment:1' }),
    /unverified/,
  );
});

test('records irrecoverability without a false payload or hash claim', () => {
  const { root, base } = fixture();
  recordIrrecoverableEvidence({
    root,
    taskId: 't_1234abcd',
    evidenceId: 'lost-snapshot',
    expectedPath: path.join(base, 'absent.db'),
    reason: 'deleted by destructive regression test',
  });
  const verification = verifyEvidence({ root, taskId: 't_1234abcd', evidenceId: 'lost-snapshot' });
  assert.equal(verification.preserved, false);
  assert.equal(verification.current, true);
  assert.equal(verification.state, 'irrecoverable');
  assert.equal(verification.manifest.payload, null);
});

test('deletion fails closed for protected or unreadable records', () => {
  const { root, source } = fixture();
  registerEvidence({ root, sourcePath: source, taskId: 't_1234abcd', evidenceId: 'snapshot-3' });
  assert.deepEqual(
    evaluateEvidenceDeletion({ root, taskId: 't_1234abcd', evidenceId: 'snapshot-3' }),
    { allowed: false, reason: 'protected-evidence' },
  );
  const record = readManifest({ root, taskId: 't_1234abcd', evidenceId: 'snapshot-3' });
  writeFileSync(record.manifestHashPath, 'invalid  manifest.json\n');
  assert.equal(evaluateEvidenceDeletion({ root, taskId: 't_1234abcd', evidenceId: 'snapshot-3' }).allowed, false);
});

test('workspace cleanup refuses a symlink resolving into managed evidence', () => {
  const { base, root, source } = fixture();
  const registered = registerEvidence({ root, sourcePath: source, taskId: 't_1234abcd', evidenceId: 'snapshot-4' });
  const fakeRepo = path.join(base, 'repo');
  const scratchRoot = path.join(base, 'scratch');
  mkdirSync(fakeRepo, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: fakeRepo });
  mkdirSync(scratchRoot, { recursive: true });
  const candidate = path.join(scratchRoot, 't_deadbeef-protected');
  symlinkSync(path.dirname(registered.payload.path), candidate, 'dir');
  const kanbanDb = path.join(base, 'kanban.db');
  const db = new DatabaseSync(kanbanDb);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, branch_name TEXT, current_run_id INTEGER, workspace_path TEXT);
    CREATE TABLE task_runs (id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE task_links (parent_id TEXT, child_id TEXT);`);
  db.close();
  execFileSync('node', [
    path.resolve('scripts/workspace-cleanup.mjs'), '--live', '--mode', 'lifecycle',
    '--repo-root', fakeRepo, '--tmp-root', scratchRoot,
    '--worktrees-root', path.join(base, 'worktrees'), '--workspaces-root', path.join(base, 'workspaces'),
    '--log', path.join(base, 'cleanup.jsonl'), '--metrics', path.join(base, 'metrics.jsonl'),
  ], {
    cwd: path.resolve('.'),
    env: { ...process.env, HERMES_KANBAN_DB: kanbanDb, H2H_EVIDENCE_ROOT: root },
    stdio: 'pipe',
  });
  assert.equal(existsSync(candidate), true);
  assert.equal(readFileSync(registered.payload.path, 'utf8'), 'recovery evidence\n');
  assert.match(readFileSync(path.join(base, 'cleanup.jsonl'), 'utf8'), /remove-failed/);
});
