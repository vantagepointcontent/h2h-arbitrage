import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

let tempDir: string | null = null;

afterEach(() => {
  vi.resetModules();
  delete process.env.H2H_SQLITE_PATH;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('scan fee persistence', () => {
  it('round-trips authoritative fee values and calculation provenance in raw_result', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-fees-'));
    const dbPath = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    const { saveScanResult } = await import('./persistence');
    const fees = {
      kalshiFee: 0.01,
      pmFee: 0.02,
      kalshiFeeDetails: 'Kalshi YES buy 1 @ $0.45 = $0.01',
      pmFeeDetails: 'Polymarket NO buy 1 @ $0.50 = $0.02',
    };

    const saved = await saveScanResult('pair-1', {
      bestRoiPct: 5,
      bestProfit: 0.05,
      strategy: 'Buy YES Kalshi + NO PM',
      arbType: 'direct',
      outcomeCount: 1,
      matchedCount: 1,
      kalshiCount: 1,
      pmCount: 1,
      positiveArbCount: 1,
      scannedAt: '2026-08-16T20:00:00.000Z',
      raw: { allArbs: [{ artist: 'A', fees }] },
    });

    const db = createClient({ url: `file:${dbPath}` });
    const result = await db.execute({ sql: 'SELECT raw_result FROM scan_results WHERE id=?', args: [saved.id] });
    db.close();
    const raw = JSON.parse(String(result.rows[0]?.raw_result));
    expect(raw.allArbs[0].fees).toEqual(fees);
  });
});
