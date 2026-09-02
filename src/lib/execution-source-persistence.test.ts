import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executableEnvelopeFixture } from './test-fixtures/calculation-envelope';

let tempDir: string | null = null;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('canonical execution source persistence and pagination', () => {
  it('filters and counts the complete source set before applying limit and offset', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-source-'));
    vi.stubEnv('H2H_SQLITE_PATH', path.join(tempDir, 'edgefinder.db'));
    const { persistExecution, queryExecutions } = await import('./persistence');

    for (const [index, source] of (['manual', 'bot', 'manual', 'unknown'] as const).entries()) {
      await persistExecution({
        timestamp: `2026-08-20T12:00:0${index}.000Z`,
        arbId: `source-${source}-${index}`,
        marketTitle: `${source} fixture ${index}`,
        dryRun: index !== 2,
        success: false,
        estimatedProfit: 0,
        source,
      });
    }

    const firstManualPage = await queryExecutions({ source: 'manual', limit: 1, offset: 0 });
    expect(firstManualPage).toMatchObject({
      total: 2,
      nextOffset: 1,
      sourceCounts: { all: 4, manual: 2, bot: 1, unknown: 1 },
    });
    expect(firstManualPage.executions).toHaveLength(1);
    expect(firstManualPage.executions[0]).toMatchObject({ source: 'manual', dryRun: false });

    const secondManualPage = await queryExecutions({ source: 'manual', limit: 1, offset: 1 });
    expect(secondManualPage).toMatchObject({ total: 2, nextOffset: null });
    expect(secondManualPage.executions).toHaveLength(1);
    expect(secondManualPage.executions[0]).toMatchObject({ source: 'manual', dryRun: true });

    const unknownPage = await queryExecutions({ source: 'unknown', limit: 10 });
    expect(unknownPage.executions).toHaveLength(1);
    expect(unknownPage.executions[0].source).toBe('unknown');
  });

  it('applies mode/status filters and aggregates before the first 500-row page', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-view-filter-'));
    vi.stubEnv('H2H_SQLITE_PATH', path.join(tempDir, 'edgefinder.db'));
    const { persistExecution, queryExecutions } = await import('./persistence');
    const envelope = { ...executableEnvelopeFixture, scope: 'execution' as const };

    await persistExecution({
      timestamp: '2026-08-20T12:00:00.000Z', arbId: 'older-dry', marketTitle: 'Older dry-run',
      dryRun: true, success: true, estimatedProfit: 0, source: 'manual',
    });
    await persistExecution({
      timestamp: '2026-08-20T12:00:00.000Z', arbId: 'older-pending', marketTitle: 'Older pending real',
      dryRun: false, success: true, estimatedProfit: 0, source: 'manual', calculationEnvelope: envelope,
      result: { kalshiResult: { status: 'pending' }, polymarketResult: { status: 'filled' }, unhedged: true, netExposure: 12.5 },
    });
    await persistExecution({
      timestamp: '2026-08-20T12:00:00.000Z', arbId: 'older-filled', marketTitle: 'Older filled real',
      dryRun: false, success: true, estimatedProfit: 0, source: 'manual', calculationEnvelope: envelope,
      result: { kalshiResult: { status: 'filled' }, polymarketResult: { status: 'filled' } },
    });
    for (let index = 0; index < 500; index += 1) {
      await persistExecution({
        timestamp: '2026-08-20T12:00:00.000Z', arbId: `newer-filler-${index}`, marketTitle: `Newer filler ${index}`,
        dryRun: false, success: false, estimatedProfit: 0, source: 'unknown',
      });
    }

    const all = await queryExecutions({ limit: 500 });
    expect(all.executions).toHaveLength(500);
    expect(all.executions.some((row) => row.arbId.startsWith('older-'))).toBe(false);
    expect(all).toMatchObject({
      total: 503,
      nextOffset: 500,
      sourceCounts: { all: 503, manual: 3, bot: 0, unknown: 500 },
      summary: { realCount: 2, pendingCount: 1, totalNetPnlMicros: -17120, unhedgedCount: 1, unhedgedExposure: 12.5 },
    });

    const dry = await queryExecutions({ view: 'dry', limit: 500 });
    expect(dry.executions.map((row) => row.arbId)).toEqual(['older-dry']);
    expect(dry).toMatchObject({
      total: 1,
      nextOffset: null,
      sourceCounts: { all: 1, manual: 1, bot: 0, unknown: 0 },
      summary: { realCount: 0, pendingCount: 0, totalNetPnlMicros: null, unhedgedCount: 0, unhedgedExposure: 0 },
    });

    const pending = await queryExecutions({ view: 'pending', limit: 500 });
    expect(pending.executions.map((row) => row.arbId)).toEqual(['older-pending']);
    expect(pending).toMatchObject({ total: 1, summary: { realCount: 1, pendingCount: 1, unhedgedCount: 1, unhedgedExposure: 12.5 } });

    const real = await queryExecutions({ view: 'real', limit: 1 });
    expect(real.executions).toHaveLength(1);
    expect(real).toMatchObject({ total: 2, nextOffset: 1, summary: { realCount: 2, pendingCount: 1, totalNetPnlMicros: -17120 } });
  });
});
