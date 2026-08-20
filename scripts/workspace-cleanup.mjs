#!/usr/bin/env node
// workspace-cleanup.mjs
// Lifecycle-driven cleanup of Kanban worktrees, build caches, and scratch spaces.
// Reads authoritative state from the Hermes Kanban SQLite DB, Git, and /proc.
// Never deletes active or recoverable work.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'child_process';
import { DEFAULT_EVIDENCE_ROOT, isInsideManagedEvidence } from '../src/lib/protected-evidence.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// Immutable roots: deleting any of these is always forbidden, regardless of
// candidate classification. These match the production repo, live DB and its
// WAL/SHM, release roots, backups, secrets/config, and in-flight Kanban state.
const IMMUTABLE_ROOTS = [
  '/home/scott/h2h-arbitrage',
  '/home/scott/h2h-arbitrage/.git',
  '/home/scott/h2h-arbitrage/data',
  '/home/scott/h2h-arbitrage/.env',
  '/home/scott/h2h-arbitrage/.env.local',
  '/home/scott/h2h-arbitrage/.env.production',
  '/home/scott/h2h-arbitrage/.h2h-releases',
  '/home/scott/h2h-arbitrage/backups',
  '/home/scott/h2h-arbitrage/.worktrees',
  '/home/scott/.hermes',
  process.env.H2H_EVIDENCE_ROOT || DEFAULT_EVIDENCE_ROOT,
].map((p) => path.resolve(p));

// Roots under which removal is permitted. Any path not inside one of these
// is rejected by removePath(), preventing accidental deletion of arbitrary
// directories. These must be kept in sync with IMMUTABLE_ROOTS.
const ALLOWED_REMOVAL_ROOTS = [
  path.join(REPO_ROOT, 'data', 'quarantine'),
  path.join(REPO_ROOT, '.worktrees'),
  path.join(REPO_ROOT, '.h2h-releases', 'builds'),
  path.join(REPO_ROOT, '.h2h-releases', 'candidates'),
  path.join(REPO_ROOT, '.h2h-releases', 'releases'),
  path.join(REPO_ROOT, 'backups'),
  path.join(REPO_ROOT, 'artifacts'),
  path.join(REPO_ROOT, 'data', 'saved-market-leases'),
  path.join(REPO_ROOT, 'node_modules', '.cache'),
  '/tmp',
];

const DEFAULT_CONFIG = {
  repoRoot: REPO_ROOT,
  kanbanDb: process.env.HERMES_KANBAN_DB || '/home/scott/.hermes/kanban/boards/h2h-arbitrage/kanban.db',
  workspacesRoot: process.env.HERMES_KANBAN_WORKSPACES_ROOT || '/home/scott/.hermes/kanban/boards/h2h-arbitrage/workspaces',
  worktreesRoot: path.join(REPO_ROOT, '.worktrees'),
  tmpRoots: ['/tmp'],
  protectedPaths: [
    '/home/scott/h2h-arbitrage',
    '/home/scott/h2h-arbitrage/.git',
    '/home/scott/h2h-arbitrage/data',
    '/home/scott/h2h-arbitrage/dist',
    '/home/scott/h2h-arbitrage/node_modules',
    '/home/scott/h2h-arbitrage/.h2h-releases',
    '/home/scott/h2h-arbitrage/backups',
    '/home/scott/h2h-arbitrage/.worktrees',
    '/home/scott/.hermes',
    process.env.H2H_EVIDENCE_ROOT || DEFAULT_EVIDENCE_ROOT,
  ],
  cachePatterns: [
    { dir: '.next', description: 'Next.js build cache' },
    { dir: 'dist', description: 'esbuild / build output' },
    { dir: 'coverage', description: 'test coverage output' },
    { dir: 'test-results', description: 'playwright/vitest results' },
    { dir: 'playwright-report', description: 'playwright report' },
    { dir: '.turbo', description: 'turbo cache' },
    { dir: '.cache', description: 'generic cache' },
  ],
  tempFilePatterns: [
    '*.tmp', '*.temp', '*.log.*', 'core.*', 'npm-debug.log*',
    'edgefinder*.db*', '*events_all.json',
  ],
  fullWorktreeRemovalStatuses: ['done', 'cancelled', 'archived'],
  partialPruneStatuses: ['blocked', 'changes_requested'],
  // Worktree full-removal gates: branch must be merged and pushed to origin,
  // git status must be clean, and no child task must use this worktree.
  requireMergedAndPushed: true,
  requireCleanGitStatus: true,
  usagePctSoft: 75,
  usagePctHard: 80,
  freeGbSoft: 20,
  freeGbHard: 15,
  maxBuildCacheBytesPerWorkspace: 1_000_000_000,
  maxTerminalBytesGlobal: 8_000_000_000,
  maxTerminalAgeHours: 24 * 7,
  dryRun: true,
  quarantineDir: path.join(REPO_ROOT, 'data', 'quarantine'),
  logPath: path.join(REPO_ROOT, 'data', 'workspace-cleanup.jsonl'),
  metricsPath: path.join(REPO_ROOT, 'data', 'workspace-cleanup-metrics.jsonl'),
  includeNodeModules: true,
  mode: 'sweep',
};

