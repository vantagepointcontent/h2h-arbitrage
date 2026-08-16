#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  access,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RELEASE_DIR = '.h2h-releases';
const MANIFEST = 'release-manifest.json';
const REQUIRED_FILES = [
  'BUILD_ID',
  'DEPLOY_COMMIT',
  'build-manifest.json',
  'routes-manifest.json',
  'prerender-manifest.json',
  'required-server-files.json',
];
const MUTABLE_BUILD_PATHS = ['cache/', 'diagnostics/'];
const DEFAULT_KEEP_RELEASES = 4;
const DEFAULT_CANDIDATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function releaseRoot(repoRoot) {
  return path.join(repoRoot, RELEASE_DIR);
}

function sanitize(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`${label} contains unsafe characters`);
  return value;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, file);
}

async function atomicSymlink(root, name, target) {
  const link = path.join(root, name);
  const temporary = path.join(root, `.${name}.${process.pid}.${Date.now()}.tmp`);
  await rm(temporary, { force: true, recursive: true });
  await symlink(path.relative(root, target), temporary);
  await rename(temporary, link);
}

async function walkFiles(root, relative = '') {
  const result = [];
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const next = path.posix.join(relative.replaceAll(path.sep, '/'), entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(root, next));
    else if (entry.isFile()) result.push(next);
  }
  return result.sort();
}

async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function isIntegrityFile(relative) {
  return !MUTABLE_BUILD_PATHS.some((prefix) => relative.startsWith(prefix))
    && relative !== 'trace'
    && relative !== 'trace-build';
}

async function inventoryArtifact(artifactDir) {
  for (const required of REQUIRED_FILES) {
    if (!await exists(path.join(artifactDir, required))) throw new Error(`Missing required build file: ${required}`);
  }
  const files = (await walkFiles(artifactDir)).filter(isIntegrityFile);
  const staticChunks = files.filter((file) => file.startsWith('static/chunks/'));
  const serverChunks = files.filter((file) => file.startsWith('server/chunks/'));
  if (staticChunks.length === 0) throw new Error('Missing static chunks');
  if (serverChunks.length === 0) throw new Error('Missing server chunks');
  const hashes = {};
  for (const relative of files) hashes[relative] = await hashFile(path.join(artifactDir, relative));
  const digest = createHash('sha256');
  for (const relative of Object.keys(hashes).sort()) digest.update(`${relative}\0${hashes[relative]}\n`);
  return { files: hashes, integritySha256: digest.digest('hex') };
}

async function processIdentity(pid = process.pid) {
  let startTicks = null;
  try {
    const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).trim().split(' ');
    startTicks = fields[21] ?? null;
  } catch {
    // Non-Linux test environments retain the PID plus wall-clock identity.
  }
  return { pid, startTicks };
}

async function isSameProcess(identity) {
  if (!identity?.pid) return false;
  try {
    process.kill(identity.pid, 0);
    if (identity.startTicks == null) return true;
    return (await processIdentity(identity.pid)).startTicks === identity.startTicks;
  } catch {
    return false;
  }
}

async function initialize(repoRoot) {
  const root = releaseRoot(repoRoot);
  await Promise.all([
    mkdir(path.join(root, 'candidates'), { recursive: true }),
    mkdir(path.join(root, 'releases'), { recursive: true }),
    mkdir(path.join(root, 'locks'), { recursive: true }),
    mkdir(path.join(root, 'events'), { recursive: true }),
  ]);
  return root;
}

