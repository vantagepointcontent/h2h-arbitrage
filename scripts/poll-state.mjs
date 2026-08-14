import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LOCK_WAIT_MS = 10_000;
const FLOCK_BINARY = process.env.H2H_FLOCK_BINARY || '/usr/bin/flock';
const FLOCK_PROBE_TIMEOUT_MS = 2_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readState(stateFile) {
  try {
    const value = JSON.parse(await readFile(stateFile, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Scheduler state must be a JSON object: ${stateFile}`);
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function readProcessIdentity(pid) {
  try {
    if (pid !== process.pid && process.env.H2H_POLL_STATE_INSPECTION_FAILURE) {
      const injected = new Error('Injected scheduler owner inspection failure');
      injected.code = process.env.H2H_POLL_STATE_INSPECTION_FAILURE;
      throw injected;
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
    return { state: 'live', identity: { bootId: bootId.trim(), startTimeTicks } };
  } catch (error) {
    const code = error?.code;
    if (code === 'ENOENT' || code === 'ESRCH') return { state: 'stale' };
    return {
      state: 'indeterminate',
      detail: `scheduler owner inspection failed${code ? ` (${code})` : ''}`,
    };
  }
}

function sameProcessIdentity(left, right) {
  return typeof left?.bootId === 'string'
    && typeof left?.startTimeTicks === 'string'
    && left.bootId === right?.bootId
    && left.startTimeTicks === right?.startTimeTicks;
}

function validOwnerMetadata(owner) {
  return Number.isInteger(owner?.pid)
    && owner.pid > 0
    && typeof owner.ownerToken === 'string'
    && owner.ownerToken.length > 0
    && Number.isFinite(Date.parse(owner.acquiredAt))
    && typeof owner.processIdentity?.bootId === 'string'
    && typeof owner.processIdentity?.startTimeTicks === 'string';
}

async function tryKernelLock(lockFile) {
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
    throw new Error(`scheduler state flock probe failed (${result.code ?? result.signal ?? 'unknown'}): ${result.stderr.trim()}`);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function publishOwner(lockPath, owner) {
  const temporary = path.join(lockPath, `owner.${owner.ownerToken}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(owner));
    await rename(temporary, path.join(lockPath, 'owner.json'));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function renameNoReplace(source, destination) {
  const script = [
    'import ctypes, errno, os, sys',
    'libc = ctypes.CDLL(None, use_errno=True)',
    'result = libc.renameat2(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1)',
    'err = ctypes.get_errno()',
    'sys.exit(0 if result == 0 else (17 if err == errno.EEXIST else 1))',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.H2H_PYTHON_BINARY || 'python3', ['-c', script, source, destination], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve(true);
      else if (code === 17) resolve(false);
      else reject(new Error(`atomic scheduler lock publish failed (${code ?? 'unknown'}): ${stderr.trim()}`));
    });
  });
}

async function prepareInitialLock(lockPath, owner) {
  const stagingPath = `${lockPath}.staging.${process.pid}.${owner.ownerToken}`;
  await mkdir(stagingPath);
  let handle = null;
  try {
    handle = await tryKernelLock(path.join(stagingPath, 'kernel.lock'));
    if (!handle) throw new Error('Cannot acquire initial scheduler kernel lock');
    await publishOwner(stagingPath, owner);
    if (await renameNoReplace(stagingPath, lockPath)) {
      return handle;
    }
    await handle.close();
    handle = null;
    return null;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    handle = null;
    throw error;
  } finally {
    if (handle === null) await rm(stagingPath, { recursive: true, force: true });
  }
}

async function inspectLegacyOwner(lockPath) {
  try {
    const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'));
    if (!validOwnerMetadata(owner)) {
      // The pre-identity lock format contained only { pid }. A definitely dead
      // PID is safe to migrate; a live or unreadable PID remains indeterminate
      // because PID reuse cannot be ruled out without the missing identity.
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        const legacyInspection = await readProcessIdentity(owner.pid);
        return legacyInspection.state === 'stale' ? legacyInspection : { state: 'indeterminate' };
      }
      return { state: 'indeterminate' };
    }
    const inspection = await readProcessIdentity(owner.pid);
    if (inspection.state !== 'live') return inspection;
    return sameProcessIdentity(owner.processIdentity, inspection.identity)
      ? { state: 'live' }
      : { state: 'stale' };
  } catch {
    return { state: 'indeterminate' };
  }
}

async function acquireLock(lockPath, options = {}) {
  const configuredWaitMs = options.lockWaitMs ?? Number(process.env.H2H_POLL_STATE_LOCK_WAIT_MS);
  const lockWaitMs = Number.isFinite(configuredWaitMs) && configuredWaitMs > 0
    ? configuredWaitMs
    : LOCK_WAIT_MS;
  const deadline = Date.now() + lockWaitMs;
  const processInspection = await readProcessIdentity(process.pid);
  if (processInspection.state !== 'live') throw new Error('Cannot establish scheduler lock process identity');
  const processIdentity = processInspection.identity;
  while (Date.now() < deadline) {
    const ownerToken = randomUUID();
    const owner = {
      pid: process.pid,
      processIdentity,
      ownerToken,
      acquiredAt: new Date().toISOString(),
    };

    const initialHandle = await prepareInitialLock(lockPath, owner);
    if (initialHandle) return { handle: initialHandle, ownerToken };

    const kernelFile = path.join(lockPath, 'kernel.lock');
    const kernelExists = await stat(kernelFile).then(() => true).catch(error => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (!kernelExists) {
      const legacy = await inspectLegacyOwner(lockPath);
      if (legacy.state !== 'stale') {
        await sleep(10 + Math.floor(Math.random() * 20));
        continue;
      }
    }

    const handle = await tryKernelLock(kernelFile);
    if (!handle) {
      await sleep(10 + Math.floor(Math.random() * 20));
      continue;
    }
    try {
      await publishOwner(lockPath, owner);
      return { handle, ownerToken };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }
  throw new Error(`Timed out acquiring scheduler state lock: ${lockPath}`);
}

async function releaseLock(lock) {
  await lock.handle.close();
}

export async function updateSchedulerState(stateFile, mutate, options = {}) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const lockPath = `${stateFile}.lock`;
  const lock = await acquireLock(lockPath, options);
  try {
    const state = await readState(stateFile);
    await mutate(state);
    const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, stateFile);
    return state;
  } finally {
    await releaseLock(lock);
  }
}
