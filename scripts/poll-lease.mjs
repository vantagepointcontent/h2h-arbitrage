import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FLOCK_BINARY = process.env.H2H_FLOCK_BINARY || '/usr/bin/flock';
const FLOCK_PROBE_TIMEOUT_MS = 2_000;
const activeHandles = new Map();

function leaseName(marketId) {
  return createHash('sha256').update(String(marketId)).digest('hex');
}

function validLegacyLease(value) {
  return typeof value?.ownerId === 'string'
    && value.ownerId.length > 0
    && Number.isFinite(Date.parse(value.acquiredAt))
    && Number.isFinite(Date.parse(value.expiresAt));
}

async function inspectLegacyLease(leasePath) {
  try {
    const parsed = JSON.parse(await readFile(path.join(leasePath, 'owner.json'), 'utf8'));
    return validLegacyLease(parsed)
      ? { state: 'valid', lease: parsed }
      : { state: 'indeterminate' };
  } catch {
    return { state: 'indeterminate' };
  }
}

async function tryKernelLease(lockFile) {
  const handle = await open(lockFile, 'a+');
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(FLOCK_BINARY, ['-n', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', handle.fd],
      });
      let stderr = '';
      const timeout = setTimeout(() => child.kill('SIGKILL'), FLOCK_PROBE_TIMEOUT_MS);
      child.stderr?.on('data', chunk => { stderr += chunk; });
      child.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal, stderr });
      });
    });
    if (result.code === 0) return handle;
    await handle.close();
    if (result.code === 1) return null;
    throw new Error(`poll lease flock probe failed (${result.code ?? result.signal ?? 'unknown'}): ${result.stderr.trim()}`);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function publishOwner(leasePath, lease) {
  const temporary = path.join(leasePath, `owner.${lease.token}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(lease));
    await rename(temporary, path.join(leasePath, 'owner.json'));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function acquireMarketLease(directory, marketId, ownerId, ttlMs, now = Date.now()) {
  await mkdir(directory, { recursive: true });
  const leasePath = path.join(directory, leaseName(marketId));
  let created = false;
  try {
    await mkdir(leasePath);
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const kernelFile = path.join(leasePath, 'kernel.lock');
  const kernelPredatesProbe = await stat(kernelFile).then(() => true).catch(error => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });

  // A directory created by a pre-kernel poller is migration state. Never
  // upgrade it in place: a paused legacy contender could still rename that
  // directory after we acquire a new kernel lock, admitting two owners. Safe
  // deployment stops the old poller, waits out its TTL, and removes legacy
  // directories with `npm run migrate:poll-leases` before starting this version.
  if (!created && !kernelPredatesProbe) {
    await inspectLegacyLease(leasePath);
    return null;
  }

  const handle = await tryKernelLease(kernelFile);
  if (!handle) return null;

  const token = randomUUID();
  const lease = {
    path: leasePath,
    ownerId,
    token,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  try {
    await publishOwner(leasePath, lease);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }

  const timer = setTimeout(() => {
    if (activeHandles.get(token)?.handle !== handle) return;
    activeHandles.delete(token);
    void handle.close().catch(() => {});
  }, Math.max(1, ttlMs));
  timer.unref?.();
  activeHandles.set(token, { handle, timer });
  return lease;
}

export async function releaseMarketLease(lease) {
  const active = activeHandles.get(lease?.token);
  if (!active) return false;
  activeHandles.delete(lease.token);
  clearTimeout(active.timer);
  await active.handle.close();
  return true;
}