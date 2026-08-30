import { describe, expect, it, vi } from 'vitest';
import { generateLogUuid, insertWithUniqueLogUuid, LOG_UUID_PATTERN } from './log-uuid';

describe('Logs UUID allocation', () => {
  it('generates exactly six uppercase alphanumeric characters with a letter and digit', () => {
    for (let index = 0; index < 1_000; index += 1) {
      expect(generateLogUuid()).toMatch(LOG_UUID_PATTERN);
    }
  });

  it('retries a database uniqueness collision without changing an allocated value', async () => {
    const candidates = ['A1B2C3', 'D4E5F6'];
    const insert = vi.fn(async (logUuid: string) => {
      if (logUuid === 'A1B2C3') throw new Error('UNIQUE constraint failed: scan_results.log_uuid');
      return { logUuid };
    });

    await expect(insertWithUniqueLogUuid(insert, () => candidates.shift()!))
      .resolves.toEqual({ logUuid: 'D4E5F6' });
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('does not retry unrelated persistence failures', async () => {
    const insert = vi.fn(async () => { throw new Error('database is locked'); });
    await expect(insertWithUniqueLogUuid(insert, () => 'A1B2C3')).rejects.toThrow('database is locked');
    expect(insert).toHaveBeenCalledOnce();
  });
});
