import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tempDir = '';

afterEach(() => {
  delete process.env.H2H_SQLITE_PATH;
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Logs FTS persistence', () => {
  it('uses the FTS virtual-table index for case-insensitive contains search', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-search-'));
    process.env.H2H_SQLITE_PATH = path.join(tempDir, 'logs.db');
    vi.resetModules();
    const persistence = await import('./persistence');

    await persistence.saveScanResult('outside-page', {
      bestRoiPct: 2,
      bestProfit: 1,
      strategy: 'Buy YES Kalshi + NO PM',
      outcomeCount: 1,
      matchedCount: 1,
      kalshiCount: 1,
      pmCount: 1,
      positiveArbCount: 1,
      totalStake: 100,
      scannedAt: '2026-08-12T12:00:00.000Z',
      marketTitle: 'MN-01 House Election Winner',
    });

    const result = await persistence.queryScanHistory({ search: 'mn-01', limit: 250 });
    expect(result.rows.map((row) => row.market_id)).toEqual(['outside-page']);
    const plan = await persistence.explainScanHistorySearchPlan('MN-01');
    expect(plan.join(' ')).toMatch(/VIRTUAL TABLE INDEX/i);
    expect(plan.join(' ')).not.toMatch(/SCAN scan_results_search(?! VIRTUAL)/i);
  });
});
