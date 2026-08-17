import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotEntryRecoveryStore, type BotEntryEvidenceV1 } from './bot-entry-recovery';
import { BotPositionStore, calculatePositionValuation } from './bot-positions';

let tempDir: string | null = null;
let db: Client | null = null;

async function harness() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-entry-recovery-'));
  const dbPath = path.join(tempDir, 'edgefinder.db');
  db = createClient({ url: `file:${dbPath}` });
  await db.batch([
    `CREATE TABLE executions (
      id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, arb_id TEXT NOT NULL,
      source TEXT NOT NULL, dry_run INTEGER NOT NULL, success INTEGER NOT NULL,
      kalshi_order TEXT, polymarket_order TEXT, result TEXT, steps TEXT,
      bot_entry_evidence TEXT
    )`,
    `CREATE TABLE bot_positions (
      id INTEGER PRIMARY KEY, execution_id INTEGER NOT NULL, execution_mode TEXT NOT NULL,
      market_id TEXT, market_title TEXT NOT NULL, kalshi_ticker TEXT, pm_condition_id TEXT,
      strategy TEXT, kalshi_side TEXT NOT NULL, pm_side TEXT NOT NULL, opened_at TEXT NOT NULL,
      status TEXT NOT NULL, shares_kalshi INTEGER NOT NULL, shares_pm INTEGER NOT NULL,
      live_shares_kalshi INTEGER, live_shares_pm INTEGER,
      buy_price_kalshi INTEGER NOT NULL, buy_price_pm INTEGER NOT NULL,
      total_cost INTEGER NOT NULL, fees INTEGER NOT NULL,
      live_principal INTEGER, live_fees INTEGER, live_cost INTEGER,
      expected_payout INTEGER NOT NULL, expected_profit INTEGER NOT NULL,
      expected_roi_bps INTEGER, current_value INTEGER, unrealized_pnl INTEGER,
      unrealized_roi_pct INTEGER, entry_cost_status TEXT NOT NULL,
      entry_evidence_revision INTEGER NOT NULL DEFAULT 0,
      entry_cost_failure_reason TEXT, kalshi_entry_gross_microcents INTEGER,
      pm_entry_gross_microcents INTEGER, entry_cost_rounding_delta_microcents INTEGER,
      kalshi_entry_fill_count INTEGER, pm_entry_fill_count INTEGER,
      kalshi_entry_fills_json TEXT, pm_entry_fills_json TEXT,
      kalshi_entry_fee INTEGER NOT NULL DEFAULT 0, pm_entry_fee INTEGER NOT NULL DEFAULT 0,
      kalshi_entry_fee_type TEXT, kalshi_entry_fee_multiplier_ppm INTEGER,
      kalshi_entry_fee_source TEXT, kalshi_entry_fee_observed_at TEXT,
      kalshi_entry_fee_version TEXT, pm_entry_token_id TEXT,
      pm_entry_fee_rate_bps INTEGER, pm_entry_fee_source TEXT,
      pm_entry_fee_observed_at TEXT, pm_entry_fee_version TEXT
    )`,
  ], 'write');
  const dbUrl = `file:${dbPath}`;
  const store = new BotEntryRecoveryStore(dbUrl);
  return { store, db, dbUrl };
}

function exactEvidence(overrides: Partial<BotEntryEvidenceV1> = {}): BotEntryEvidenceV1 {
  return {
    schemaVersion: 1,
    capturedAt: '2026-08-14T10:00:00.000Z',
    economicActionId: 'bot:pair:outcome',
    mode: 'paper',
    legs: {
      kalshi: {
        venue: 'kalshi', marketId: 'K-TICKER', orderId: 'k-order-1', quantityMicrounits: 1_000_000,
        fills: [{ fillId: 'k-fill-1', fillAuthority: 'execution_quote', observedAt: '2026-08-14T09:59:58.000Z', priceMicrocents: 40_000_000, sizeMicrounits: 1_000_000 }],
        grossMicrocents: 40_000_000,
        fee: { amountCents: 1, authority: 'execution_estimate', source: 'kalshi-series-response', version: 'k-v1', observedAt: '2026-08-14T09:59:59.000Z', platformRounding: 'ceil_cent' },
      },
      polymarket: {
        venue: 'polymarket', marketId: 'pm-token-1', orderId: 'p-order-1', quantityMicrounits: 1_000_000,
        fills: [{ fillId: 'p-fill-1', fillAuthority: 'execution_quote', observedAt: '2026-08-14T09:59:58.000Z', priceMicrocents: 55_000_000, sizeMicrounits: 1_000_000 }],
        grossMicrocents: 55_000_000,
        fee: { amountCents: 1, authority: 'execution_estimate', source: 'pm-fee-response', version: 'p-v1', observedAt: '2026-08-14T09:59:59.000Z', platformRounding: 'nearest_cent' },
      },
    },
    ...overrides,
  };
}

