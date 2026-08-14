import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSavedMarketsFailSafe } from '../../scripts/poll-data.mjs';

describe('poller saved-market fail-safe reader', () => {
  it('uses a populated backup for corrupt or unexpectedly empty primary data', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-data-recovery-'));
    const file = path.join(directory, 'saved-markets.json');
    const backup = [{ id: 'market-a' }];
    try {
      await writeFile(`${file}.bak`, JSON.stringify(backup));
      await writeFile(file, '{"broken":');
      expect(await readSavedMarketsFailSafe(file)).toEqual(backup);
      await writeFile(file, '[]');
      expect(await readSavedMarketsFailSafe(file)).toEqual(backup);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when both copies are unreadable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poll-data-fail-closed-'));
    const file = path.join(directory, 'saved-markets.json');
    try {
      await writeFile(file, '{');
      await writeFile(`${file}.bak`, '{');
      await expect(readSavedMarketsFailSafe(file)).rejects.toThrow('primary and backup are unreadable');
      expect(await readFile(file, 'utf8')).toBe('{');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
