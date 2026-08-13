import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tempDir = '';

afterEach(() => {
  delete process.env.H2H_SQLITE_PATH;
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('legacy saved-market schema migration', () => {
  it('adds expiry_date before startup queries reference it', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-saved-markets-'));
    const dbPath = path.join(tempDir, 'edgefinder.db');
    const db = createClient({ url: `file:${dbPath}` });
    await db.execute(`CREATE TABLE saved_markets (
      id TEXT PRIMARY KEY,
      kalshi_url TEXT NOT NULL,
      polymarket_url TEXT NOT NULL,
      event_title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`);
    await db.execute({
      sql: `INSERT INTO saved_markets
        (id, kalshi_url, polymarket_url, event_title, created_at)
        VALUES (?, ?, ?, ?, ?)`,
      args: ['legacy-market', 'https://kalshi.com/markets/legacy', 'https://polymarket.com/event/legacy', 'Legacy market', '2026-08-13T00:00:00.000Z'],
    });
    db.close();

    process.env.H2H_SQLITE_PATH = dbPath;
    vi.resetModules();
    const persistence = await import('./persistence');

    const market = await persistence.getSavedMarketById('legacy-market');
    expect(market).toMatchObject({ id: 'legacy-market', expiryDate: null });
  });
});