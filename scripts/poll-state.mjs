import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LOCK_WAIT_MS = 10_000;
const INVALID_OWNER_GRACE_MS = 250;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readState(stateFile) {
  try {
    const value = JSON.parse(await readFile(stateFile, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function readProcessIdentity(pid) {
  try {
    const [bootId, processStat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const commandEnd = processStat.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fieldsAfterCommand = processStat.slice(commandEnd + 2).trim().split(/\s+/);
    if (fieldsAfterCommand[0] === 'Z') return null;
    const startTimeTicks = fieldsAfterCommand[19];
    if (!startTimeTicks) return null;
    return { bootId: bootId.trim(), startTimeTicks };
  } catch {
    return null;
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

async function reclaimLock(lockPath, label) {
  const abandoned = `${lockPath}.${label}.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, abandoned);
    await rm(abandoned, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function invalidOwnerIsPastGrace(lockPath) {
  try {
    const lockStat = await stat(lockPath);
    return Date.now() - lockStat.mtimeMs >= INVALID_OWNER_GRACE_MS;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const processIdentity = await readProcessIdentity(process.pid);
  if (!processIdentity) throw new Error('Cannot establish scheduler lock process identity');
  while (Date.now() < deadline) {
    const stagingPath = `${lockPath}.staging.${process.pid}.${randomUUID()}`;
    const ownerToken = randomUUID();
    try {
      await mkdir(stagingPath);
      await writeFile(path.join(stagingPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        processIdentity,
        ownerToken,
        acquiredAt: new Date().toISOString(),
      }));
      await rename(stagingPath, lockPath);
      return ownerToken;
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      try {
        const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'));
        if (!validOwnerMetadata(owner)) {
          if (await invalidOwnerIsPastGrace(lockPath)) {
            await reclaimLock(lockPath, 'malformed');
            continue;
          }
          await sleep(10);
          continue;
        }
        const ownerIdentity = Number.isInteger(owner?.pid) && owner.pid > 0
          ? await readProcessIdentity(owner.pid)
          : null;
        if (!sameProcessIdentity(owner.processIdentity, ownerIdentity)) {
          await reclaimLock(lockPath, 'abandoned');
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === 'ENOENT') {
          await reclaimLock(lockPath, 'ownerless');
          continue;
        }
        if (lockError instanceof SyntaxError) {
          if (await invalidOwnerIsPastGrace(lockPath)) {
            await reclaimLock(lockPath, 'malformed');
            continue;
          }
        } else {
          throw lockError;
        }
      }
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
  throw new Error(`Timed out acquiring scheduler state lock: ${lockPath}`);
}

async function releaseLock(lockPath, ownerToken) {
  try {
    const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'));
    if (owner?.ownerToken !== ownerToken) return;
    const releasedPath = `${lockPath}.released.${process.pid}.${randomUUID()}`;
    await rename(lockPath, releasedPath);
    await rm(releasedPath, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function updateSchedulerState(stateFile, mutate) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const lockPath = `${stateFile}.lock`;
  const ownerToken = await acquireLock(lockPath);
  try {
    const state = await readState(stateFile);
    await mutate(state);
    const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, stateFile);
    return state;
  } finally {
    await releaseLock(lockPath, ownerToken);
  }
}