async function withPromotionLock(repoRoot, operation, fn) {
  const root = await initialize(repoRoot);
  const lock = path.join(root, 'locks', 'promotion');
  const identity = await processIdentity();
  const payload = { operation, ...identity, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await open(lock, 'wx');
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`);
      try {
        return await fn(payload);
      } finally {
        await handle.close();
        await rm(lock, { force: true });
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(await readFile(lock, 'utf8')); } catch {}
      if (owner && await isSameProcess(owner)) {
        throw new Error(`Promotion lock held by live PID ${owner.pid} (${owner.operation})`);
      }
      // A just-created lock may not have its JSON payload flushed yet. Treat it
      // as live for a grace period instead of deleting another promoter's lock.
      if (!owner && Date.now() - (await stat(lock)).mtimeMs < 5_000) {
        throw new Error('Promotion lock is being initialized by another process');
      }
      await rm(lock, { force: true });
    }
  }
  throw new Error('Unable to acquire promotion lock');
}

async function appendEvent(repoRoot, event) {
  const root = await initialize(repoRoot);
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
  const file = path.join(root, 'events', 'release-events.jsonl');
  const handle = await open(file, 'a');
  try { await handle.write(line); } finally { await handle.close(); }
}

export async function sealCandidate({ repoRoot, artifactDir, commit, runId, startedAt, builder, checks }) {
  sanitize(commit, 'commit');
  sanitize(runId, 'run ID');
  const root = await initialize(repoRoot);
  const deployCommit = (await readFile(path.join(artifactDir, 'DEPLOY_COMMIT'), 'utf8')).trim();
  if (deployCommit !== commit) throw new Error(`Artifact commit ${deployCommit} does not match requested commit ${commit}`);
  const buildId = (await readFile(path.join(artifactDir, 'BUILD_ID'), 'utf8')).trim();
  if (!buildId) throw new Error('BUILD_ID is empty');
  if (!await exists(path.join(artifactDir, 'static', buildId))) {
    throw new Error(`Missing BUILD_ID asset directory static/${buildId}`);
  }
  const inventory = await inventoryArtifact(artifactDir);
  const candidateId = `${commit}-${runId}`;
  const candidateDir = path.join(root, 'candidates', candidateId);
  await mkdir(candidateDir);
  try {
    await cp(artifactDir, path.join(candidateDir, '.next'), { recursive: true, force: false, errorOnExist: true });
    const manifest = {
      schemaVersion: 1,
      candidateId,
      runId,
      commit,
      buildId,
      startedAt: startedAt ?? new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      builder: builder ?? await processIdentity(),
      status: 'verified',
      artifactPath: '.next',
      inventory,
      checks: checks ?? { build: 'passed', tests: 'external', lint: 'external' },
    };
    await atomicWrite(path.join(candidateDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    await verifyRelease(candidateDir);
    await appendEvent(repoRoot, { type: 'candidate-verified', candidateId, commit, buildId });
    return candidateDir;
  } catch (error) {
    await rm(candidateDir, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyRelease(releaseDir) {
  const manifest = JSON.parse(await readFile(path.join(releaseDir, MANIFEST), 'utf8'));
  const artifactDir = path.join(releaseDir, manifest.artifactPath ?? '.next');
  const deployCommit = (await readFile(path.join(artifactDir, 'DEPLOY_COMMIT'), 'utf8')).trim();
  const buildId = (await readFile(path.join(artifactDir, 'BUILD_ID'), 'utf8')).trim();
  if (deployCommit !== manifest.commit) throw new Error(`Release commit drift: ${deployCommit} != ${manifest.commit}`);
  if (buildId !== manifest.buildId) throw new Error(`Release BUILD_ID drift: ${buildId} != ${manifest.buildId}`);
  if (!await exists(path.join(artifactDir, 'static', buildId))) throw new Error(`Missing active BUILD_ID assets: static/${buildId}`);
  const current = await inventoryArtifact(artifactDir);
  if (current.integritySha256 !== manifest.inventory.integritySha256) {
    throw new Error(`Release integrity drift: ${current.integritySha256} != ${manifest.inventory.integritySha256}`);
  }
  return { ...manifest, releaseDir, artifactDir };
}

async function resolveLink(root, name) {
  const link = path.join(root, name);
  try {
    const target = await readlink(link);
    return path.resolve(root, target);
  } catch {
    return null;
  }
}

export async function readActiveIdentity(repoRoot) {
  const root = await initialize(repoRoot);
  const releaseDir = await resolveLink(root, 'active');
  if (!releaseDir) return null;
  const verified = await verifyRelease(releaseDir);
  return { commit: verified.commit, buildId: verified.buildId, runId: verified.runId, releaseDir };
}

export async function verifyActiveRelease(repoRoot) {
  const identity = await readActiveIdentity(repoRoot);
  if (!identity) throw new Error('No active release');
  return identity;
}

export async function monitorActiveRelease({ repoRoot, intervalMs = 60_000 }) {
  let lastAlert = null;
  while (true) {
    try {
      await verifyActiveRelease(repoRoot);
      if (lastAlert) {
        await appendEvent(repoRoot, { type: 'monitor-recovered', previousAlert: lastAlert });
        lastAlert = null;
      }
    } catch (error) {
      if (error.message !== lastAlert) {
        lastAlert = error.message;
        await appendEvent(repoRoot, { type: 'alert', source: 'release-monitor', message: error.message });
        console.error(`[release-monitor] ALERT: ${error.message}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function importLegacyArtifact(repoRoot) {
  const artifactDir = path.join(repoRoot, '.next');
  if (!await exists(path.join(artifactDir, 'BUILD_ID'))
    || !await exists(path.join(artifactDir, 'DEPLOY_COMMIT'))) return null;
  const root = await initialize(repoRoot);
  const commit = (await readFile(path.join(artifactDir, 'DEPLOY_COMMIT'), 'utf8')).trim();
  const buildId = (await readFile(path.join(artifactDir, 'BUILD_ID'), 'utf8')).trim();
  sanitize(commit, 'legacy commit');
  const inventory = await inventoryArtifact(artifactDir);
  const releaseDir = path.join(root, 'releases', `legacy-${commit}-${Date.now()}`);
  const staging = `${releaseDir}.${process.pid}.tmp`;
  try {
    await cp(artifactDir, path.join(staging, '.next'), { recursive: true, force: false, errorOnExist: true });
    const manifest = {
      schemaVersion: 1,
      candidateId: path.basename(releaseDir),
      runId: 'legacy-bootstrap',
      commit,
      buildId,
      startedAt: new Date((await stat(path.join(artifactDir, 'BUILD_ID'))).mtimeMs).toISOString(),
      verifiedAt: new Date().toISOString(),
      promotedAt: new Date().toISOString(),
      builder: await processIdentity(),
      status: 'promoted',
      artifactPath: '.next',
      inventory,
      checks: { build: 'legacy-known-good', tests: 'previous-deployment', lint: 'previous-deployment' },
    };
    await atomicWrite(path.join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(staging, releaseDir);
    await verifyRelease(releaseDir);
    await appendEvent(repoRoot, { type: 'legacy-imported', commit, buildId, releaseDir });
    return releaseDir;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function restartAndVerify(repoRoot, expected, options = {}) {
  if (options.restart === false) return;
  await execFileAsync('pm2', ['restart', 'ecosystem.config.js', '--only', 'h2h-arbitrage', '--update-env'], { cwd: repoRoot });
  const healthUrl = options.healthUrl ?? process.env.H2H_RELEASE_HEALTH_URL ?? 'http://127.0.0.1:3000/api/health';
  const deadline = Date.now() + (options.healthTimeoutMs ?? 60_000);
  let lastError = 'health check did not run';
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
      const body = await response.json();
      if (response.ok && body.status === 'ok'
        && body.deployment?.commit === expected.commit
        && body.deployment?.buildId === expected.buildId) {
        healthy = true;
        break;
      }
      lastError = `runtime identity ${body.deployment?.commit ?? 'missing'}/${body.deployment?.buildId ?? 'missing'}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!healthy) throw new Error(`PM2 restarted but release health was not accepted: ${lastError}`);
  await execFileAsync('pm2', ['start', 'ecosystem.config.js', '--only', 'h2h-release-monitor', '--update-env'], { cwd: repoRoot });
  await execFileAsync('pm2', ['save'], { cwd: repoRoot });
}

export async function promoteRelease(options) {
  const { repoRoot, candidateDir } = options;
  return withPromotionLock(repoRoot, 'promote', async () => {
    const root = await initialize(repoRoot);
    const candidate = await verifyRelease(candidateDir);
    if (candidate.status !== 'verified') throw new Error('Candidate is not verified');
    if (options.restart !== false
      && (candidate.checks?.tests !== 'passed' || candidate.checks?.lint !== 'passed')) {
      throw new Error('Candidate tests and lint must pass before production promotion');
    }
    const activeDir = await resolveLink(root, 'active');
    const previousDir = activeDir ?? await importLegacyArtifact(repoRoot);
    if (!previousDir && options.restart !== false) {
      throw new Error('Cannot promote without preserving an active or legacy rollback release');
    }
    if (activeDir) {
      const active = await verifyRelease(activeDir);
      if (Date.parse(candidate.startedAt) < Date.parse(active.promotedAt ?? active.verifiedAt)) {
        throw new Error(`Stale candidate ${candidate.candidateId} predates active release ${active.candidateId}`);
      }
    }
    const releaseDir = path.join(root, 'releases', candidate.candidateId);
    if (!await exists(releaseDir)) {
      const stagingRelease = `${releaseDir}.${process.pid}.${Date.now()}.tmp`;
      try {
        await cp(candidateDir, stagingRelease, { recursive: true, force: false, errorOnExist: true });
        await rename(stagingRelease, releaseDir);
      } catch (error) {
        await rm(stagingRelease, { recursive: true, force: true });
        throw error;
      }
    } else {
      await verifyRelease(releaseDir);
    }
    const promotedManifestPath = path.join(releaseDir, MANIFEST);
    const promoted = {
      ...candidate,
      status: 'promoted',
      promotedAt: new Date().toISOString(),
      promotedBy: await processIdentity(),
    };
    delete promoted.releaseDir;
    delete promoted.artifactDir;
    await atomicWrite(promotedManifestPath, `${JSON.stringify(promoted, null, 2)}\n`);
    await verifyRelease(releaseDir);
    if (options.beforeSwitch) await options.beforeSwitch();
    if (previousDir) await atomicSymlink(root, 'rollback', previousDir);
    await atomicSymlink(root, 'active', releaseDir);
    await appendEvent(repoRoot, { type: 'promoted', commit: promoted.commit, buildId: promoted.buildId, releaseDir });
    await restartAndVerify(repoRoot, promoted, options);
    return { ...promoted, releaseDir };
  });
}

export async function rollbackRelease(options) {
  const { repoRoot } = options;
  return withPromotionLock(repoRoot, 'rollback', async () => {
    const root = await initialize(repoRoot);
    const activeDir = await resolveLink(root, 'active');
    const rollbackDir = await resolveLink(root, 'rollback');
    if (!activeDir || !rollbackDir) throw new Error('Active and rollback releases are both required');
    const target = await verifyRelease(rollbackDir);
    await atomicSymlink(root, 'active', rollbackDir);
    await atomicSymlink(root, 'rollback', activeDir);
    await appendEvent(repoRoot, { type: 'rolled-back', commit: target.commit, buildId: target.buildId });
    await restartAndVerify(repoRoot, target, options);
    return { ...target, releaseDir: rollbackDir };
  });
}

export async function cleanupReleases({
  repoRoot,
  now = Date.now(),
  keepReleases = DEFAULT_KEEP_RELEASES,
  candidateMaxAgeMs = DEFAULT_CANDIDATE_MAX_AGE_MS,
} = {}) {
  return withPromotionLock(repoRoot, 'cleanup', async () => {
    const root = await initialize(repoRoot);
    const protectedPaths = new Set((await Promise.all([
      resolveLink(root, 'active'),
      resolveLink(root, 'rollback'),
    ])).filter(Boolean).map((item) => path.resolve(item)));
    const removed = [];
    const releaseBase = path.join(root, 'releases');
    const releases = [];
    for (const name of await readdir(releaseBase)) {
      const item = path.join(releaseBase, name);
      if (protectedPaths.has(path.resolve(item))) continue;
      try { releases.push({ item, mtimeMs: (await stat(item)).mtimeMs }); } catch {}
    }
    releases.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { item } of releases.slice(keepReleases)) {
      await rm(item, { recursive: true, force: true });
      removed.push(item);
    }
    const candidateBase = path.join(root, 'candidates');
    for (const name of await readdir(candidateBase)) {
      const item = path.join(candidateBase, name);
      try {
        const manifest = JSON.parse(await readFile(path.join(item, MANIFEST), 'utf8'));
        const age = now - Date.parse(manifest.verifiedAt ?? manifest.startedAt);
        if (age <= candidateMaxAgeMs || await isSameProcess(manifest.builder)) continue;
        await rm(item, { recursive: true, force: true });
        removed.push(item);
      } catch {
        const age = now - (await stat(item)).mtimeMs;
        if (age > candidateMaxAgeMs) {
          await rm(item, { recursive: true, force: true });
          removed.push(item);
        }
      }
    }
    await appendEvent(repoRoot, { type: 'cleanup', removed });
    return { removed, protected: [...protectedPaths] };
  });
}

function spawnCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}

async function materializeDependencies(repoRoot, source) {
  const dependencies = await realpath(path.join(repoRoot, 'node_modules'));
  const target = path.join(source, 'node_modules');
  await mkdir(target);
  try {
    await execFileAsync('cp', ['-al', `${dependencies}/.`, target]);
  } catch {
    await rm(target, { recursive: true, force: true });
    await mkdir(target);
    await execFileAsync('cp', ['-a', `${dependencies}/.`, target]);
  }
}

export async function buildCandidate({ repoRoot, commit = 'HEAD', runId, skipTests = false }) {
  const root = await initialize(repoRoot);
  const { stdout } = await execFileAsync('git', ['rev-parse', `${commit}^{commit}`], { cwd: repoRoot });
  const resolvedCommit = stdout.trim();
  const id = sanitize(runId ?? `${Date.now()}-${process.pid}`, 'run ID');
  const staging = path.join(root, 'builds', `${resolvedCommit}-${id}`);
  const source = path.join(staging, 'source');
  await mkdir(staging, { recursive: true });
  const builder = await processIdentity();
  const startedAt = new Date().toISOString();
  await atomicWrite(path.join(staging, 'builder.json'), `${JSON.stringify({ runId: id, commit: resolvedCommit, startedAt, ...builder }, null, 2)}\n`);
  try {
    await execFileAsync('git', ['worktree', 'add', '--detach', source, resolvedCommit], { cwd: repoRoot });
    await materializeDependencies(repoRoot, source);
    if (!skipTests) {
      await spawnCommand('npm', ['test'], { cwd: source, env: process.env });
      await spawnCommand('npm', ['run', 'lint'], { cwd: source, env: process.env });
    }
    const env = {
      ...process.env,
      H2H_RELEASE_BUILD: '1',
      H2H_NEXT_DIST_DIR: '.next',
      DEPLOY_COMMIT: resolvedCommit,
    };
    await spawnCommand('npm', ['run', 'build:raw'], { cwd: source, env });
    await writeFile(path.join(source, '.next', 'DEPLOY_COMMIT'), `${resolvedCommit}\n`);
    return await sealCandidate({
      repoRoot,
      artifactDir: path.join(source, '.next'),
      commit: resolvedCommit,
      runId: id,
      startedAt,
      builder,
      checks: {
        build: 'passed',
        tests: skipTests ? 'skipped' : 'passed',
        lint: skipTests ? 'skipped' : 'passed',
      },
    });
  } finally {
    await execFileAsync('git', ['worktree', 'remove', '--force', source], { cwd: repoRoot }).catch(() => {});
    await rm(staging, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === '--skip-tests') options.skipTests = true;
    else if (item === '--no-restart') options.restart = false;
    else if (item.startsWith('--')) options[item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = rest[++index];
    else throw new Error(`Unexpected argument: ${item}`);
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (options.restart === false && process.env.H2H_RELEASE_TEST_MODE !== '1') {
    throw new Error('--no-restart is restricted to H2H_RELEASE_TEST_MODE=1');
  }
  if (options.skipTests && process.env.H2H_RELEASE_TEST_MODE !== '1') {
    throw new Error('--skip-tests is restricted to H2H_RELEASE_TEST_MODE=1');
  }
  let result;
  if (command === 'build') result = await buildCandidate({ repoRoot, commit: options.commit, runId: options.runId, skipTests: options.skipTests });
  else if (command === 'promote') result = await promoteRelease({ repoRoot, candidateDir: path.resolve(options.candidate), restart: options.restart });
  else if (command === 'rollback') result = await rollbackRelease({ repoRoot, restart: options.restart });
  else if (command === 'verify-active' || command === 'status') result = await verifyActiveRelease(repoRoot);
  else if (command === 'monitor') result = await monitorActiveRelease({ repoRoot, intervalMs: Number(options.intervalMs ?? 60_000) });
  else if (command === 'cleanup') result = await cleanupReleases({ repoRoot, keepReleases: Number(options.keep ?? DEFAULT_KEEP_RELEASES) });
  else throw new Error('Usage: release-manager.mjs build|promote|rollback|verify-active|monitor|status|cleanup [options]');
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch(async (error) => {
  const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  await appendEvent(repoRoot, { type: 'alert', message: error.message }).catch(() => {});
  console.error(`[release-manager] ALERT: ${error.message}`);
  process.exitCode = 1;
});
