import { beforeEach, describe, expect, it } from 'vitest';
import { getSqliteContentionMetrics, withSqliteBusyRetry } from './sqlite-write-retry';

describe('withSqliteBusyRetry', () => {
  beforeEach(() => getSqliteContentionMetrics(true));

  it('retries SQLITE_BUSY with a bounded policy and records contention', async () => {
    let attempts = 0;
    const result = await withSqliteBusyRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' });
      return 'ok';
    }, { maxAttempts: 3, baseDelayMs: 0 });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(getSqliteContentionMetrics()).toMatchObject({ busyRetries: 2, exhaustedWrites: 0 });
  });

  it('does not retry non-contention errors', async () => {
    let attempts = 0;
    await expect(withSqliteBusyRetry(async () => {
      attempts += 1;
      throw new Error('bad input');
    })).rejects.toThrow('bad input');
    expect(attempts).toBe(1);
  });
});