async function seedLegacy(
  client: Client,
  evidence: BotEntryEvidenceV1 | null = exactEvidence(),
  options: { shares?: number; dryRun?: boolean; executionMode?: 'paper' | 'live'; success?: boolean; entryCostStatus?: 'available' | 'unavailable' } = {},
) {
  const shares = options.shares ?? 1;
  const dryRun = options.dryRun ?? true;
  const executionMode = options.executionMode ?? (dryRun ? 'paper' : 'live');
  const success = options.success ?? true;
  const entryCostStatus = options.entryCostStatus ?? 'unavailable';
  await client.execute({
    sql: `INSERT INTO executions
      (id,timestamp,arb_id,source,dry_run,success,kalshi_order,polymarket_order,result,steps,bot_entry_evidence)
      VALUES (11,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      '2026-08-14T10:00:00.000Z', 'bot:pair:outcome', 'bot', dryRun ? 1 : 0, success ? 1 : 0,
      JSON.stringify({ marketId: 'K-TICKER' }), JSON.stringify({ marketId: 'pm-token-1' }),
      JSON.stringify({ success, kalshiResult: { orderId: 'k-order-1' }, polymarketResult: { orderId: 'p-order-1' } }),
      JSON.stringify([]), evidence == null ? null : JSON.stringify(evidence),
    ],
  });
  await client.execute({
    sql: `INSERT INTO bot_positions
    (id,execution_id,execution_mode,market_id,market_title,kalshi_ticker,pm_condition_id,strategy,
     kalshi_side,pm_side,opened_at,status,shares_kalshi,shares_pm,live_shares_kalshi,live_shares_pm,
     buy_price_kalshi,buy_price_pm,total_cost,fees,live_principal,live_fees,live_cost,
     expected_payout,expected_profit,expected_roi_bps,current_value,unrealized_pnl,unrealized_roi_pct,
     entry_cost_status,entry_cost_failure_reason)
    VALUES (7,11,?,'pair-1','Test market','K-TICKER','pm-token-1','Buy YES Kalshi + NO PM',
      'yes','no','2026-08-14T10:00:00.000Z','open',?,?,?,?,40,55,96,1,95,1,96,100,4,417,99,3,313,
      ?,'Legacy position lacks authoritative entry fill and fee data')`,
      args: [executionMode, shares, shares, shares, shares, entryCostStatus],
  });
}

afterEach(() => {
  db?.close();
  db = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  vi.unstubAllGlobals();
});

async function clonePosition(client: Client, id: number, executionId: number): Promise<void> {
  const source = (await client.execute('SELECT * FROM bot_positions WHERE id=7')).rows[0];
  const clone = { ...source, id, execution_id: executionId } as Record<string, unknown>;
  const columns = Object.keys(clone);
  await client.execute({
    sql: `INSERT INTO bot_positions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    args: columns.map((column) => clone[column] as string | number | null),
  });
}

