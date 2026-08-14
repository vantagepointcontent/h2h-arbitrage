import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

type ProcessIdentity = {
  bootId: string;
  startTimeTicks: string;
};

type LockOwner = {
  ownerPid: number;
  ownerToken: string;
  processIdentity: ProcessIdentity;
  processInstanceId: string;
  acquiredAt: string;
};

type LegacyLockOwner = {
  ownerPid: number;
  ownerToken: string;
};

type OwnerInspection =
  | { state: 'live' }
  | { state: 'stale' }
  | { state: 'indeterminate'; detail: string };

export type SavedMarketScanLock = LockOwner & {
  path: string;
};

export type SavedMarketScanLockAcquireResult =
  | { status: 'acquired'; lock: SavedMarketScanLock }
  | {
    status: 'busy';
    reason: 'owner_live' | 'owner_indeterminate';
    retryable: true;
    retryAfterMs: number;
    detail?: string;
  };

const RETRY_AFTER_MS = 5_000;
const FLOCK_PROBE_TIMEOUT_MS = 2_000;
const MARKER_PREFIX = 'owner-marker.';
const FLOCK_BINARY = process.env.H2H_FLOCK_BINARY || 'flock';
const PYTHON_BINARY = process.env.H2H_PYTHON_BINARY || 'python3';
const lockDirectory = process.env.H2H_SAVED_MARKET_SCAN_LOCK_DIRECTORY
  || path.join(process.cwd(), 'data', 'saved-market-scan-locks');
const processInstanceId = randomUUID();
const activeHandles = new Map<string, FileHandle>();

type PreparedLock = {
  handle: FileHandle;
  lock: SavedMarketScanLock;
  stagingPath: string;
};

function lockName(marketId: string): string {
  return createHash('sha256').update(marketId).digest('hex');
}

function markerName(owner: LockOwner): string {
  return `${MARKER_PREFIX}${owner.ownerPid}.${owner.processInstanceId}.${owner.ownerToken}`;
}

function markerToken(name: string): string | null {
  const match = /^owner-marker\.\d+\.[0-9a-f-]{36}\.([0-9a-f-]{36})$/i.exec(name);
  return match?.[1] ?? null;
}

async function readProcessIdentity(pid: number): Promise<OwnerInspection & { identity?: ProcessIdentity }> {
  try {
    if (pid !== process.pid && process.env.NODE_ENV === 'test') {
      const injectedCode = process.env.H2H_SAVED_MARKET_SCAN_LOCK_INSPECTION_FAILURE;
      if (injectedCode) {
        const injected = new Error(`Injected process inspection failure: ${injectedCode}`) as NodeJS.ErrnoException;
        injected.code = injectedCode;
        throw injected;
      }
    }
    const [bootId, processStat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const commandEnd = processStat.lastIndexOf(')');
    if (commandEnd < 0) return { state: 'indeterminate', detail: 'malformed /proc stat record' };
    const fieldsAfterCommand = processStat.slice(commandEnd + 2).trim().split(/\s+/);
    if (fieldsAfterCommand[0] === 'Z') return { state: 'stale' };
    const startTimeTicks = fieldsAfterCommand[19];
    if (!startTimeTicks || !bootId.trim()) {
      return { state: 'indeterminate', detail: 'incomplete /proc process identity' };
    }
    return {
      state: 'live',
      identity: { bootId: bootId.trim(), startTimeTicks },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return { state: 'stale' };
    return { state: 'indeterminate', detail: `process identity inspection failed${code ? ` (${code})` : ''}` };
  }
}

function sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.bootId === right.bootId && left.startTimeTicks === right.startTimeTicks;
}

function validOwner(owner: unknown): owner is LockOwner {
  const value = owner as Partial<LockOwner> | null;
  return Number.isInteger(value?.ownerPid)
    && Number(value?.ownerPid) > 0
    && typeof value?.ownerToken === 'string'
    && value.ownerToken.length > 0
    && typeof value?.processInstanceId === 'string'
    && value.processInstanceId.length > 0
    && typeof value?.processIdentity?.bootId === 'string'
    && typeof value?.processIdentity?.startTimeTicks === 'string'
    && Number.isFinite(Date.parse(value?.acquiredAt ?? ''));
}

function validLegacyOwner(owner: unknown): owner is LegacyLockOwner {
  const value = owner as Partial<LegacyLockOwner> | null;
  return Number.isInteger(value?.ownerPid)
    && Number(value?.ownerPid) > 0
    && typeof value?.ownerToken === 'string'
    && value.ownerToken.length > 0;
}

async function inspectOwner(lockPath: string): Promise<OwnerInspection> {
  let owner: LockOwner | LegacyLockOwner;
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'));
    if (!validOwner(parsed) && !validLegacyOwner(parsed)) {
      return { state: 'indeterminate', detail: 'lock owner metadata is malformed' };
    }
    owner = parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      state: 'indeterminate',
      detail: code === 'ENOENT' ? 'lock owner metadata is missing' : `lock owner metadata is unreadable${code ? ` (${code})` : ''}`,
    };
  }

  const processInspection = await readProcessIdentity(owner.ownerPid);
  if (processInspection.state !== 'live' || !processInspection.identity) return processInspection;
  if (!validOwner(owner)) {
    return {
      state: 'indeterminate',
      detail: 'legacy lock owner is live but has no verifiable process-instance identity',
    };
  }
  return sameProcessIdentity(owner.processIdentity, processInspection.identity)
    ? { state: 'live' }
    : { state: 'stale' };
}