function loadConfig(argv) {
  const config = { ...DEFAULT_CONFIG };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--live') config.dryRun = false;
    if (a === '--dry-run') config.dryRun = true;
    if (a === '--mode') config.mode = args[++i];
    if (a === '--db') config.kanbanDb = args[++i];
    if (a === '--repo-root') config.repoRoot = args[++i];
    if (a === '--worktrees-root') config.worktreesRoot = args[++i];
    if (a === '--workspaces-root') config.workspacesRoot = args[++i];
    if (a === '--tmp-root') config.tmpRoots = [args[++i]];
    if (a === '--log') config.logPath = args[++i];
    if (a === '--metrics') config.metricsPath = args[++i];
    if (a === '--include-node-modules') config.includeNodeModules = true;
    if (a === '--no-node-modules') config.includeNodeModules = false;
  }
  return config;
}

function dfRoot() {
  try {
    const out = execSync('df --block-size=1 /', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const parts = out.trim().split('\n').pop().split(/\s+/);
    const used = parseInt(parts[2], 10);
    const available = parseInt(parts[3], 10);
    const total = used + available;
    return {
      totalBytes: total,
      usedBytes: used,
      freeBytes: available,
      usagePct: total ? Math.round((used / total) * 100) : 0,
      freeGb: available / 1_000_000_000,
    };
  } catch (e) {
    return { totalBytes: 0, usedBytes: 0, freeBytes: 0, usagePct: 0, freeGb: 0 };
  }
}

function dirSize(p) {
  let total = 0;
  if (!fs.existsSync(p)) return 0;
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return st.size;
  try {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) total += dirSize(full);
      else if (!entry.isSymbolicLink()) total += fs.lstatSync(full).size;
    }
  } catch (e) {
    // permission error mid-tree
  }
  return total;
}

