import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  execute: vi.fn(),
  batch: vi.fn(async (_statements: Array<{ sql: string; args: unknown[] }>, _mode: string) => []),
}));

vi.mock('@libsql/client', () => ({ createClient: vi.fn(() => db) }));

import { setSettings } from './settings';

describe('settings mutation atomicity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.execute.mockResolvedValue({ rows: [] });
  });

  it('persists a multi-setting update as one write transaction after validating every value', async () => {
    await expect(setSettings({
      'bot.enabled': true,
      'bot.selectionMethod': 'hybrid',
      'bot.maxTradesPerDay': 12,
    })).resolves.toEqual({ ok: true, errors: [] });

    expect(db.batch).toHaveBeenCalledTimes(1);
    const [statements, mode] = db.batch.mock.calls[0];
    expect(mode).toBe('write');
    expect(statements).toHaveLength(3);
    expect(statements.map((statement: { args: unknown[] }) => statement.args.slice(0, 2))).toEqual([
      ['bot.enabled', 'true'],
      ['bot.selectionMethod', 'hybrid'],
      ['bot.maxTradesPerDay', '12'],
    ]);
    expect(db.execute).not.toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining('INSERT INTO settings'),
    }));
  });

  it('does not begin a transaction when any setting is invalid', async () => {
    await expect(setSettings({ 'bot.enabled': true, 'bot.maxTradesPerDay': -1 })).resolves.toMatchObject({ ok: false });
    expect(db.batch).not.toHaveBeenCalled();
  });
});
