import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import path from 'node:path';
import {
  getClosedPositions,
  getExecutionCalculationEnvelopes,
  getExecutions,
  persistClosedPosition,
  persistExecution,
} from './persistence';
import { executableEnvelopeFixture } from './test-fixtures/calculation-envelope';
import { parseCalculationEnvelope } from './calculation-envelope';

afterAll(async () => {
  const dbPath = process.env.H2H_SQLITE_PATH || path.join(process.cwd(), 'data', 'edgefinder.db');
  const client = createClient({ url: `file:${dbPath}` });
  await client.execute({
    sql: 'DELETE FROM executions WHERE arb_id IN (?, ?)',
    args: ['t_ede745a7-envelope-fixture', 'missing-source-must-not-persist'],
  });
  await client.execute({
    sql: 'DELETE FROM closed_positions WHERE pair_id IN (?, ?, ?)',
    args: ['t_ede745a7-closed-envelope-fixture', 't_ede745a7-legacy-closed-fixture', 't_6542eec4-unavailable-close'],
  });
  client.close();
});

describe('calculation envelope persistence', () => {
  it('requires every application-written execution to declare canonical source', async () => {
    await expect(persistExecution({
      timestamp: '2099-08-14T12:00:01.000Z',
      arbId: 'missing-source-must-not-persist',
      marketTitle: 'Missing source fixture',
      dryRun: true,
      success: false,
      estimatedProfit: 0,
    })).rejects.toThrow('Execution source must be declared');
  });

  it('round-trips the immutable envelope independently of mutable execution result JSON', async () => {
    const id = await persistExecution({
      timestamp: '2099-08-14T12:00:02.000Z',
      arbId: 't_ede745a7-envelope-fixture',
      marketTitle: 'Calculation envelope fixture',
      dryRun: false,
      success: true,
      result: { mutableStatus: 'submitted' },
      estimatedProfit: -0.00856,
      source: 'manual',
      calculationEnvelope: { ...executableEnvelopeFixture, scope: 'execution' },
    });

    const stored = (await getExecutions(100)).find((record) => record.id === id);
    const joined = await getExecutionCalculationEnvelopes([id]);
    expect(stored?.calculationEnvelope).toMatchObject({
      version: 1,
      scope: 'execution',
      status: 'executable',
      totals: { totalFeesMicros: 28_560, netPnlMicros: -8_560 },
    });
    expect(joined.get(id)).toEqual(stored?.calculationEnvelope);
  });

  it('round-trips position envelopes and marks missing historical authority explicitly', async () => {
    await persistClosedPosition({
      marketTitle: 'Calculation envelope closed fixture',
      platform: 'polymarket',
      side: 'NO',
      size: 1,
      entryPrice: 0.31,
      exitPrice: 0.35,
      realizedPnl: 0.04,
      roiPct: 12.9,
      openedAt: '2099-08-14T12:00:00.000Z',
      closedAt: '2099-08-14T12:10:00.000Z',
      pairId: 't_ede745a7-closed-envelope-fixture',
      calculationEnvelope: { ...executableEnvelopeFixture, scope: 'position' },
    });
    await persistClosedPosition({
      marketTitle: 'Legacy closed fixture',
      platform: 'kalshi',
      side: 'YES',
      size: 1,
      entryPrice: 0.5,
      exitPrice: 0.5,
      realizedPnl: 0,
      roiPct: 0,
      openedAt: '2099-08-14T12:00:00.000Z',
      closedAt: '2099-08-14T12:11:00.000Z',
      pairId: 't_ede745a7-legacy-closed-fixture',
    });

    const rows = await getClosedPositions(100);
    expect(rows.find((row) => row.pairId === 't_ede745a7-closed-envelope-fixture')?.calculationEnvelope)
      .toMatchObject({ scope: 'position', status: 'executable' });
    expect(rows.find((row) => row.pairId === 't_ede745a7-legacy-closed-fixture')?.calculationEnvelope)
      .toMatchObject({
        scope: 'position',
        status: 'legacy_unverifiable',
        totals: { totalFeesMicros: null, netPnlMicros: null },
      });
  });

  it('round-trips unknown close financials as null instead of authoritative zero', async () => {
    const unavailable = {
      ...parseCalculationEnvelope(
      { status: 'executable', totals: { netPnlMicros: 0 } },
      'missing exit evidence',
      ),
      scope: 'position' as const,
    };
    await persistClosedPosition({
      marketTitle: 'Unavailable close',
      platform: 'polymarket',
      side: 'NO',
      size: null,
      entryPrice: 0.31,
      exitPrice: null,
      realizedPnl: null,
      roiPct: null,
      feesPaid: null,
      closedAt: '2099-08-14T12:12:00.000Z',
      pairId: 't_6542eec4-unavailable-close',
      calculationEnvelope: unavailable,
    });

    const stored = (await getClosedPositions(100)).find((row) => row.pairId === 't_6542eec4-unavailable-close');
    expect(stored).toMatchObject({
      size: null,
      exitPrice: null,
      realizedPnl: null,
      roiPct: null,
      feesPaid: null,
      calculationEnvelope: { scope: 'position', status: 'unavailable' },
    });
  });
});
