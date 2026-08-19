import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPaperPositionDeletion,
  auditPaperPositionDeletion,
  ensurePaperPositionDeletionSchema,
  type PaperPositionDeletionCohortRow,
} from './bot-paper-position-deletion';

const dirs: string[] = [];

async function harness(): Promise<{ client: Client; close: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'paper-position-deletion-'));
  dirs.push(dir);
  const client = createClient({ url: `file:${path.join(dir, 'test.db')}` });
  await client.batch([
    `CREATE TABLE executions (
      id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, arb_id TEXT NOT NULL, market_title TEXT NOT NULL,
      dry_run INTEGER NOT NULL, success INTEGER NOT NULL, source TEXT NOT NULL,
      kalshi_order TEXT, polymarket_order TEXT, result TEXT, steps TEXT
    )`,
    `CREATE TABLE bot_positions (
      id INTEGER PRIMARY KEY, execution_id INTEGER NOT NULL, execution_mode TEXT NOT NULL,
      market_id TEXT, market_title TEXT NOT NULL, kalshi_ticker TEXT, pm_condition_id TEXT,
      kalshi_side TEXT, pm_side TEXT, total_cost INTEGER, total_cost_microusd INTEGER,
      status TEXT, opened_at TEXT, exposure_identity_status TEXT, relationship_validity TEXT,
      legacy_exposure_revision TEXT, resolution_source TEXT, resolution_payout INTEGER,
      resolution_validation_status TEXT
    )`,
    `CREATE TABLE bot_position_settlements (
      position_id INTEGER PRIMARY KEY, position_state TEXT, gross_settlement_proceeds_cents INTEGER,
      net_settlement_proceeds_cents INTEGER, realized_pnl_cents INTEGER, realized_roi_bps INTEGER,
      cash_available_at TEXT, failure_reason TEXT, reconciled_at TEXT
    )`,
    `CREATE TABLE bot_position_settlement_legs (
      position_id INTEGER, venue TEXT, execution_mode TEXT, order_id TEXT, fill_ids_json TEXT,
      payout_entitlement_cents INTEGER, net_settlement_proceeds_cents INTEGER, credit_state TEXT,
      cash_available_at TEXT, PRIMARY KEY(position_id, venue)
    )`,
    `CREATE TABLE bot_entry_recovery_evidence (
      id INTEGER PRIMARY KEY, execution_id INTEGER NOT NULL, source_payload TEXT
    )`,
    `CREATE TABLE bot_entry_recovery_decisions (
      id INTEGER PRIMARY KEY, position_id INTEGER NOT NULL, execution_id INTEGER NOT NULL,
      evidence_id INTEGER NOT NULL
    )`,
    `CREATE TABLE bot_position_reservations (
      pair_key TEXT NOT NULL, execution_mode TEXT NOT NULL, reserved_at TEXT NOT NULL,
      exposure_at_risk INTEGER NOT NULL, PRIMARY KEY(pair_key, execution_mode)
    )`,
  ], 'write');
  return { client, close: async () => client.close() };
}

const cohort = (positionId: number, executionId: number): PaperPositionDeletionCohortRow => ({
  positionId,
  executionId,
  exposureIdentity: 'partially_proven',
});

