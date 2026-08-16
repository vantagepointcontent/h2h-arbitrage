import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
// Node 22 runtime API; @types/node is pinned below the runtime version.
// @ts-expect-error node:sqlite is available in the deployed Node runtime.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created: string[] = [];
const controller = path.resolve(process.cwd(), 'scripts/workspace-cleanup.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops149-'));
  created.push(root);
  const repo = path.join(root, 'repo');
  const worktrees = path.join(repo, '.worktrees');
  const workspaces = path.join(root, 'workspaces');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(worktrees, { recursive: true });
  fs.mkdirSync(workspaces, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);

  const dbPath = path.join(root, 'kanban.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT,
      status TEXT NOT NULL, priority INTEGER DEFAULT 0, created_by TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
      workspace_kind TEXT DEFAULT 'worktree', workspace_path TEXT,
      branch_name TEXT, claim_lock TEXT, claim_expires INTEGER, tenant TEXT,
      result TEXT, idempotency_key TEXT, consecutive_failures INTEGER DEFAULT 0,
      worker_pid INTEGER, last_failure_error TEXT, max_runtime_seconds INTEGER,
      last_heartbeat_at INTEGER, current_run_id INTEGER
    );
    CREATE TABLE task_runs (id INTEGER PRIMARY KEY, task_id TEXT, status TEXT);
    CREATE TABLE task_links (parent_id TEXT, child_id TEXT);
  `);
  const insert = db.prepare('INSERT INTO tasks (id,title,status,created_at,workspace_path,branch_name,current_run_id) VALUES (?,?,?,?,?,?,?)');
  const states = [
    ['t_00000001', 'running'],
    ['t_00000002', 'review'],
    ['t_00000003', 'ready'],
    ['t_00000004', 'blocked'],
    ['t_00000005', 'done'],
    ['t_00000006', 'done'],
  ] as const;
  for (const [id, status] of states) {
    const workspace = path.join(worktrees, id);
    fs.mkdirSync(path.join(workspace, '.next'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.next', 'cache.bin'), 'regenerable');
    fs.writeFileSync(path.join(workspace, 'evidence.txt'), 'must survive');
    insert.run(id, id, status, Date.now(), workspace, `wt/${id}`, status === 'running' ? 1 : null);
  }
  db.prepare('INSERT INTO task_runs (id,task_id,status) VALUES (1,?,?)').run('t_00000001', 'running');
  // A terminal parent with an active child must remain fully protected.
  db.prepare('INSERT INTO task_links (parent_id,child_id) VALUES (?,?)').run('t_00000006', 't_00000001');
  db.close();
  return { root, repo, worktrees, workspaces, tmp, dbPath };
}

function run(f: ReturnType<typeof fixture>, extra: string[] = []) {
  return JSON.parse(execFileSync('node', [controller, '--live', '--mode', 'sweep', '--db', f.dbPath,
    '--repo-root', f.repo, '--worktrees-root', f.worktrees, '--workspaces-root', f.workspaces,
    '--tmp-root', f.tmp, '--log', path.join(f.root, 'cleanup.jsonl'), '--metrics', path.join(f.root, 'metrics.jsonl'),
    ...extra], { encoding: 'utf8' }));
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('OPS-149 lifecycle cleanup', () => {
  it('protects active/review/ready and active-child work while pruning only regenerable terminal caches', () => {
    const f = fixture();
    run(f);
    for (const id of ['t_00000001', 't_00000002', 't_00000003', 't_00000006']) {
      expect(fs.existsSync(path.join(f.worktrees, id, '.next', 'cache.bin'))).toBe(true);
    }
    for (const id of ['t_00000004', 't_00000005']) {
      expect(fs.existsSync(path.join(f.worktrees, id, '.next'))).toBe(false);
      expect(fs.readFileSync(path.join(f.worktrees, id, 'evidence.txt'), 'utf8')).toBe('must survive');
    }
  });

  it('is idempotent across repeated cleanup cycles', () => {
    const f = fixture();
    run(f);
    const second = run(f);
    expect(second.bytesReclaimed).toBe(0);
    expect(fs.existsSync(path.join(f.worktrees, 't_00000005', 'evidence.txt'))).toBe(true);
  });
});