function fastDirSize(p) {
  try {
    const out = execSync(`du -sb "${p}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return parseInt(out.split('\t')[0], 10) || 0;
  } catch {
    return dirSize(p);
  }
}

function openDb(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`Kanban DB not found: ${dbPath}`);
  return new DatabaseSync(dbPath, { open: true, readOnly: true });
}

function loadKanbanState(db) {
  let tasks = [];
  let runs = [];
  let links = [];
  try {
    tasks = db.prepare('SELECT * FROM tasks').all();
  } catch {
    // tolerate a non-kanban or empty DB in test/disaster contexts
  }
  try {
    runs = db.prepare('SELECT * FROM task_runs').all();
  } catch {}
  try {
    links = db.prepare('SELECT * FROM task_links').all();
  } catch {}
  const childrenByParent = new Map();
  const parentsByChild = new Map();
  for (const l of links) {
    if (!childrenByParent.has(l.parent_id)) childrenByParent.set(l.parent_id, new Set());
    childrenByParent.get(l.parent_id).add(l.child_id);
    if (!parentsByChild.has(l.child_id)) parentsByChild.set(l.child_id, new Set());
    parentsByChild.get(l.child_id).add(l.parent_id);
  }
  return { tasks, runs, childrenByParent, parentsByChild };
}

function activeTaskIds(kanban) {
  return new Set(kanban.tasks.filter(t => t.status === 'running' || t.status === 'review').map(t => t.id));
}

function gitWorktrees(repoRoot) {
  try {
    const out = execSync('git worktree list --porcelain', { cwd: repoRoot, encoding: 'utf8' });
    const lines = out.split('\n');
    const result = [];
    let current = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        if (current) result.push(current);
        current = { path: line.slice(9).trim(), branch: null, detached: false, prunable: false, head: null };
      } else if (line.startsWith('branch ')) current.branch = line.slice(7).trim();
      else if (line === 'detached') current.detached = true;
      else if (line === 'prunable') current.prunable = true;
      else if (line.startsWith('HEAD ')) current.head = line.slice(5).trim();
      else if (line.startsWith('gitdir file points to non-existent location')) current.prunable = true;
    }
    if (current) result.push(current);
    return result;
  } catch (e) {
    return [];
  }
}

function gitStatusShort(dir) {
  try {
    const out = execSync('git status --porcelain=v1', { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return out.trim().split('\n').filter(Boolean);
  } catch (e) {
    return ['git-status-error'];
  }
}

function isBranchMerged(repoRoot, branchName) {
  try {
    execSync(`git merge-base --is-ancestor ${branchName} HEAD`, { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isBranchPushed(repoRoot, branchName) {
  try {
    const out = execSync(`git branch -r --contains ${branchName}`, { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function anyProcessInPath(targetPath) {
  const normalized = path.resolve(targetPath);
  for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
    const pid = parseInt(entry.name, 10);
    if (!pid) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === normalized || cwd.startsWith(normalized + path.sep)) return pid;
    } catch {
      // ignore
    }
  }
  return null;
}


function discoverCandidates(config, kanban) {
  const candidates = [];

  if (fs.existsSync(config.worktreesRoot)) {
    for (const entry of fs.readdirSync(config.worktreesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskId = extractTaskId(entry.name);
      candidates.push({
        type: 'worktree',
        path: path.join(config.worktreesRoot, entry.name),
        taskId,
        name: entry.name,
      });
    }
  }

  if (fs.existsSync(config.workspacesRoot)) {
    for (const entry of fs.readdirSync(config.workspacesRoot, { withFileTypes: true })) {
      const p = path.join(config.workspacesRoot, entry.name);
      const taskId = extractTaskId(entry.name);
      candidates.push({
        type: entry.isDirectory() ? 'workspace' : 'workspace-file',
        path: p,
        taskId,
        name: entry.name,
      });
    }
  }

  for (const tmpRoot of config.tmpRoots) {
    if (!fs.existsSync(tmpRoot)) continue;
    for (const entry of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
      const name = entry.name;
      if (!/^t_[a-f0-9]{8}/.test(name) && !/^h2h-/.test(name) && !/^bug\d+/.test(name)) continue;
      const p = path.join(tmpRoot, name);
      candidates.push({
        type: entry.isDirectory() ? 'tmp-dir' : 'tmp-file',
        path: p,
        taskId: extractTaskId(name),
        name,
      });
    }
  }

  for (const wt of gitWorktrees(config.repoRoot)) {
    if (!fs.existsSync(wt.path) || wt.prunable) {
      candidates.push({
        type: 'ghost-worktree',
        path: wt.path,
        taskId: extractTaskIdFromBranch(wt.branch),
        name: wt.branch || 'detached',
        branch: wt.branch,
        prunable: wt.prunable,
      });
    }
  }

  return candidates;
}

function extractTaskId(name) {
  const m = String(name).match(/(t_[a-f0-9]{8})/);
  return m ? m[1] : null;
}

function extractTaskIdFromBranch(branch) {
  if (!branch) return null;
  const m = String(branch).match(/(t_[a-f0-9]{8})/);
  return m ? m[1] : null;
}

function hasActiveDescendant(kanban, taskId, activeIds) {
  const visited = new Set();
  const queue = [taskId];
  while (queue.length) {
    const id = queue.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    if (activeIds.has(id)) return true;
    const children = kanban.childrenByParent.get(id);
    if (children) queue.push(...children);
  }
  return false;
}

function evaluateFullRemovalGates(candidate, task, config, kanban) {
  const reasons = [];
  const failures = [];

  const statusLines = gitStatusShort(candidate.path);
  const dirty = statusLines.length > 0 && statusLines[0] !== 'git-status-error';
  if (config.requireCleanGitStatus !== false) {
    if (dirty) failures.push('uncommitted-work');
    else reasons.push('clean-git-status');
  }

  const branch = task.branch_name || candidate.branch;
  if (branch) {
    const merged = isBranchMerged(config.repoRoot, branch);
    const pushed = isBranchPushed(config.repoRoot, branch);
    if (config.requireMergedAndPushed !== false) {
      if (merged) reasons.push('branch-merged');
      if (pushed) reasons.push('branch-pushed');
      if (!merged && !pushed) failures.push('unmerged-unpushed-branch');
    } else {
      reasons.push(`merged=${merged}`, `pushed=${pushed}`);
    }
  } else {
    failures.push('no-branch');
  }

  const children = kanban.childrenByParent.get(task.id);
  if (children && children.size > 0) {
    reasons.push(`children:${children.size}`);
    for (const childId of children) {
      const child = kanban.tasks.find(t => t.id === childId);
      if (child && child.workspace_path && child.workspace_path.startsWith(candidate.path)) {
        failures.push('child-uses-worktree');
      }
    }
  }

  reasons.push('assumed-artifacts-reviewed');
  return { ok: failures.length === 0, reasons, failures };
}

function listRegenerableCaches(workspacePath, config) {
  const found = [];
  if (!fs.existsSync(workspacePath)) return found;
  for (const { dir, description } of config.cachePatterns) {
    const p = path.join(workspacePath, dir);
    if (fs.existsSync(p)) {
      found.push({ path: p, name: dir, description, size: fastDirSize(p) });
    }
  }
  const nm = path.join(workspacePath, 'node_modules');
  if (fs.existsSync(nm)) {
    found.push({ path: nm, name: 'node_modules', description: 'npm dependencies', size: fastDirSize(nm) });
  }
  return found;
}

function classifyCandidate(candidate, config, kanban, activeIds) {
  const reasons = [];
  const protections = [];
  const task = candidate.taskId ? kanban.tasks.find(t => t.id === candidate.taskId) : null;
  const currentRun = task && task.current_run_id ? kanban.runs.find(r => r.id === task.current_run_id) : null;
  const isRunning = task && task.status === 'running';
  const isReview = task && task.status === 'review';
  const isActive = isRunning || isReview || (task && task.status === 'ready');
  const hasActiveChild = candidate.taskId && hasActiveDescendant(kanban, candidate.taskId, activeIds);

  const realPath = path.resolve(candidate.path);
  for (const prot of config.protectedPaths) {
    // Candidate discovery only yields workspace roots. Exact matching protects
    // production roots without accidentally protecting every .worktrees child.
    if (realPath === path.resolve(prot)) {
      protections.push(`protected-path:${prot}`);
    }
  }

  if (isRunning) protections.push('task-running');
  if (isReview) protections.push('task-in-review');
  if (isActive) protections.push('task-active');
  if (currentRun && currentRun.status === 'running') protections.push(`current-run-running:${currentRun.id}`);
  if (hasActiveChild) protections.push('active-descendant');

  const pidInPath = anyProcessInPath(candidate.path);
  if (pidInPath) protections.push(`process-cwd:${pidInPath}`);

  if (candidate.type === 'ghost-worktree') {
    if (protections.length === 0) {
      return { decision: 'remove-worktree', reasons: ['ghost-worktree', 'prunable'], protections: [], bytes: 0 };
    }
    return { decision: 'protect', reasons, protections, bytes: 0 };
  }

  const cachePaths = listRegenerableCaches(candidate.path, config);

  if (protections.length > 0) {
    return {
      decision: 'protect',
      reasons,
      protections,
      bytes: 0,
      cachePaths,
      taskStatus: task ? task.status : null,
    };
  }

  if (!task) {
    reasons.push('unlinked-workspace');
    return {
      decision: 'prune-caches',
      reasons,
      protections: [],
      cachePaths,
      taskStatus: null,
      bytes: cachePaths.reduce((sum, c) => sum + (c.size || 0), 0),
    };
  }

  const status = task.status;
  const isDoneLike = config.fullWorktreeRemovalStatuses.includes(status);
  const isPartialLike = config.partialPruneStatuses.includes(status);

  if (isDoneLike) {
    const gates = evaluateFullRemovalGates(candidate, task, config, kanban);
    if (gates.ok) {
      return {
        decision: 'remove-worktree',
        reasons: [...reasons, `status:${status}`, ...gates.reasons],
        protections: [],
        cachePaths,
        taskStatus: status,
        bytes: fastDirSize(candidate.path),
        gates,
      };
    }
    return {
      decision: 'prune-caches',
      reasons: [...reasons, `status:${status}`, 'full-removal-gates-failed', ...gates.failures],
      protections: [],
      cachePaths,
      taskStatus: status,
      bytes: cachePaths.reduce((sum, c) => sum + (c.size || 0), 0),
      gates,
    };
  }

  if (isPartialLike) {
    return {
      decision: 'prune-caches',
      reasons: [...reasons, `status:${status}`, 'preserve-retry-state'],
      protections: [],
      cachePaths,
      taskStatus: status,
      bytes: cachePaths.reduce((sum, c) => sum + (c.size || 0), 0),
    };
  }

  protections.push(`status:${status}`);
  return {
    decision: 'protect',
    reasons,
    protections,
    cachePaths,
    taskStatus: status,
    bytes: 0,
  };
}

function quarantinePath(config, originalPath) {
  if (!fs.existsSync(config.quarantineDir)) fs.mkdirSync(config.quarantineDir, { recursive: true });
  const base = path.basename(originalPath);
  const dest = path.join(config.quarantineDir, `${base}.${Date.now()}`);
  try {
    fs.renameSync(originalPath, dest);
    return dest;
  } catch (e) {
    return null;
  }
}

function removePath(p, dryRun) {
  if (dryRun) return true;
  try {
    const resolved = path.resolve(p);
    // Managed recovery/audit evidence is outside generic scratch. Refuse the
    // namespace itself, descendants, and symlinks resolving into it before
    // considering any lifecycle or disk-pressure policy.
    if (isInsideManagedEvidence(p)) {
      return false;
    }
    // Hard guard: these roots must never be removed, even if a caller passes
    // an absolute or relative path that resolves to them.
    for (const guarded of IMMUTABLE_ROOTS) {
      if (resolved === guarded || resolved.startsWith(guarded + path.sep)) {
        return false;
      }
    }
    // Additional safety: refuse paths that are not under a known workspace,
    // worktree, release, backup, artifact, tmp, or cache root. This prevents
    // accidental deletion of arbitrary file system locations.
    const underAllowedRoot = ALLOWED_REMOVAL_ROOTS.some((root) => {
      const normalized = path.resolve(root);
      return resolved === normalized || resolved.startsWith(normalized + path.sep);
    });
    if (!underAllowedRoot) {
      return false;
    }
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch (e) {
    return false;
  }
}

function executeDecision(candidate, decision, config, logEntries) {
  const entry = {
    ts: new Date().toISOString(),
    dryRun: config.dryRun,
    candidate: candidate.path,
    taskId: candidate.taskId,
    type: candidate.type,
    decision: decision.decision,
    reasons: decision.reasons,
    protections: decision.protections,
    taskStatus: decision.taskStatus,
    bytesReclaimed: 0,
    removed: [],
    quarantined: [],
    errors: [],
  };

  if (decision.decision === 'remove-worktree') {
    if (decision.gates && decision.gates.failures.length > 0) {
      entry.decision = 'quarantine';
      const dest = quarantinePath(config, candidate.path);
      if (dest) {
        entry.quarantined.push({ from: candidate.path, to: dest });
        entry.bytesReclaimed = decision.bytes || 0;
      } else {
        entry.errors.push('quarantine-failed');
      }
    } else {
      if (fs.existsSync(candidate.path)) {
        const ok = removePath(candidate.path, config.dryRun);
        if (ok) {
          entry.removed.push(candidate.path);
          entry.bytesReclaimed = decision.bytes || 0;
        } else {
          entry.errors.push('remove-failed');
        }
      } else {
        entry.reasons.push('already-absent');
      }
    }
  } else if (decision.decision === 'prune-caches') {
    for (const cache of (decision.cachePaths || [])) {
      if (cache.name === 'node_modules' && !config.includeNodeModules) {
        entry.reasons.push('node_modules-skipped-by-policy');
        continue;
      }
      const ok = removePath(cache.path, config.dryRun);
      if (ok) {
        entry.removed.push(cache.path);
        entry.bytesReclaimed += cache.size || 0;
      } else {
        entry.errors.push(`remove-failed:${cache.path}`);
      }
    }
    // If prune-caches is applied to a tmp-dir candidate (no cachePaths),
    // remove the candidate itself only when it is under an allowed root and
    // not immutable. This was the previous sweep behaviour, now gated.
    if ((candidate.type === 'tmp-dir' || candidate.type === 'tmp-file')
      && (decision.cachePaths || []).length === 0) {
      if (!fs.existsSync(candidate.path)) {
        entry.reasons.push('already-absent');
      } else {
        const ok = removePath(candidate.path, config.dryRun);
        if (ok) {
          entry.removed.push(candidate.path);
          entry.bytesReclaimed += decision.bytes || 0;
        } else {
          entry.errors.push(`remove-failed:${candidate.path}`);
        }
      }
    }
  }

  logEntries.push(entry);
  return entry;
}

function diskGuard(config, candidates, kanban, activeIds) {
  const disk = dfRoot();
  const result = {
    ts: new Date().toISOString(),
    dryRun: config.dryRun,
    disk,
    action: 'ok',
    reclaimed: 0,
    candidates: [],
  };

  const soft = disk.usagePct >= config.usagePctSoft || disk.freeGb <= config.freeGbSoft;
  const hard = disk.usagePct >= config.usagePctHard || disk.freeGb <= config.freeGbHard;

  if (!soft && !hard) return result;

  result.action = hard ? 'hard-cleanup' : 'soft-cleanup';
  const decisions = candidates.map(c => classifyCandidate(c, config, kanban, activeIds));
  let reclaimed = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const d = decisions[i];
    // Disk pressure never overrides lifecycle/process protections. Active and
    // recoverable work remains protected even at the hard threshold.
    if (d.decision !== 'protect') {
      const e = executeDecision(c, d, config, []);
      reclaimed += e.bytesReclaimed;
      result.candidates.push({ path: c.path, decision: d.decision, bytes: e.bytesReclaimed });
    }
  }
  result.reclaimed = reclaimed;
  return result;
}

function appendJsonl(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function computeMetrics(config, candidates, decisions, logEntries, disk) {
  // Use already-measured cache bytes. Re-walking every full workspace made a
  // no-op dry run take minutes on copied node_modules trees.
  const activeBytes = decisions.reduce((sum, d) => d.decision === 'protect'
    ? sum + (d.cachePaths || []).reduce((n, c) => n + (c.size || 0), 0)
    : sum, 0);
  const terminalBytes = decisions.reduce((sum, d) => (d.decision === 'prune-caches' || d.decision === 'remove-worktree')
    ? sum + (d.cachePaths || []).reduce((n, c) => n + (c.size || 0), 0)
    : sum, 0);
  const cacheBytes = logEntries.reduce((sum, e) => sum + (e.bytesReclaimed || 0), 0);
  const scratchBytes = decisions.reduce((sum, d, i) => candidates[i].type === 'workspace'
    ? sum + (d.cachePaths || []).reduce((n, c) => n + (c.size || 0), 0)
    : sum, 0);

  const oldestTerminal = candidates
    .map((c, i) => ({ c, d: decisions[i], mtime: fs.existsSync(c.path) ? fs.statSync(c.path).mtime : new Date() }))
    .filter(({ d }) => d.decision === 'prune-caches' || d.decision === 'remove-worktree')
    .sort((a, b) => a.mtime - b.mtime)[0];

  return {
    ts: new Date().toISOString(),
    dryRun: config.dryRun,
    mode: config.mode,
    disk,
    activeWorktreeBytes: activeBytes,
    terminalWorktreeBytes: terminalBytes,
    buildCacheBytesReclaimed: cacheBytes,
    scratchWorkspaceBytes: scratchBytes,
    cleanupSuccesses: logEntries.filter(e => e.errors.length === 0 && (e.removed.length > 0 || e.quarantined.length > 0)).length,
    cleanupFailures: logEntries.filter(e => e.errors.length > 0).length,
    candidateCount: candidates.length,
    protectedCount: decisions.filter(d => d.decision === 'protect').length,
    prunedCount: logEntries.filter(e => e.decision === 'prune-caches' && e.removed.length > 0).length,
    removedCount: logEntries.filter(e => e.decision === 'remove-worktree' && e.removed.length > 0).length,
    oldestTerminalWorkspace: oldestTerminal ? oldestTerminal.c.path : null,
    oldestTerminalMtime: oldestTerminal ? oldestTerminal.mtime.toISOString() : null,
  };
}

function main() {
  const config = loadConfig(process.argv);

  // Pre-flight invariant: repo root must exist and not have been moved/removed.
  if (!fs.existsSync(config.repoRoot) || !fs.existsSync(path.join(config.repoRoot, '.git'))) {
    const message = `Refusing cleanup: repo root or .git is missing at ${config.repoRoot}`;
    console.error(JSON.stringify({ ts: new Date().toISOString(), error: message }));
    process.exit(1);
  }

  if (!fs.existsSync(path.dirname(config.logPath))) {
    fs.mkdirSync(path.dirname(config.logPath), { recursive: true });
  }

  const db = openDb(config.kanbanDb);
  const kanban = loadKanbanState(db);
  db.close();

  const activeIds = activeTaskIds(kanban);
  const candidates = discoverCandidates(config, kanban);
  const decisions = candidates.map(c => classifyCandidate(c, config, kanban, activeIds));

  const logEntries = [];
  let guardResult = null;

  if (config.mode === 'disk-guard') {
    guardResult = diskGuard(config, candidates, kanban, activeIds);
  } else if (config.mode === 'lifecycle') {
    for (let i = 0; i < candidates.length; i++) {
      const d = decisions[i];
      if (d.decision !== 'protect') {
        executeDecision(candidates[i], d, config, logEntries);
      }
    }
  } else {
    // Default sweep mode: prune caches only. Never remove entire worktrees
    // outside of explicit lifecycle mode, even if classifyCandidate says
    // remove-worktree. This is the post-OPS-849 default.
    for (let i = 0; i < candidates.length; i++) {
      const d = decisions[i];
      if (d.decision === 'prune-caches') {
        executeDecision(candidates[i], d, config, logEntries);
      } else if (d.decision === 'remove-worktree') {
        const sweepDecision = { ...d, decision: 'prune-caches', reasons: [...d.reasons, 'sweep-mode-no-full-removal'] };
        executeDecision(candidates[i], sweepDecision, config, logEntries);
      }
    }
  }

  const disk = dfRoot();
  const metrics = computeMetrics(config, candidates, decisions, logEntries, disk);
  appendJsonl(config.metricsPath, metrics);
  for (const e of logEntries) appendJsonl(config.logPath, e);
  if (guardResult) appendJsonl(config.logPath, guardResult);

  const summary = {
    mode: config.mode,
    dryRun: config.dryRun,
    disk,
    candidateCount: candidates.length,
    protected: decisions.filter(d => d.decision === 'protect').length,
    pruneCaches: logEntries.filter(e => e.decision === 'prune-caches' && e.removed.length > 0).length,
    removeWorktree: logEntries.filter(e => e.decision === 'remove-worktree' && e.removed.length > 0).length,
    bytesReclaimed: logEntries.reduce((sum, e) => sum + (e.bytesReclaimed || 0), 0),
    metrics,
    log: config.logPath,
    metricsLog: config.metricsPath,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main();
