import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type AcquireResult = {
  status: 'acquired' | 'busy';
  reason?: 'owner_live' | 'owner_indeterminate';
  retryable?: boolean;
};

type Worker = {
  child: ChildProcess;
  command: (command: string) => Promise<AcquireResult | { status: 'released' }>;
};

let buildDirectory: string;
let runnerPath: string;
let legacyRunnerPath: string;

function lockName(marketId: string): string {
  return createHash('sha256').update(marketId).digest('hex');
}

function startWorker(lockDirectory: string, inspectionFailure?: string, takeoverBarrierDirectory?: string): Worker {
  const child = spawn(process.execPath, [runnerPath], {
    env: {
      ...process.env,
      H2H_SAVED_MARKET_SCAN_LOCK_DIRECTORY: lockDirectory,
      H2H_SAVED_MARKET_SCAN_LOCK_INSPECTION_FAILURE: inspectionFailure ?? '',
      H2H_SAVED_MARKET_SCAN_LOCK_TAKEOVER_BARRIER_DIRECTORY: takeoverBarrierDirectory ?? '',
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let sequence = 0;
  return {
    child,
    command(command) {
      const id = ++sequence;
      child.send?.({ id, command });
      return new Promise((resolve, reject) => {
        const onMessage = (message: { id: number; result?: AcquireResult; error?: string }) => {
          if (message.id !== id) return;
          child.off('message', onMessage);
          if (message.error) reject(new Error(message.error));
          else resolve(message.result!);
        };
        child.on('message', onMessage);
      });
    },
  };
}

function startLegacyWorker(lockDirectory: string): Worker {
  const child = spawn(process.execPath, [legacyRunnerPath], {
    env: { ...process.env, H2H_SAVED_MARKET_SCAN_LOCK_DIRECTORY: lockDirectory },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let sequence = 0;
  return {
    child,
    command(command) {
      const id = ++sequence;
      child.send?.({ id, command });
      return new Promise((resolve, reject) => {
        const onMessage = (message: { id: number; result?: AcquireResult; error?: string }) => {
          if (message.id !== id) return;
          child.off('message', onMessage);
          if (message.error) reject(new Error(message.error));
          else resolve(message.result!);
        };
        child.on('message', onMessage);
      });
    },
  };
}

async function stopWorker(worker: Worker | null): Promise<void> {
  if (!worker || worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  worker.child.kill('SIGKILL');
  await once(worker.child, 'exit');
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await readFile(file).then(() => true).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

beforeAll(async () => {
  buildDirectory = await mkdtemp(path.join(os.tmpdir(), 'saved-market-scan-lock-build-'));
  const bundlePath = path.join(buildDirectory, 'lock.cjs');
  runnerPath = path.join(buildDirectory, 'runner.cjs');
  legacyRunnerPath = path.join(buildDirectory, 'legacy-runner.cjs');
  await build({
    entryPoints: [path.resolve('src/lib/saved-market-scan-lock.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  await writeFile(runnerPath, `
    const { acquireSavedMarketScanLock, releaseSavedMarketScanLock } = require(${JSON.stringify(bundlePath)});
    let lock = null;
    process.on('message', async ({ id, command }) => {
      try {
        if (command === 'acquire') {
          const result = await acquireSavedMarketScanLock('market-1');
          if (result?.status === 'acquired') lock = result.lock;
          process.send({ id, result: JSON.parse(JSON.stringify(result)) });
        } else if (command === 'release') {
          if (lock) await releaseSavedMarketScanLock(lock);
          lock = null;
          process.send({ id, result: { status: 'released' } });
        }
      } catch (error) {
        process.send({ id, error: error?.stack || String(error) });
      }
    });
  `);
  await writeFile(legacyRunnerPath, `
    const { createHash, randomUUID } = require('node:crypto');
    const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
    const path = require('node:path');
    const lockDirectory = process.env.H2H_SAVED_MARKET_SCAN_LOCK_DIRECTORY;
    const lockName = marketId => createHash('sha256').update(marketId).digest('hex');
    const ownerIsAlive = pid => {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return true; }
      catch (error) { return error.code === 'EPERM'; }
    };
    const createLock = async lockPath => {
      const stagingPath = lockPath + '.staging.' + process.pid + '.' + randomUUID();
      const lock = { path: lockPath, ownerToken: randomUUID(), ownerPid: process.pid };
      await mkdir(stagingPath);
      try {
        await writeFile(path.join(stagingPath, 'owner.json'), JSON.stringify(lock));
        await rename(stagingPath, lockPath);
        return lock;
      } finally { await rm(stagingPath, { recursive: true, force: true }); }
    };
    const acquire = async () => {
      await mkdir(lockDirectory, { recursive: true });
      const lockPath = path.join(lockDirectory, lockName('market-1'));
      try { return await createLock(lockPath); }
      catch (error) { if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error; }
      let existing = null;
      try { existing = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')); } catch {}
      if (ownerIsAlive(existing?.ownerPid)) return null;
      const abandonedPath = lockPath + '.abandoned.' + process.pid + '.' + randomUUID();
      try { await rename(lockPath, abandonedPath); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      try { return await createLock(lockPath); }
      catch (error) {
        if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') return null;
        throw error;
      } finally { await rm(abandonedPath, { recursive: true, force: true }); }
    };
    const release = async lock => {
      try {
        const current = JSON.parse(await readFile(path.join(lock.path, 'owner.json'), 'utf8'));
        if (current.ownerToken !== lock.ownerToken) return;
        const releasedPath = lock.path + '.released.' + process.pid + '.' + randomUUID();
        await rename(lock.path, releasedPath);
        await rm(releasedPath, { recursive: true, force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    let lock = null;
    process.on('message', async ({ id, command }) => {
      try {
        if (command === 'acquire') {
          lock = await acquire();
          process.send({ id, result: lock ? { status: 'acquired' } : { status: 'busy' } });
        } else if (command === 'release') {
          if (lock) await release(lock);
          lock = null;
          process.send({ id, result: { status: 'released' } });
        }
      } catch (error) { process.send({ id, error: error?.stack || String(error) }); }
    });
  `);
});

afterAll(async () => {
  await rm(buildDirectory, { recursive: true, force: true });
});

describe('saved-market server scan lock process ownership', () => {
  it('fences a live owner from the previous directory-lock implementation during rollout', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-lock-legacy-live-'));
    const legacyOwner = startLegacyWorker(directory);
    const contender = startWorker(directory);
    try {
      expect(await legacyOwner.command('acquire')).toMatchObject({ status: 'acquired' });
      expect(await contender.command('acquire')).toMatchObject({ status: 'busy', retryable: true });
    } finally {
      await stopWorker(legacyOwner);
      await stopWorker(contender);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reclaims a killed owner from the previous directory-lock implementation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-lock-legacy-killed-'));
    const legacyOwner = startLegacyWorker(directory);
    let contender: Worker | null = null;
    try {
      expect(await legacyOwner.command('acquire')).toMatchObject({ status: 'acquired' });
      await stopWorker(legacyOwner);
      contender = startWorker(directory);
      expect(await contender.command('acquire')).toMatchObject({ status: 'acquired' });
    } finally {
      await stopWorker(legacyOwner);
      await stopWorker(contender);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not displace a legacy replacement that wins during stale-owner inspection', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-lock-legacy-generation-'));
    const lockPath = path.join(directory, lockName('market-1'));
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
      ownerPid: 2_147_483_647,
      ownerToken: 'dead-legacy-owner',
    }));
    const barrierDirectory = path.join(directory, 'takeover-barrier');
    await mkdir(barrierDirectory);
    const contender = startWorker(directory, undefined, barrierDirectory);
    const legacyReplacement = startLegacyWorker(directory);
    const thirdContender = startWorker(directory);
    try {
      const pending = contender.command('acquire');
      await waitForFile(path.join(barrierDirectory, 'ready'));
      expect(await legacyReplacement.command('acquire')).toMatchObject({ status: 'acquired' });
      await writeFile(path.join(barrierDirectory, 'continue'), '');
      expect(await pending).toMatchObject({ status: 'busy', retryable: true });
      expect(await thirdContender.command('acquire')).toMatchObject({ status: 'busy', retryable: true });
    } finally {
      await stopWorker(contender);
      await stopWorker(legacyReplacement);
      await stopWorker(thirdContender);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('allows only one concurrent server scan across separate contenders', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-lock-contenders-'));
    const contenders = Array.from({ length: 12 }, () => startWorker(directory));
    try {
      const results = await Promise.all(contenders.map(contender => contender.command('acquire')));
      expect(results.filter(result => result.status === 'acquired')).toHaveLength(1);
      expect(results.filter(result => result.status === 'busy')).toHaveLength(11);
    } finally {
      await Promise.all(contenders.map(stopWorker));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fences a genuinely live owner with readable process identity', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-lock-live-'));
    const owner = startWorker(directory);
    const contender = startWorker(directory);
    try {
      expect(await owner.command('acquire')).toMatchObject({ status: 'acquired' });
      expect(await contender.command('acquire')).toMatchObject({
        status: 'busy', reason: 'owner_live', retryable: true,
      });
    } finally {
      await stopWorker(owner);
      await stopWorker(contender);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reclaims a confirmed dead owner within a bounded interval', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-lock-dead-'));
    const owner = startWorker(directory);
    let contender: Worker | null = null;
    try {
      expect(await owner.command('acquire')).toMatchObject({ status: 'acquired' });
      await stopWorker(owner);
      contender = startWorker(directory);
      expect(await contender.command('acquire')).toMatchObject({ status: 'acquired' });
    } finally {
      await stopWorker(owner);
      await stopWorker(contender);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reclaims the same PID when process-instance identity differs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-lock-pid-reuse-'));
    const contender = startWorker(directory);
    try {
      const lockPath = path.join(directory, lockName('market-1'));
      await mkdir(lockPath, { recursive: true });
      await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
        ownerPid: contender.child.pid,
        ownerToken: 'stale-owner',
        processIdentity: { bootId: 'previous-boot', startTimeTicks: '1' },
        processInstanceId: 'previous-instance',
        witnessSocket: path.join(directory, '.owners', 'previous-instance.sock'),
        acquiredAt: new Date().toISOString(),
      }));
      expect(await contender.command('acquire')).toMatchObject({ status: 'acquired' });
    } finally {
      await stopWorker(contender);
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const failure of ['EACCES', 'EPERM', 'EIO']) {
    it(`does not reclaim a live owner when /proc inspection fails with ${failure}`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-lock-indeterminate-'));
      const owner = startWorker(directory);
      const contender = startWorker(directory, failure);
      try {
        expect(await owner.command('acquire')).toMatchObject({ status: 'acquired' });
        expect(await contender.command('acquire')).toMatchObject({ status: 'busy', retryable: true });
      } finally {
        await stopWorker(owner);
        await stopWorker(contender);
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it('recovers a killed owner despite persistent /proc inspection failure', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-lock-persistent-proc-'));
    const owner = startWorker(directory);
    const contender = startWorker(directory, 'EACCES');
    try {
      expect(await owner.command('acquire')).toMatchObject({ status: 'acquired' });
      expect(await contender.command('acquire')).toMatchObject({ status: 'busy', retryable: true });
      await stopWorker(owner);
      expect(await contender.command('acquire')).toMatchObject({ status: 'acquired' });
    } finally {
      await stopWorker(owner);
      await stopWorker(contender);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns explicit retryable indeterminate state when no ownership proof is readable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-lock-no-proof-'));
    const owner = startWorker(directory);
    const contender = startWorker(directory);
    try {
      expect(await owner.command('acquire')).toMatchObject({ status: 'acquired' });
      const lockPath = path.join(directory, lockName('market-1'));
      await writeFile(path.join(lockPath, 'owner.json'), '{"ownerPid":');
      for (const name of await readdir(lockPath)) {
        if (name.startsWith('owner-marker.')) await rm(path.join(lockPath, name));
      }
      expect(await contender.command('acquire')).toMatchObject({
        status: 'busy', reason: 'owner_indeterminate', retryable: true,
      });
    } finally {
      await stopWorker(owner);
      await stopWorker(contender);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers malformed owner metadata through the owner witness without duplicate execution', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scan-lock-malformed-'));
    const owner = startWorker(directory);
    let contender: Worker | null = startWorker(directory);
    try {
      expect(await owner.command('acquire')).toMatchObject({ status: 'acquired' });
      const ownerFile = path.join(directory, lockName('market-1'), 'owner.json');
      await writeFile(ownerFile, '{"ownerPid":');
      expect(await contender.command('acquire')).toMatchObject({ status: 'busy', retryable: true });
      expect(await owner.command('release')).toEqual({ status: 'released' });
      await stopWorker(contender);
      contender = startWorker(directory);
      expect(await contender.command('acquire')).toMatchObject({ status: 'acquired' });
    } finally {
      await stopWorker(owner);
      await stopWorker(contender);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