async function tryKernelLock(lockFile: string): Promise<FileHandle | null> {
  const handle = await open(lockFile, 'a+');
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
      const child = spawn(FLOCK_BINARY, ['-n', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', handle.fd],
      });
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, FLOCK_PROBE_TIMEOUT_MS);
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
    throw new Error(`flock probe failed (${result.code ?? result.signal ?? 'unknown'}): ${result.stderr.trim()}`);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function kernelHandleMatchesPath(handle: FileHandle, lockFile: string): Promise<boolean> {
  try {
    const [held, current] = await Promise.all([handle.stat(), stat(lockFile)]);
    return held.dev === current.dev && held.ino === current.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function removeOwnerMarkers(lockPath: string): Promise<void> {
  const names = await readdir(lockPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  await Promise.all(names
    .filter(name => name.startsWith(MARKER_PREFIX))
    .map(name => rm(path.join(lockPath, name), { force: true })));
}

async function hasOwnerMarker(lockPath: string): Promise<boolean> {
  const names = await readdir(lockPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  return names.some(name => markerToken(name) !== null);
}

async function publishOwner(lockPath: string, owner: LockOwner): Promise<void> {
  const temporary = path.join(lockPath, `owner.${owner.ownerToken}.tmp`);
  await removeOwnerMarkers(lockPath);
  await writeFile(temporary, JSON.stringify(owner));
  await writeFile(path.join(lockPath, markerName(owner)), '');
  await rename(temporary, path.join(lockPath, 'owner.json'));
}

async function prepareLock(lockPath: string): Promise<PreparedLock> {
  const identityInspection = await readProcessIdentity(process.pid);
  if (identityInspection.state !== 'live' || !identityInspection.identity) {
    throw new Error('Cannot establish saved-market scan lock process identity');
  }
  const owner: LockOwner = {
    ownerPid: process.pid,
    ownerToken: randomUUID(),
    processIdentity: identityInspection.identity,
    processInstanceId,
    acquiredAt: new Date().toISOString(),
  };
  const stagingPath = `${lockPath}.staging.${process.pid}.${owner.ownerToken}`;
  await mkdir(stagingPath);
  let handle: FileHandle | null = null;
  try {
    handle = await tryKernelLock(path.join(stagingPath, 'kernel.lock'));
    if (!handle) throw new Error('Cannot acquire a new saved-market scan kernel lock');
    await publishOwner(stagingPath, owner);
    return { handle, lock: { path: lockPath, ...owner }, stagingPath };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function discardPreparedLock(prepared: PreparedLock): Promise<void> {
  await prepared.handle.close().catch(() => {});
  await rm(prepared.stagingPath, { recursive: true, force: true });
}

async function tryCreateLock(lockPath: string): Promise<SavedMarketScanLock | null> {
  const prepared = await prepareLock(lockPath);
  try {
    try {
      await rename(prepared.stagingPath, lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      await discardPreparedLock(prepared);
      return null;
    }
    activeHandles.set(prepared.lock.ownerToken, prepared.handle);
    return prepared.lock;
  } catch (error) {
    await discardPreparedLock(prepared);
    throw error;
  }
}

async function exchangePaths(left: string, right: string): Promise<void> {
  const script = [
    'import ctypes, os, sys',
    'libc = ctypes.CDLL(None, use_errno=True)',
    'result = libc.renameat2(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 2)',
    'err = ctypes.get_errno()',
    'sys.exit(0) if result == 0 else (_ for _ in ()).throw(OSError(err, os.strerror(err)))',
  ].join('; ');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(PYTHON_BINARY, ['-c', script, left, right], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`atomic lock-directory exchange failed (${code ?? 'unknown'}): ${stderr.trim()}`));
    });
  });
}

function busyResult(inspection: OwnerInspection): SavedMarketScanLockAcquireResult {
  return inspection.state === 'live'
    ? { status: 'busy', reason: 'owner_live', retryable: true, retryAfterMs: RETRY_AFTER_MS }
    : {
      status: 'busy',
      reason: 'owner_indeterminate',
      retryable: true,
      retryAfterMs: RETRY_AFTER_MS,
      detail: inspection.state === 'indeterminate'
        ? inspection.detail
        : 'kernel lock is held but recorded process instance is stale',
    };
}

export async function acquireSavedMarketScanLock(marketId: string): Promise<SavedMarketScanLockAcquireResult> {
  await mkdir(lockDirectory, { recursive: true });
  const lockPath = path.join(lockDirectory, lockName(marketId));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const created = await tryCreateLock(lockPath);
    if (created) return { status: 'acquired', lock: created };

    const kernelFile = path.join(lockPath, 'kernel.lock');
    const kernelFilePredatesProbe = await stat(kernelFile).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    const handle = await tryKernelLock(kernelFile);
    if (!handle) return busyResult(await inspectOwner(lockPath));

    const inspection = await inspectOwner(lockPath);
    const currentOwnerCrashIsProven = await hasOwnerMarker(lockPath);
    const releasedPredecessorDirectory = kernelFilePredatesProbe
      && inspection.state === 'indeterminate'
      && inspection.detail === 'lock owner metadata is missing';
    if (inspection.state !== 'stale' && !currentOwnerCrashIsProven && !releasedPredecessorDirectory) {
      await handle.close();
      return busyResult(inspection);
    }

    // Legacy processes do not honor kernel.lock and replace the whole lock
    // directory. Fence takeover to the exact directory generation inspected.
    if (!await kernelHandleMatchesPath(handle, kernelFile)) {
      await handle.close();
      return {
        status: 'busy',
        reason: 'owner_indeterminate',
        retryable: true,
        retryAfterMs: RETRY_AFTER_MS,
        detail: 'scan lock generation changed during ownership inspection',
      };
    }

    if (process.env.NODE_ENV === 'test') {
      const barrierDirectory = process.env.H2H_SAVED_MARKET_SCAN_LOCK_TAKEOVER_BARRIER_DIRECTORY;
      if (barrierDirectory) {
        await writeFile(path.join(barrierDirectory, 'ready'), '');
        const continueFile = path.join(barrierDirectory, 'continue');
        while (!await readFile(continueFile).then(() => true).catch(() => false)) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
    }

    const replacement = await prepareLock(lockPath);
    try {
      await exchangePaths(lockPath, replacement.stagingPath);
    } catch (error) {
      await handle.close();
      await discardPreparedLock(replacement);
      return {
        status: 'busy',
        reason: 'owner_indeterminate',
        retryable: true,
        retryAfterMs: RETRY_AFTER_MS,
        detail: error instanceof Error ? error.message : 'atomic lock-directory exchange failed',
      };
    }

    const exchangedExpectedGeneration = await kernelHandleMatchesPath(
      handle,
      path.join(replacement.stagingPath, 'kernel.lock'),
    );
    if (!exchangedExpectedGeneration) {
      await exchangePaths(lockPath, replacement.stagingPath);
      await handle.close();
      await discardPreparedLock(replacement);
      return {
        status: 'busy',
        reason: 'owner_indeterminate',
        retryable: true,
        retryAfterMs: RETRY_AFTER_MS,
        detail: 'scan lock generation changed during atomic takeover',
      };
    }

    await handle.close();
    await rm(replacement.stagingPath, { recursive: true, force: true });
    activeHandles.set(replacement.lock.ownerToken, replacement.handle);
    return { status: 'acquired', lock: replacement.lock };
  }
  return {
    status: 'busy',
    reason: 'owner_indeterminate',
    retryable: true,
    retryAfterMs: RETRY_AFTER_MS,
    detail: 'scan lock ownership changed repeatedly during acquisition',
  };
}

export async function releaseSavedMarketScanLock(lock: SavedMarketScanLock): Promise<void> {
  const handle = activeHandles.get(lock.ownerToken);
  if (!handle) return;
  activeHandles.delete(lock.ownerToken);
  let releasedPath: string | null = null;
  try {
    let currentToken: string | null = null;
    try {
      const current: unknown = JSON.parse(await readFile(path.join(lock.path, 'owner.json'), 'utf8'));
      if (validOwner(current)) currentToken = current.ownerToken;
    } catch {}
    if (!currentToken) {
      const names = await readdir(lock.path).catch(() => []);
      const tokens = names.map(markerToken).filter((token): token is string => token !== null);
      if (tokens.length === 1) currentToken = tokens[0];
    }
    if (currentToken === lock.ownerToken) {
      releasedPath = `${lock.path}.released.${process.pid}.${randomUUID()}`;
      try {
        await rename(lock.path, releasedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        releasedPath = null;
      }
    }
  } finally {
    await handle.close();
    if (releasedPath) await rm(releasedPath, { recursive: true, force: true });
  }
}
