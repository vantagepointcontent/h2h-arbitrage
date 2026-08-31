import { createClient } from '@libsql/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalSqlitePath = process.env.H2H_SQLITE_PATH;

function restoreSqlitePath() {
  if (originalSqlitePath === undefined) delete process.env.H2H_SQLITE_PATH;
  else process.env.H2H_SQLITE_PATH = originalSqlitePath;
}

afterEach(() => {
  restoreSqlitePath();
  vi.resetModules();
});

describe('bot scan decision persistence filters', () => {
  it('composes positive arb, status, since, and market filters before the limit', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-scan-decisions-'));
    const dbPath = path.join(tempDir, 'edgefinder.db');
    process.env.H2H_SQLITE_PATH = dbPath;
    vi.resetModules();

    const db = createClient({ url: `file:${dbPath}` });
    try {
      await db.execute(`CREATE TABLE scan_results (
        id INTEGER PRIMARY KEY,
        market_id TEXT NOT NULL,
        scan_status TEXT NOT NULL,
        positive_arb_count INTEGER NOT NULL,
        scanned_at TEXT NOT NULL,
        raw_result TEXT NOT NULL
      )`);

      const scans = [
        { id: 1, marketId: 'target-market', positiveArbCount: 1, scannedAt: '2026-08-30T12:00:00.000Z' },
        { id: 2, marketId: 'target-market', positiveArbCount: 2, scannedAt: '2026-08-30T13:00:00.000Z' },
        { id: 3, marketId: 'target-market', positiveArbCount: 0, scannedAt: '2026-08-30T14:00:00.000Z' },
        { id: 4, marketId: 'target-market', positiveArbCount: 1, scannedAt: '2026-08-01T10:00:00.000Z' },
        { id: 5, marketId: 'other-market', positiveArbCount: 1, scannedAt: '2026-08-30T15:00:00.000Z' },
        { id: 6, marketId: 'target-market', positiveArbCount: 1, scannedAt: '2026-08-30T16:00:00.000Z' },
      ];
      for (const scan of scans) {
        await db.execute({
          sql: `INSERT INTO scan_results
            (id, market_id, scan_status, positive_arb_count, scanned_at, raw_result)
            VALUES (?, ?, 'completed', ?, ?, '{"allArbs":[]}')`,
          args: [scan.id, scan.marketId, scan.positiveArbCount, scan.scannedAt],
        });
      }

      const { getBotScanDecisions } = await import('./bot-scan-consumer');
      await expect(getBotScanDecisions({ limit: 1 })).resolves.toEqual([]);

      const decisions = [
        { scanId: 1, state: 'criteria_rejected', updatedAt: '2026-08-30T12:00:00.000Z' },
        { scanId: 2, state: 'revalidation_rejected', updatedAt: '2026-08-30T13:00:00.000Z' },
        { scanId: 3, state: 'criteria_rejected', updatedAt: '2026-08-30T14:00:00.000Z' },
        { scanId: 4, state: 'criteria_rejected', updatedAt: '2026-08-01T10:00:00.000Z' },
        { scanId: 5, state: 'criteria_rejected', updatedAt: '2026-08-30T15:00:00.000Z' },
        { scanId: 6, state: 'placed', updatedAt: '2026-08-30T16:00:00.000Z' },
      ];
      for (const decision of decisions) {
        await db.execute({
          sql: `INSERT INTO bot_scan_decisions
            (scan_id, idempotency_key, source, state, reason_code, reason, received_at, updated_at)
            VALUES (?, ?, 'scan_api', ?, 'fixture', 'fixture', ?, ?)`,
          args: [decision.scanId, `scan:${decision.scanId}`, decision.state, decision.updatedAt, decision.updatedAt],
        });
      }

      const firstMatching = await getBotScanDecisions({
        positiveArbOnly: true,
        status: 'failed',
        since: '2026-08-30T12:00:00.000Z',
        marketId: 'target-market',
        limit: 1,
      });
      expect(firstMatching.map((decision) => decision.scanId)).toEqual([2]);

      const completeMatchingPage = await getBotScanDecisions({
        positiveArbOnly: true,
        status: 'failed',
        since: '2026-08-30T12:00:00.000Z',
        marketId: 'target-market',
        limit: 2,
      });
      expect(completeMatchingPage.map((decision) => decision.scanId)).toEqual([2, 1]);
    } finally {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