async function seedPaper(client: Client, positionId = 10, executionId = 20): Promise<void> {
  const orderId = `dry-run-${executionId}`;
  const kalshiTicker = `KX-PAPER-${executionId}`;
  const pmConditionId = `0xpaper-${executionId}`;
  await client.batch([
    {
      sql: `INSERT INTO executions
        (id,timestamp,arb_id,market_title,dry_run,success,source,kalshi_order,polymarket_order,result,steps)
        VALUES (?,?,?,?,1,1,'bot',?,?,?,?)`,
      args: [executionId, '2026-08-10T00:00:00.000Z', `arb-${executionId}`, 'Paper market',
        JSON.stringify({ marketId: kalshiTicker }), JSON.stringify({ marketId: pmConditionId }),
        JSON.stringify({ success: true, unhedged: false, rollbackExecuted: false,
          kalshiResult: { orderId, filledContracts: 1 },
          polymarketResult: { orderId: `${orderId}-pm`, filledContracts: 1 } }),
        JSON.stringify([{ simulated: true }])],
    },
    {
      sql: `INSERT INTO bot_positions
        (id,execution_id,execution_mode,market_id,market_title,kalshi_ticker,pm_condition_id,
         kalshi_side,pm_side,total_cost,total_cost_microusd,status,opened_at,exposure_identity_status,
         relationship_validity,legacy_exposure_revision,resolution_source,resolution_payout,resolution_validation_status)
        VALUES (?,?, 'paper','pair','Paper market',?,?,'yes','no',97,970000,
          'open','2026-08-10T00:00:00.000Z','partially_proven','unresolved_relationship','rev-1',NULL,NULL,'pending')`,
      args: [positionId, executionId, kalshiTicker, pmConditionId],
    },
    { sql: `INSERT INTO bot_entry_recovery_evidence (id,execution_id,source_payload) VALUES (?,?, '{}')`, args: [executionId, executionId] },
    { sql: `INSERT INTO bot_entry_recovery_decisions (id,position_id,execution_id,evidence_id) VALUES (?,?,?,?)`, args: [executionId, positionId, executionId, executionId] },
    {
      sql: `INSERT INTO bot_position_reservations VALUES (?,'paper','2026-08-10T00:00:00.000Z',0)`,
      args: [`${kalshiTicker.toLowerCase()}\u0000${pmConditionId.toLowerCase()}`],
    },
  ], 'write');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('paper BotTrader position deletion', () => {
  it('accepts only exact-cohort paper rows with simulated order IDs and no credited settlement', async () => {
    const h = await harness();
    await seedPaper(h.client);
    await h.client.batch([
      `INSERT INTO executions VALUES (21,'2026-08-10T00:00:00.000Z','arb-live','Live','0',1,'bot',NULL,NULL,'{}','{}')`,
      `INSERT INTO bot_positions VALUES (11,21,'live','pair-live','Live','KX-LIVE','0xlive','yes','no',97,970000,'open','2026-08-10T00:00:00.000Z','partially_proven','unresolved_relationship','rev-live',NULL,NULL,'pending')`,
      `INSERT INTO executions VALUES (22,'2026-08-10T00:00:00.000Z','arb-credit','Credited',1,1,'bot',NULL,NULL,'{"kalshiResult":{"orderId":"dry-run-credit"}}','{}')`,
      `INSERT INTO bot_positions VALUES (12,22,'paper','pair-credit','Credited','KX-CREDIT','0xcredit','yes','no',97,970000,'open','2026-08-10T00:00:00.000Z','partially_proven','unresolved_relationship','rev-credit',NULL,NULL,'pending')`,
      `INSERT INTO bot_position_settlement_legs VALUES (12,'kalshi','paper','dry-run-credit','[]',100,100,'credited','2026-08-11T00:00:00.000Z')`,
    ], 'write');

    const plan = await auditPaperPositionDeletion(h.client, [cohort(10, 20), cohort(11, 21), cohort(12, 22)]);

    expect(plan.counts).toMatchObject({ requested: 3, eligible: 1, excluded: 2, alreadyDeleted: 0 });
    expect(plan.eligible[0]).toMatchObject({ positionId: 10, executionId: 20 });
    expect(plan.excluded.find((row) => row.positionId === 11)?.reasons).toContain('execution is not paper/dry-run');
    expect(plan.excluded.find((row) => row.positionId === 12)?.reasons).toContain('authoritative settlement credit or payout exists');
    await h.close();
  });

  it('deletes only BotTrader-derived rows, tombstones the retained execution, and is idempotent', async () => {
    const h = await harness();
    await seedPaper(h.client);
    await seedPaper(h.client, 30, 40);
    const plan = await auditPaperPositionDeletion(h.client, [cohort(10, 20)]);
    expect(plan.counts.eligible).toBe(1);

    await ensurePaperPositionDeletionSchema(h.client);
    const first = await applyPaperPositionDeletion(h.client, plan, {
      appliedAt: '2026-08-19T23:45:00.000Z',
      reason: 'product_owner_deleted_unavailable_paper_positions',
    });
    expect(first).toMatchObject({ positionsDeleted: 1, executionsTombstoned: 1, alreadyDeleted: 0 });
    expect((await h.client.execute('SELECT COUNT(*) AS n FROM bot_positions')).rows[0].n).toBe(1);
    expect((await h.client.execute('SELECT COUNT(*) AS n FROM executions')).rows[0].n).toBe(2);
    expect((await h.client.execute('SELECT paper_position_deleted_at FROM executions WHERE id=20')).rows[0].paper_position_deleted_at)
      .toBe('2026-08-19T23:45:00.000Z');
    expect((await h.client.execute('SELECT COUNT(*) AS n FROM bot_entry_recovery_decisions WHERE execution_id=20')).rows[0].n).toBe(0);
    expect((await h.client.execute('SELECT COUNT(*) AS n FROM bot_entry_recovery_evidence WHERE execution_id=20')).rows[0].n).toBe(0);
    expect((await h.client.execute("SELECT COUNT(*) AS n FROM bot_position_reservations WHERE execution_mode='paper'")).rows[0].n).toBe(1);

    const secondPlan = await auditPaperPositionDeletion(h.client, [cohort(10, 20)]);
    const second = await applyPaperPositionDeletion(h.client, secondPlan, {
      appliedAt: '2026-08-19T23:46:00.000Z',
      reason: 'product_owner_deleted_unavailable_paper_positions',
    });
    expect(second).toMatchObject({ positionsDeleted: 0, executionsTombstoned: 0, alreadyDeleted: 1 });
    await h.close();
  });

  it('fails closed when a position changes after audit', async () => {
    const h = await harness();
    await seedPaper(h.client);
    const plan = await auditPaperPositionDeletion(h.client, [cohort(10, 20)]);
    await ensurePaperPositionDeletionSchema(h.client);
    await h.client.execute("UPDATE bot_positions SET legacy_exposure_revision='changed-after-audit' WHERE id=10");

    await expect(applyPaperPositionDeletion(h.client, plan, {
      appliedAt: '2026-08-19T23:45:00.000Z',
      reason: 'product_owner_deleted_unavailable_paper_positions',
    })).rejects.toThrow(/changed after deletion audit/i);
    expect((await h.client.execute('SELECT COUNT(*) AS n FROM bot_positions WHERE id=10')).rows[0].n).toBe(1);
    await h.close();
  });
});
