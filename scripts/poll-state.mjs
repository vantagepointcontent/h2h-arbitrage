import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LOCK_WAIT_MS = 10_000;

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

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const stagingPath = `${lockPath}.staging.${process.pid}.${randomUUID()}`;
    try {
      await mkdir(stagingPath);
      await writeFile(path.join(stagingPath, 'owner.json'), JSON.stringify({ pid: process.pid }));
      await rename(stagingPath, lockPath);
      return;
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      try {
        const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'));
        let ownerAlive = false;
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
            ownerAlive = true;
          } catch (ownerError) {
            ownerAlive = ownerError?.code === 'EPERM';
          }
        }
        if (!ownerAlive) {
          const abandoned = `${lockPath}.abandoned.${process.pid}.${randomUUID()}`;
          await rename(lockPath, abandoned);
          await rm(abandoned, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === 'ENOENT') {
          const abandoned = `${lockPath}.ownerless.${process.pid}.${randomUUID()}`;
          try {
            await rename(lockPath, abandoned);
            await rm(abandoned, { recursive: true, force: true });
          } catch (reclaimError) {
            if (reclaimError?.code !== 'ENOENT') throw reclaimError;
          }
          continue;
        }
        if (lockError instanceof SyntaxError) {
          await sleep(10);
        } else {
          throw lockError;
        }
      }
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
  throw new Error(`Timed out acquiring scheduler state lock: ${lockPath}`);
}

export async function updateSchedulerState(stateFile, mutate) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const lockPath = `${stateFile}.lock`;
  await acquireLock(lockPath);
  try {
    const state = await readState(stateFile);
    await mutate(state);
    const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, stateFile);
    return state;
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
