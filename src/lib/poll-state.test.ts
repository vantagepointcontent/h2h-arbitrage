import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const pollStateModule = pathToFileURL(path.resolve('scripts/poll-state.mjs')).href;

const updaterScript = String.raw`
  import { writeFileSync } from 'node:fs';
  const [moduleUrl, stateFile, key, mode, readyFile] = process.argv.slice(1);
  const { updateSchedulerState } = await import(moduleUrl);
  await updateSchedulerState(stateFile, async state => {
    state[key] = true;
    if (mode === 'hold') {
      writeFileSync(readyFile, 'ready');
      await new Promise(resolve => process.once('message', resolve));
    }
  });
`;

function spawnUpdater(stateFile: string, key: string, mode = 'update', readyFile = '', inspectionFailure = '', lockWaitMs = ''): ChildProcess {
  return spawn(process.execPath, ['--input-type=module', '-e', updaterScript, pollStateModule, stateFile, key, mode, readyFile], {
    env: {
      ...process.env,
      H2H_POLL_STATE_INSPECTION_FAILURE: inspectionFailure,
      H2H_POLL_STATE_LOCK_WAIT_MS: lockWaitMs,
    },
    stdio: mode === 'hold' ? ['ignore', 'ignore', 'inherit', 'ipc'] : ['ignore', 'ignore', 'inherit'],
  });
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(file);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function exitWithin(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  const exited = once(child, 'exit').then(([code]) => code as number | null);
  const result = await Promise.race([
    exited,
    new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (result === null && child.exitCode === null) child.kill('SIGKILL');
  return result;
}

describe('poller state mutex process ownership', () => {
  it('fails closed on malformed owner metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-state-malformed-'));
    const stateFile = path.join(directory, 'scheduler.json');
    const lockPath = `${stateFile}.lock`;
    try {
      await mkdir(lockPath);
      const ownerFile = path.join(lockPath, 'owner.json');
      await writeFile(ownerFile, '{"pid":');
      const stale = new Date(Date.now() - 60_000);
      await utimes(ownerFile, stale, stale);
      await utimes(lockPath, stale, stale);

      const updater = spawnUpdater(stateFile, 'recovered', 'update', '', '', '100');
      expect(await exitWithin(updater, 1_000)).toBe(1);
      await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reclaims a stale lock when its PID belongs to a different process instance', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-state-pid-reuse-'));
    const stateFile = path.join(directory, 'scheduler.json');
    const lockPath = `${stateFile}.lock`;
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        processIdentity: { bootId: 'previous-boot', startTimeTicks: '1' },
        ownerToken: 'stale-owner',
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      }));

      const updater = spawnUpdater(stateFile, 'recovered');
      expect(await exitWithin(updater, 1_000)).toBe(0);
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ recovered: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('migrates the prior pid-only lock format only when the owner is definitely dead', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-state-legacy-dead-'));
    const stateFile = path.join(directory, 'scheduler.json');
    const lockPath = `${stateFile}.lock`;
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 2_147_483_647 }));
      const updater = spawnUpdater(stateFile, 'recovered');
      expect(await exitWithin(updater, 1_000)).toBe(0);
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ recovered: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fences a genuinely live process instance until it releases the mutex', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-state-live-'));
    const stateFile = path.join(directory, 'scheduler.json');
    const readyFile = path.join(directory, 'ready');
    let owner: ChildProcess | null = null;
    let contender: ChildProcess | null = null;
    try {
      owner = spawnUpdater(stateFile, 'owner', 'hold', readyFile);
      const ownerExit = once(owner, 'exit');
      await waitForFile(readyFile);
      contender = spawnUpdater(stateFile, 'contender');
      const contenderExit = once(contender, 'exit');

      const contenderExitedEarly = await Promise.race([
        contenderExit.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 150)),
      ]);
      expect(contenderExitedEarly).toBe(false);

      owner.send?.('release');
      expect((await ownerExit)[0]).toBe(0);
      expect((await contenderExit)[0]).toBe(0);
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ owner: true, contender: true });
    } finally {
      if (owner?.exitCode === null) owner.kill('SIGKILL');
      if (contender?.exitCode === null) contender.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['EACCES', 'EPERM', 'EIO'])('fails closed when owner inspection fails with %s', async failure => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-state-indeterminate-'));
    const stateFile = path.join(directory, 'scheduler.json');
    const readyFile = path.join(directory, 'ready');
    let owner: ChildProcess | null = null;
    let contender: ChildProcess | null = null;
    try {
      owner = spawnUpdater(stateFile, 'owner', 'hold', readyFile);
      const ownerExit = once(owner, 'exit');
      await waitForFile(readyFile);
      contender = spawnUpdater(stateFile, 'contender', 'update', '', failure);
      const contenderExit = once(contender, 'exit');

      expect(await Promise.race([
        contenderExit.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 150)),
      ])).toBe(false);

      owner.send?.('release');
      expect((await ownerExit)[0]).toBe(0);
      expect((await contenderExit)[0]).toBe(0);
    } finally {
      if (owner?.exitCode === null) owner.kill('SIGKILL');
      if (contender?.exitCode === null) contender.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reclaims a mutex after its owning process is killed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-state-killed-'));
    const stateFile = path.join(directory, 'scheduler.json');
    const readyFile = path.join(directory, 'ready');
    let owner: ChildProcess | null = null;
    try {
      owner = spawnUpdater(stateFile, 'owner', 'hold', readyFile);
      await waitForFile(readyFile);
      owner.kill('SIGKILL');
      await once(owner, 'exit');

      const updater = spawnUpdater(stateFile, 'recovered');
      expect(await exitWithin(updater, 1_000)).toBe(0);
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ recovered: true });
    } finally {
      if (owner?.exitCode === null) owner.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });
});