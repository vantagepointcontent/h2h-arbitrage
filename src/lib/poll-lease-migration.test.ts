import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pollLeaseDirectory, quarantineLegacyPollLeases } from '../../scripts/migrate-poll-leases.mjs';

describe('legacy poll-lease deployment migration', () => {
  it('targets the same production lease directory and environment key as the poller', () => {
    expect(pollLeaseDirectory({ NODE_ENV: 'test' }, '/srv/h2h')).toBe('/srv/h2h/data/saved-market-leases');
    expect(pollLeaseDirectory({ NODE_ENV: 'test', H2H_SAVED_MARKET_LEASE_DIRECTORY: '/leases' }, '/srv/h2h')).toBe('/leases');
  });

  it('requires a stopped-poller confirmation and atomically quarantines only legacy directories', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-lease-migration-'));
    const legacy = path.join(directory, 'legacy');
    const modern = path.join(directory, 'modern');
    try {
      await mkdir(legacy);
      await writeFile(path.join(legacy, 'owner.json'), '{"legacy":true}');
      await mkdir(modern);
      await writeFile(path.join(modern, 'kernel.lock'), '');

      await expect(quarantineLegacyPollLeases(directory)).rejects.toThrow('confirmed stopped');
      const result = await quarantineLegacyPollLeases(directory, { confirmedStopped: true });
      expect(result).toHaveLength(1);
      await expect(stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(result[0].quarantinePath, 'owner.json'), 'utf8')).toBe('{"legacy":true}');
      expect((await stat(path.join(modern, 'kernel.lock'))).isFile()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
