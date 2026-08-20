import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotEntryEvidenceV1 } from './bot-entry-recovery';

let tempDir: string | null = null;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('execution bot entry evidence persistence', () => {
  it('round-trips the immutable evidence envelope on every future bot execution', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-evidence-persistence-'));
    vi.stubEnv('H2H_SQLITE_PATH', path.join(tempDir, 'edgefinder.db'));
    const { getExecutions, persistExecution } = await import('./persistence');
    const evidence: BotEntryEvidenceV1 = {
      schemaVersion: 1,
      capturedAt: '2026-08-14T10:00:00.000Z',
      economicActionId: 'bot:pair:outcome',
      mode: 'paper',
      legs: {
        kalshi: {
          venue: 'kalshi', marketId: 'K-TICKER', orderId: 'k-order', quantityMicrounits: 1_000_000,
          fills: [{ fillId: 'k-order:quote:0', fillAuthority: 'execution_quote', observedAt: '2026-08-14T09:59:58.000Z', priceMicrocents: 40_000_000, sizeMicrounits: 1_000_000 }],
          grossMicrocents: 40_000_000,
          fee: { amountCents: 1, authority: 'execution_estimate', source: 'series', version: 'v1', observedAt: '2026-08-14T09:59:59.000Z', platformRounding: 'ceil_cent' },
        },
        polymarket: {
          venue: 'polymarket', marketId: 'pm-token', orderId: 'p-order', quantityMicrounits: 1_000_000,
          fills: [{ fillId: 'p-order:quote:0', fillAuthority: 'execution_quote', observedAt: '2026-08-14T09:59:58.000Z', priceMicrocents: 55_000_000, sizeMicrounits: 1_000_000 }],
          grossMicrocents: 55_000_000,
          fee: { amountCents: 1, authority: 'execution_estimate', source: 'fee-rate', version: 'v1', observedAt: '2026-08-14T09:59:59.000Z', platformRounding: 'nearest_cent' },
        },
      },
    };

    await persistExecution({
      timestamp: '2026-08-14T10:00:00.000Z', arbId: evidence.economicActionId,
      marketTitle: 'Market', dryRun: true, success: true, estimatedProfit: 3,
      source: 'bot', selectionMethod: 'roi',
      sourceScanId: 91,
      sourceOpportunityId: 'scan:91:opportunity:0',
      kalshiOrder: JSON.stringify({ ticker: 'K-TICKER' }),
      polymarketOrder: JSON.stringify({ conditionId: 'pm-token' }),
      result: JSON.stringify({
        kalshiResult: { orderId: 'k-order', filledContracts: 1 },
        polymarketResult: { orderId: 'p-order', filledContracts: 1 },
      }),
      botEntryEvidence: evidence,
    });

    const [record] = await getExecutions(1, 'bot');
    expect(record.botEntryEvidence).toEqual(evidence);
    expect(record).toMatchObject({
      sourceScanId: 91,
      sourceOpportunityId: 'scan:91:opportunity:0',
    });

    await expect(persistExecution({
      timestamp: '2026-08-14T10:01:00.000Z', arbId: 'bot:missing:evidence',
      marketTitle: 'Unsafe market', dryRun: false, success: true, estimatedProfit: 1,
      source: 'bot', selectionMethod: 'roi',
    })).rejects.toThrow('Successful bot execution lacks durable entry evidence');

    await expect(persistExecution({
      timestamp: '2026-08-14T10:01:30.000Z', arbId: evidence.economicActionId,
      marketTitle: 'Unbound market', dryRun: true, success: true, estimatedProfit: 1,
      source: 'bot', selectionMethod: 'roi', botEntryEvidence: evidence,
    })).rejects.toThrow('market ID conflicts with persisted execution request');

    const unequal = structuredClone(evidence);
    unequal.legs.polymarket.quantityMicrounits = 2_000_000;
    unequal.legs.polymarket.fills[0].sizeMicrounits = 2_000_000;
    unequal.legs.polymarket.grossMicrocents = 110_000_000;
    await expect(persistExecution({
      timestamp: '2026-08-14T10:02:00.000Z', arbId: unequal.economicActionId,
      marketTitle: 'Unsafe unequal market', dryRun: true, success: true, estimatedProfit: 1,
      source: 'bot', selectionMethod: 'roi',
      kalshiOrder: JSON.stringify({ ticker: 'K-TICKER' }),
      polymarketOrder: JSON.stringify({ conditionId: 'pm-token' }),
      result: JSON.stringify({
        kalshiResult: { orderId: 'k-order', filledContracts: 1 },
        polymarketResult: { orderId: 'p-order', filledContracts: 2 },
      }),
      botEntryEvidence: unequal,
    })).rejects.toThrow('entry evidence leg quantities conflict');
  });
});