describe('BotEntryRecoveryStore', () => {
  it('restores aggregate-fee Buy Cost without claiming canonical per-leg fee recovery', async () => {
    const h = await harness();
    await seedLegacy(h.db, null);

    const manifest = await h.store.run();

    expect(manifest.counts).toMatchObject({ fullyRecoverable: 0, recovered: 1, partiallyRecoverable: 1 });
    expect(manifest.decisions[0]).toMatchObject({
      verdict: 'partially_recoverable',
      reasons: [
        'Restored Buy Cost from immutable persisted position entry record; aggregate entry fee has no durable platform split',
      ],
    });
    h.db.close();
    db = createClient({ url: h.dbUrl });
    const row = (await db.execute('SELECT * FROM bot_positions WHERE id=7')).rows[0];
    expect(row).toMatchObject({
      entry_cost_status: 'available', entry_cost_failure_reason: null,
      total_cost: 96, fees: 1, kalshi_entry_fee: 0, pm_entry_fee: 0,
      entry_fee_unallocated: 1,
      kalshi_entry_gross_microcents: 40_000_000,
      pm_entry_gross_microcents: 55_000_000,
      entry_cost_rounding_delta_microcents: 0,
      entry_record_version: 1,
      entry_record_source: 'persisted_position',
      entry_recorded_at: '2026-08-14T10:00:00.000Z',
    });
    expect(JSON.parse(String(row.kalshi_entry_fills_json))).toEqual([
      expect.objectContaining({ priceMicrocents: 40_000_000, sizeMicrounits: 1_000_000, authority: 'persisted_position_aggregate' }),
    ]);
  });

  it('preserves a recovered aggregate entry fee through partial reduction, restart, and settlement', async () => {
    const h = await harness();
    await seedLegacy(h.db, null, { shares: 2 });
    await h.db.execute(`UPDATE bot_positions SET
      total_cost=193, fees=3, live_principal=190, live_fees=3, live_cost=193,
      expected_payout=200, expected_profit=7, current_value=198,
      unrealized_pnl=5, unrealized_roi_pct=259
      WHERE id=7`);
    await h.store.run();

    const positions = new BotPositionStore(h.dbUrl);
    const recovered = await positions.getById(7);
    expect(recovered).toMatchObject({
      entryCostStatus: 'available',
      feesCents: 3,
      unallocatedEntryFeeCents: 3,
      remainingOpenFeesCents: 3,
      remainingOpenCostCents: 193,
    });
    const reduced = await positions.reduceExposure(7, {
      expectedRemainingSharesKalshi: 2,
      expectedRemainingSharesPm: 2,
      expectedLastValuationAt: null,
      remainingSharesKalshi: 1,
      remainingSharesPm: 1,
      realizedPnlCents: 5,
      observedAt: '2026-08-14T10:01:00.000Z',
    });
    expect(reduced).toMatchObject({
      remainingOpenPrincipalCents: 95,
      remainingOpenFeesCents: 2,
      remainingOpenCostCents: 97,
      unallocatedEntryFeeCents: 3,
    });
    positions.close();

    const restarted = new BotPositionStore(h.dbUrl);
    const afterRestart = await restarted.getById(7);
    expect(afterRestart).toMatchObject({
      remainingOpenFeesCents: 2,
      remainingOpenCostCents: 97,
      realizedPnlCents: 5,
    });
    const settlement = calculatePositionValuation(afterRestart!, {
      kalshiYesBidCents: 100,
      kalshiNoBidCents: 0,
      pmYesBidCents: 100,
      pmNoBidCents: 0,
      observedAt: '2026-08-16T00:00:00.000Z',
      expiryDate: '2026-08-15T00:00:00.000Z',
      kalshiResolved: true,
      pmResolved: true,
    });
    expect(settlement.realizedPnlCents).toBe(8);
    await restarted.updateValuation(7, settlement);
    const terminal = await restarted.getById(7);
    expect(terminal).toMatchObject({
      status: 'settled',
      remainingOpenFeesCents: 2,
      remainingOpenCostCents: 97,
      realizedPnlBeforeSettlementCents: 5,
      realizedPnlCents: 8,
    });
    restarted.close();
  });

  it('converts a legacy gross-only total to fee-inclusive Buy Cost exactly once', async () => {
    const h = await harness();
    await seedLegacy(h.db, null);
    await h.db.execute('UPDATE bot_positions SET total_cost=95,live_cost=95,live_principal=94 WHERE id=7');

    const manifest = await h.store.run();

    expect(manifest.counts.recovered).toBe(1);
    const row = (await h.db.execute(`SELECT total_cost,fees,live_principal,live_fees,live_cost,
      current_value,unrealized_pnl,unrealized_roi_pct FROM bot_positions WHERE id=7`)).rows[0];
    expect(row).toMatchObject({
      total_cost: 96, fees: 1, live_principal: 95, live_fees: 1, live_cost: 96,
      current_value: 99, unrealized_pnl: 3, unrealized_roi_pct: 313,
    });
  });

  it('isolates a malformed ledger row, recovers its valid sibling, and performs no venue or HTTP calls', async () => {
    const h = await harness();
    await seedLegacy(h.db, null);
    await h.db.execute(`INSERT INTO executions
      SELECT 12,timestamp,'arb-12',source,dry_run,success,kalshi_order,polymarket_order,result,steps,bot_entry_evidence
      FROM executions WHERE id=11`);
    await clonePosition(h.db, 8, 12);
    await h.db.execute('UPDATE bot_positions SET total_cost=94 WHERE id=8');
    const fetchSpy = vi.fn(() => { throw new Error('recovery must not call a venue'); });
    vi.stubGlobal('fetch', fetchSpy);

    const manifest = await h.store.run();

    expect(manifest.counts).toMatchObject({ recovered: 1, partiallyRecoverable: 1, fullyRecoverable: 0, conflicting: 1 });
    expect(manifest.decisions.find((decision) => decision.positionId === 8)?.reasons)
      .toContain('persisted Buy Cost conflicts with persisted Buy Prices, quantities, and entry fees');
    const rows = (await h.db.execute('SELECT id,total_cost,entry_cost_status FROM bot_positions ORDER BY id')).rows;
    expect(rows).toEqual([
      expect.objectContaining({ id: 7, total_cost: 96, entry_cost_status: 'available' }),
      expect.objectContaining({ id: 8, total_cost: 94, entry_cost_status: 'unavailable' }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('recovers exact two-leg evidence and reconciles Buy Cost and P&L', async () => {
    const h = await harness();
    await seedLegacy(h.db);

    const manifest = await h.store.run();

    expect(manifest.counts).toMatchObject({ fullyRecoverable: 1, recovered: 1, conflicting: 0, irrecoverable: 0 });
    expect(manifest.reconciliation).toEqual({
      before: { availableBuyCostCents: 0, unavailableReportedBuyCostCents: 96 },
      after: { availableBuyCostCents: 97, unavailableReportedBuyCostCents: 0 },
      recoveredBuyCostCents: 97,
      invalidatedBuyCostCents: 0,
      recoveredPositions: [{
        positionId: 7, valuationStatus: null,
        currentValueBefore: 99, currentValueAfter: 99,
        unrealizedPnlBefore: 3, unrealizedPnlAfter: 2,
        unrealizedRoiBefore: 313, unrealizedRoiAfter: 206,
      }],
    });
    h.db.close();
    db = createClient({ url: h.dbUrl });
    const row = (await db.execute('SELECT * FROM bot_positions WHERE id = 7')).rows[0];
    expect(row).toMatchObject({
      entry_cost_status: 'available', entry_cost_failure_reason: null,
      kalshi_entry_gross_microcents: 40_000_000, pm_entry_gross_microcents: 55_000_000,
      kalshi_entry_fee: 1, pm_entry_fee: 1, fees: 2, total_cost: 97,
      live_principal: 95, live_fees: 2, live_cost: 97,
      expected_payout: 100, expected_profit: 3, expected_roi_bps: 309,
      current_value: 99, unrealized_pnl: 2, unrealized_roi_pct: 206,
      kalshi_entry_fee_authority: 'execution_estimate', pm_entry_fee_authority: 'execution_estimate',
      entry_evidence_revision: 1,
    });
    expect(JSON.parse(String(row.kalshi_entry_fills_json))).toEqual(exactEvidence().legs.kalshi.fills);
    expect(JSON.parse(String(row.pm_entry_fills_json))).toEqual(exactEvidence().legs.polymarket.fills);
    expect((await db.execute('SELECT COUNT(*) AS count FROM bot_entry_recovery_evidence')).rows[0].count).toBe(1);
    expect((await db.execute('SELECT verdict FROM bot_entry_recovery_decisions WHERE position_id = 7')).rows[0].verdict).toBe('fully_recoverable');
  });

  it('preserves multi-fill ladders and charged fee authority without averaging nonlinear evidence', async () => {
    const h = await harness();
    const evidence = exactEvidence({
      mode: 'live',
      legs: {
        kalshi: {
          ...exactEvidence().legs.kalshi,
          quantityMicrounits: 2_000_000,
          fills: [
            { fillId: 'k-fill-1', fillAuthority: 'venue_fill', observedAt: '2026-08-14T09:59:58.000Z', chargedFeeCents: 1, priceMicrocents: 40_000_000, sizeMicrounits: 1_000_000 },
            { fillId: 'k-fill-2', fillAuthority: 'venue_fill', observedAt: '2026-08-14T09:59:59.000Z', chargedFeeCents: 1, priceMicrocents: 41_000_000, sizeMicrounits: 1_000_000 },
          ],
          grossMicrocents: 81_000_000,
          fee: { ...exactEvidence().legs.kalshi.fee, amountCents: 2, authority: 'charged' },
        },
        polymarket: {
          ...exactEvidence().legs.polymarket,
          quantityMicrounits: 2_000_000,
          fills: [
            { fillId: 'p-fill-1', fillAuthority: 'venue_fill', observedAt: '2026-08-14T09:59:58.000Z', chargedFeeCents: 1, priceMicrocents: 54_000_000, sizeMicrounits: 1_000_000 },
            { fillId: 'p-fill-2', fillAuthority: 'venue_fill', observedAt: '2026-08-14T09:59:59.000Z', chargedFeeCents: 0, priceMicrocents: 53_000_000, sizeMicrounits: 1_000_000 },
          ],
          grossMicrocents: 107_000_000,
          fee: { ...exactEvidence().legs.polymarket.fee, amountCents: 1, authority: 'charged' },
        },
      },
    });
    await seedLegacy(h.db, evidence, { shares: 2, dryRun: false, executionMode: 'live' });

    const manifest = await h.store.run();

    expect(manifest.counts.recovered).toBe(1);
    h.db.close();
    db = createClient({ url: h.dbUrl });
    const row = (await db.execute('SELECT * FROM bot_positions WHERE id=7')).rows[0];
    expect(row).toMatchObject({
      entry_cost_status: 'available', kalshi_entry_fill_count: 2, pm_entry_fill_count: 2,
      kalshi_entry_gross_microcents: 81_000_000, pm_entry_gross_microcents: 107_000_000,
      kalshi_entry_fee_authority: 'charged', pm_entry_fee_authority: 'charged',
      fees: 3, total_cost: 191, expected_payout: 200, expected_profit: 9,
    });
    expect(String(row.entry_evidence_sha256)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(String(row.kalshi_entry_fills_json))).toEqual(expect.arrayContaining([
      expect.objectContaining({ fillId: 'k-fill-1', fillAuthority: 'venue_fill', chargedFeeCents: 1 }),
    ]));
    expect(JSON.parse(String(row.pm_entry_fills_json))).toHaveLength(2);
  });

  it('keeps a row fail-closed with a precise blocker when one leg is missing', async () => {
    const h = await harness();
    const evidence = exactEvidence();
    delete (evidence.legs as Partial<BotEntryEvidenceV1['legs']>).polymarket;
    await seedLegacy(h.db, evidence);

    const manifest = await h.store.run();

    expect(manifest.counts).toMatchObject({ recovered: 0, irrecoverable: 1 });
    h.db.close();
    db = createClient({ url: h.dbUrl });
    const row = (await db.execute('SELECT entry_cost_status,entry_cost_failure_reason,total_cost FROM bot_positions WHERE id=7')).rows[0];
    expect(row.entry_cost_status).toBe('unavailable');
    expect(String(row.entry_cost_failure_reason)).toContain('Polymarket leg evidence is missing');
    expect(row.total_cost).toBe(96);
  });

  it('classifies duplicated venue order IDs as conflicting instead of recovering either row', async () => {
    const h = await harness();
    await seedLegacy(h.db);
    await h.db.execute(`INSERT INTO executions
      SELECT 12,timestamp,arb_id,source,dry_run,success,kalshi_order,polymarket_order,result,steps,bot_entry_evidence
      FROM executions WHERE id=11`);
    await h.db.execute(`INSERT INTO bot_positions (
        id,execution_id,execution_mode,market_id,market_title,kalshi_ticker,pm_condition_id,strategy,
        kalshi_side,pm_side,opened_at,status,shares_kalshi,shares_pm,live_shares_kalshi,live_shares_pm,
        buy_price_kalshi,buy_price_pm,total_cost,fees,live_principal,live_fees,live_cost,
        expected_payout,expected_profit,expected_roi_bps,current_value,unrealized_pnl,unrealized_roi_pct,
        entry_cost_status,entry_evidence_revision,entry_cost_failure_reason,kalshi_entry_gross_microcents,pm_entry_gross_microcents,
        entry_cost_rounding_delta_microcents,kalshi_entry_fill_count,pm_entry_fill_count,
        kalshi_entry_fills_json,pm_entry_fills_json,kalshi_entry_fee,pm_entry_fee,
        kalshi_entry_fee_type,kalshi_entry_fee_multiplier_ppm,kalshi_entry_fee_source,
        kalshi_entry_fee_observed_at,kalshi_entry_fee_version,pm_entry_token_id,pm_entry_fee_rate_bps,
        pm_entry_fee_source,pm_entry_fee_observed_at,pm_entry_fee_version
      ) SELECT 8,12,execution_mode,market_id,market_title,kalshi_ticker,pm_condition_id,strategy,
        kalshi_side,pm_side,opened_at,status,shares_kalshi,shares_pm,live_shares_kalshi,live_shares_pm,
        buy_price_kalshi,buy_price_pm,total_cost,fees,live_principal,live_fees,live_cost,
        expected_payout,expected_profit,expected_roi_bps,current_value,unrealized_pnl,unrealized_roi_pct,
        entry_cost_status,entry_evidence_revision,entry_cost_failure_reason,kalshi_entry_gross_microcents,pm_entry_gross_microcents,
        entry_cost_rounding_delta_microcents,kalshi_entry_fill_count,pm_entry_fill_count,
        kalshi_entry_fills_json,pm_entry_fills_json,kalshi_entry_fee,pm_entry_fee,
        kalshi_entry_fee_type,kalshi_entry_fee_multiplier_ppm,kalshi_entry_fee_source,
        kalshi_entry_fee_observed_at,kalshi_entry_fee_version,pm_entry_token_id,pm_entry_fee_rate_bps,
        pm_entry_fee_source,pm_entry_fee_observed_at,pm_entry_fee_version
      FROM bot_positions WHERE id=7`);

    const manifest = await h.store.run();

    expect(manifest.counts).toMatchObject({ recovered: 0, fullyRecoverable: 0, conflicting: 2 });
    expect(manifest.decisions.every((decision) => decision.reasons.some((reason) => reason.includes('duplicate Kalshi order ID')))).toBe(true);
  });

  it('is idempotent and records the already-authoritative verdict on rerun', async () => {
    const h = await harness();
    await seedLegacy(h.db);

    const first = await h.store.run();
    const second = await h.store.run();

    expect(first.counts.recovered).toBe(1);
    expect(second.counts).toMatchObject({ recovered: 0, alreadyAuthoritative: 1 });
    h.db.close();
    db = createClient({ url: h.dbUrl });
    expect((await db.execute('SELECT entry_evidence_revision FROM bot_positions WHERE id=7')).rows[0].entry_evidence_revision).toBe(1);
    expect((await db.execute('SELECT COUNT(*) AS count FROM bot_entry_recovery_evidence')).rows[0].count).toBe(2);
    expect((await db.execute('SELECT COUNT(*) AS count FROM bot_entry_recovery_runs')).rows[0].count).toBe(2);
    expect((await db.execute('SELECT COUNT(*) AS count FROM bot_entry_recovery_decisions')).rows[0].count).toBe(2);
  });

  it('rejects a stale audit when the immutable execution evidence changes before apply', async () => {
    const h = await harness();
    await seedLegacy(h.db);
    const manifest = await h.store.audit();
    const changed = exactEvidence();
    changed.legs.kalshi.fee.amountCents = 2;
    await h.db.execute({
      sql: 'UPDATE executions SET bot_entry_evidence=? WHERE id=11',
      args: [JSON.stringify(changed)],
    });

    await expect(h.store.apply(manifest)).rejects.toThrow('Stale source evidence for bot position 7');

    const row = (await h.db.execute('SELECT entry_cost_status FROM bot_positions WHERE id=7')).rows[0];
    expect(row.entry_cost_status).toBe('unavailable');
  });

  it('keeps an unproven legacy fee split aggregate even when the Buy Cost flag is already available', async () => {
    const h = await harness();
    await seedLegacy(h.db, null, { entryCostStatus: 'available' });
    await h.db.execute('UPDATE bot_positions SET kalshi_entry_fee=1,pm_entry_fee=0 WHERE id=7');

    const manifest = await h.store.audit();

    expect(manifest.counts.alreadyAuthoritative).toBe(0);
    expect(manifest.decisions[0]).toMatchObject({
      verdict: 'partially_recoverable',
      persistedPositionEntry: {
        unallocatedEntryFeeCents: 1,
        legs: { kalshi: { feeCents: 0 }, polymarket: { feeCents: 0 } },
      },
    });
    const applied = await h.store.apply(manifest);
    expect(applied.reconciliation).toMatchObject({
      before: { availableBuyCostCents: 96, unavailableReportedBuyCostCents: 0 },
      after: { availableBuyCostCents: 96, unavailableReportedBuyCostCents: 0 },
      invalidatedBuyCostCents: 0,
    });
    const row = (await h.db.execute(`SELECT entry_cost_status,entry_cost_failure_reason,
      kalshi_entry_fee,pm_entry_fee,entry_fee_unallocated FROM bot_positions WHERE id=7`)).rows[0];
    expect(row).toMatchObject({
      entry_cost_status: 'available', entry_cost_failure_reason: null,
      kalshi_entry_fee: 0, pm_entry_fee: 0, entry_fee_unallocated: 1,
    });
  });

  it('keeps dry-run audit read-only', async () => {
    const h = await harness();
    await seedLegacy(h.db);

    await h.store.audit();

    const tables = (await h.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bot_entry_recovery_%'"))
      .rows.map((row) => String(row.name));
    expect(tables).toEqual([]);
  });

  it('rolls back every position and audit row on an injected crash, then recovers on restart', async () => {
    const h = await harness();
    await seedLegacy(h.db);

    await expect(h.store.run({ beforeCommit: () => { throw new Error('injected crash'); } }))
      .rejects.toThrow('injected crash');
    expect((await h.db.execute('SELECT entry_cost_status FROM bot_positions WHERE id=7')).rows[0].entry_cost_status)
      .toBe('unavailable');
    expect((await h.db.execute('SELECT COUNT(*) AS count FROM bot_entry_recovery_runs')).rows[0].count).toBe(0);

    const restarted = new BotEntryRecoveryStore(h.dbUrl);
    const manifest = await restarted.run();
    restarted.close();
    expect(manifest.counts.recovered).toBe(1);
  });

  it('rejects an apply when the position revision changes after audit', async () => {
    const h = await harness();
    await seedLegacy(h.db);
    const manifest = await h.store.audit();
    await h.db.execute('UPDATE bot_positions SET entry_evidence_revision=entry_evidence_revision+1 WHERE id=7');

    await expect(h.store.apply(manifest)).rejects.toThrow('Stale entry-evidence revision for bot position 7');
    expect((await h.db.execute('SELECT entry_cost_status FROM bot_positions WHERE id=7')).rows[0].entry_cost_status)
      .toBe('unavailable');
  });

  it('fails closed for fuzzed null, negative, and fractional price/fee values', async () => {
    const h = await harness();
    await seedLegacy(h.db);
    let seed = 0x157;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const malformed: unknown[] = [null, -1, -0.01, 0.5, ...Array.from({ length: 20 }, () => -(random() * 100 + 0.001))];
    for (const value of malformed) {
      const candidate = exactEvidence() as unknown as Record<string, unknown>;
      const legs = candidate.legs as Record<string, Record<string, unknown>>;
      (legs.kalshi.fee as Record<string, unknown>).amountCents = value;
      (legs.polymarket.fills as Array<Record<string, unknown>>)[0].priceMicrocents = value;
      await h.db.execute({
        sql: 'UPDATE executions SET bot_entry_evidence=? WHERE id=11',
        args: [JSON.stringify(candidate)],
      });
      const decision = (await h.store.audit()).decisions[0];
      expect(decision.verdict).toBe('conflicting');
      expect(decision.evidence).toBeNull();
    }
  });

  it('does not overwrite reduced or closed lifecycle accounting with full-entry economics', async () => {
    const h = await harness();
    await seedLegacy(h.db);
    await h.db.execute(`UPDATE bot_positions SET status='partially_closed', live_shares_kalshi=0.5,
      live_principal=47, live_fees=1, live_cost=48, total_cost=96 WHERE id=7`);

    const manifest = await h.store.run();

    expect(manifest.decisions[0]).toMatchObject({ verdict: 'partially_recoverable' });
    expect(manifest.decisions[0].reasons).toContain(
      'position lifecycle is no longer pristine; exact reduction/settlement allocation evidence is required',
    );
    const row = (await h.db.execute('SELECT * FROM bot_positions WHERE id=7')).rows[0];
    expect(row).toMatchObject({
      entry_cost_status: 'unavailable', total_cost: 96, live_principal: 47, live_fees: 1, live_cost: 48,
    });
  });

  it.each(['partially_closed', 'closed', 'settled'])(
    'preserves already-available %s lifecycle accounting while reporting incomplete legacy recovery',
    async (status) => {
      const h = await harness();
      await seedLegacy(h.db, null, { entryCostStatus: 'available' });
      const remaining = status === 'partially_closed' ? 0.5 : 0;
      await h.db.execute({
        sql: `UPDATE bot_positions SET status=?, live_shares_kalshi=?, live_shares_pm=?,
          live_principal=47, live_fees=1, live_cost=48 WHERE id=7`,
        args: [status, remaining, remaining],
      });

      const manifest = await h.store.run();

      expect(manifest.decisions[0]).toMatchObject({ verdict: 'partially_recoverable' });
      expect(manifest.decisions[0].reasons).toContain(
        'position lifecycle is no longer pristine; exact reduction/settlement allocation evidence is required',
      );
      expect(manifest.reconciliation.invalidatedBuyCostCents).toBe(0);
      expect((await h.db.execute(`SELECT status,entry_cost_status,total_cost,fees,
        live_shares_kalshi,live_shares_pm,live_principal,live_fees,live_cost
        FROM bot_positions WHERE id=7`)).rows[0]).toMatchObject({
        status, entry_cost_status: 'available', total_cost: 96, fees: 1,
        live_shares_kalshi: remaining, live_shares_pm: remaining,
        live_principal: 47, live_fees: 1, live_cost: 48,
      });
    },
  );

  it('rejects live fee estimates even when their labels and amounts are well-shaped', async () => {
    const h = await harness();
    const evidence = exactEvidence({ mode: 'live' });
    for (const leg of [evidence.legs.kalshi, evidence.legs.polymarket]) {
      leg.fills = leg.fills.map((fill: BotEntryEvidenceV1['legs']['kalshi']['fills'][number]) => ({
        ...fill, fillAuthority: 'venue_fill', chargedFeeCents: leg.fee.amountCents,
      }));
    }
    await seedLegacy(h.db, evidence, { dryRun: false, executionMode: 'live' });

    const decision = (await h.store.audit()).decisions[0];

    expect(decision.verdict).toBe('conflicting');
    expect(decision.reasons).toContain('Kalshi live fee must be venue-charged');
    expect(decision.reasons).toContain('Polymarket live fee must be venue-charged');
  });

  it('rejects evidence mutated in memory after the audited source snapshot', async () => {
    const h = await harness();
    await seedLegacy(h.db);
    const manifest = await h.store.audit();
    if (!manifest.decisions[0].evidence) throw new Error('expected recoverable evidence');
    manifest.decisions[0].evidence.legs.kalshi.fee.amountCents = 99;

    await expect(h.store.apply(manifest)).rejects.toThrow('Manifest evidence changed after audit for bot position 7');
    expect((await h.db.execute('SELECT entry_cost_status FROM bot_positions WHERE id=7')).rows[0].entry_cost_status)
      .toBe('unavailable');
  });

  it('classifies a present but malformed evidence envelope as conflicting', async () => {
    const h = await harness();
    await seedLegacy(h.db);
    await h.db.execute("UPDATE executions SET bot_entry_evidence='{' WHERE id=11");

    const decision = (await h.store.audit()).decisions[0];

    expect(decision).toMatchObject({ verdict: 'conflicting', reasons: ['persisted entry evidence is malformed'] });
  });

  it('keeps an unchanged aggregate-fee classification explicit and idempotent', async () => {
    const h = await harness();
    await seedLegacy(h.db, null);
    await h.store.run();
    const first = (await h.db.execute('SELECT entry_evidence_revision,entry_recovery_decision_id FROM bot_positions WHERE id=7')).rows[0];

    const rerun = await h.store.run();
    const second = (await h.db.execute('SELECT entry_evidence_revision,entry_recovery_decision_id FROM bot_positions WHERE id=7')).rows[0];

    expect(rerun.counts).toMatchObject({ partiallyRecoverable: 1, recovered: 0 });
    expect(rerun.decisions[0]).toMatchObject({ verdict: 'partially_recoverable', persistedPositionEntry: null });
    expect(second).toEqual(first);
    expect(second.entry_evidence_revision).toBe(1);
  });

  it('rejects a stale pristine audit after concurrent reduction changes lifecycle accounting', async () => {
    const h = await harness();
    await seedLegacy(h.db);
    const manifest = await h.store.audit();
    await h.db.execute(`UPDATE bot_positions SET status='partially_closed', live_shares_kalshi=0.5,
      live_principal=47, live_fees=1, live_cost=48 WHERE id=7`);

    await expect(h.store.apply(manifest)).rejects.toThrow('Stale entry-evidence revision for bot position 7');
    const row = (await h.db.execute('SELECT * FROM bot_positions WHERE id=7')).rows[0];
    expect(row).toMatchObject({
      status: 'partially_closed', entry_cost_status: 'unavailable',
      live_shares_kalshi: 0.5, live_principal: 47, live_fees: 1, live_cost: 48,
    });
  });

  it.each(['partially_closed', 'closed', 'settled'])(
    'rejects an available-row audit after a concurrent transition to %s',
    async (status) => {
      const h = await harness();
      await seedLegacy(h.db, null, { entryCostStatus: 'available' });
      const manifest = await h.store.audit();
      const remaining = status === 'partially_closed' ? 0.5 : 0;
      await h.db.execute({
        sql: `UPDATE bot_positions SET status=?,live_shares_kalshi=?,live_shares_pm=?,
          live_principal=47,live_fees=1,live_cost=48 WHERE id=7`,
        args: [status, remaining, remaining],
      });

      await expect(h.store.apply(manifest)).rejects.toThrow('Stale entry-evidence revision for bot position 7');
      expect((await h.db.execute(`SELECT status,entry_cost_status,total_cost,fees,
        live_principal,live_fees,live_cost FROM bot_positions WHERE id=7`)).rows[0]).toMatchObject({
        status, entry_cost_status: 'available', total_cost: 96, fees: 1,
        live_principal: 47, live_fees: 1, live_cost: 48,
      });
    },
  );
});
