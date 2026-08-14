/// <reference types="node" />

/**
 * One-time, idempotent correction for BotTrader Polymarket identifiers.
 *
 * Dry-run (default): npm run migrate:bot-position-pm-identities
 * Apply:             npm run migrate:bot-position-pm-identities -- --apply
 * Alternate DB:      npm run migrate:bot-position-pm-identities -- --db=/absolute/path.db --apply
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { planBotPositionPmIdentityMigration } from '../src/lib/bot-position-pm-identity-migration';

function argValue(prefix: string): string | null {
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

const apply = process.argv.includes('--apply');
const dbPath = path.resolve(argValue('--db=')
  ?? process.env.H2H_SQLITE_PATH
  ?? path.join(process.cwd(), 'data', 'edgefinder.db'));

if (!existsSync(dbPath)) throw new Error(`SQLite database does not exist: ${dbPath}`);

const POSITION_SQL = `SELECT id, status, pm_condition_id, pm_entry_token_id, pm_exit_token_id, pm_side
  FROM bot_positions WHERE status = 'open' AND pm_side IN ('yes', 'no') ORDER BY id`;
const SNAPSHOT_SQL = `SELECT market_id, side, token_id FROM platform_price_snapshots
  WHERE platform = 'polymarket' AND side IN ('yes', 'no')`;

function mapPositions(rows: readonly Record<string, unknown>[]) {
  return rows.map((row) => ({
    id: Number(row.id),
    status: String(row.status),
    pmConditionId: row.pm_condition_id == null ? null : String(row.pm_condition_id),
    pmEntryTokenId: row.pm_entry_token_id == null ? null : String(row.pm_entry_token_id),
    pmExitTokenId: row.pm_exit_token_id == null ? null : String(row.pm_exit_token_id),
    pmSide: String(row.pm_side) as 'yes' | 'no',
  }));
}

function mapSnapshots(rows: readonly Record<string, unknown>[]) {
  return rows.map((row) => ({
    marketId: String(row.market_id),
    side: String(row.side) as 'yes' | 'no',
    tokenId: row.token_id == null ? null : String(row.token_id),
  }));
}

const client = createClient({ url: `file:${dbPath}` });
try {
  await client.execute('PRAGMA busy_timeout = 5000');
  const [positionResult, snapshotResult] = await Promise.all([
    client.execute(POSITION_SQL),
    client.execute(SNAPSHOT_SQL),
  ]);

  let positions = mapPositions(positionResult.rows as unknown as Record<string, unknown>[]);
  let snapshots = mapSnapshots(snapshotResult.rows as unknown as Record<string, unknown>[]);
  let plan = planBotPositionPmIdentityMigration(positions, snapshots);

  if (apply && plan.corrections.length > 0) {
    // Historical duplicate rows can legitimately exist. Preserve the runtime
    // guard definitions exactly, but suspend them inside this one transaction
    // so semantic-ID correction does not strand a row behind a legacy token.
    const triggerNames = [
      'bot_positions_open_pair_insert_guard',
      'bot_positions_open_pair_update_guard',
    ];
    const transaction = await client.transaction('write');
    try {
      // Re-plan from one locked database revision. Snapshot-token mappings and
      // position identifiers cannot change between this read and the updates.
      const lockedPositionResult = await transaction.execute(POSITION_SQL);
      const lockedSnapshotResult = await transaction.execute(SNAPSHOT_SQL);
      positions = mapPositions(lockedPositionResult.rows as unknown as Record<string, unknown>[]);
      snapshots = mapSnapshots(lockedSnapshotResult.rows as unknown as Record<string, unknown>[]);
      plan = planBotPositionPmIdentityMigration(positions, snapshots);

      const triggerResult = await transaction.execute({
        sql: `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)`,
        args: triggerNames,
      });
      const triggers = triggerResult.rows.map((row) => ({
        name: String(row.name),
        sql: String(row.sql ?? ''),
      }));
      if (triggers.some((trigger) => !trigger.sql.trim())) {
        throw new Error('Could not preserve BotTrader open-pair trigger definition');
      }
      for (const trigger of triggers) {
        await transaction.execute(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      }
      for (const correction of plan.corrections) {
        const result = await transaction.execute({
          sql: `UPDATE bot_positions
            SET pm_condition_id = ?, pm_entry_token_id = ?, pm_exit_token_id = ?
            WHERE id = ? AND status = 'open'
              AND pm_condition_id IS ? AND pm_entry_token_id IS ? AND pm_exit_token_id IS ?`,
          args: [
            correction.pmConditionId,
            correction.pmEntryTokenId,
            correction.pmExitTokenId,
            correction.id,
            correction.oldPmConditionId,
            correction.oldPmEntryTokenId,
            correction.oldPmExitTokenId,
          ],
        });
        if (Number(result.rowsAffected) !== 1) {
          throw new Error(`Position ${correction.id} changed after planning; no correction was committed`);
        }
      }
      for (const trigger of triggers) await transaction.execute(trigger.sql);
      await transaction.commit();
    } catch (error) {
      if (!transaction.closed) await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }

    const integrity = await client.execute('PRAGMA integrity_check');
    if (String(integrity.rows[0]?.integrity_check ?? '') !== 'ok') {
      throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity.rows)}`);
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    dbPath,
    scannedOpenPositions: positions.length,
    corrections: plan.corrections,
    unresolved: plan.unresolved,
    applied: apply ? plan.corrections.length : 0,
  }, null, 2));
} finally {
  client.close();
}
