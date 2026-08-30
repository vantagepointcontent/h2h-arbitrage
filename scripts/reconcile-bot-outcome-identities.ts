/// <reference types="node" />
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createClient } from '@libsql/client';
import {
  applyBotOutcomeIdentityReconciliation,
  isSqliteIntegrityCheckOk,
  planBotOutcomeIdentityReconciliation,
  prepareBotOutcomeIdentitySchema,
} from '../src/lib/bot-outcome-identity-reconciliation';
import { createMatchedMarketMappingStore } from '../src/lib/matched-market-mapping';

function argValue(prefix: string): string | null {
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

const apply = process.argv.includes('--apply');
const dbPath = path.resolve(argValue('--db=') ?? process.env.H2H_SQLITE_PATH ?? path.join(process.cwd(), 'data', 'edgefinder.db'));
if (!existsSync(dbPath)) throw new Error(`SQLite database does not exist: ${dbPath}`);

const client = createClient({ url: `file:${dbPath}` });
try {
  await client.execute('PRAGMA busy_timeout = 30000');
  const info = await client.execute('PRAGMA table_info(bot_positions)');
  const existing = new Set(info.rows.map((row) => String(row.name)));
  await prepareBotOutcomeIdentitySchema(existing, apply, async (sql) => client.execute(sql));
  const outcomeIdentityStatusExpression = apply || existing.has('outcome_identity_status')
    ? 'outcome_identity_status'
    : "'unresolved' AS outcome_identity_status";
  const rows = await client.execute(`SELECT id, market_id, status, opened_at, kalshi_ticker, pm_condition_id,
    pm_entry_token_id, kalshi_side, pm_side, ${outcomeIdentityStatusExpression},
    ${apply || existing.has('kalshi_market_question') ? 'kalshi_market_question' : 'NULL AS kalshi_market_question'},
    ${apply || existing.has('pm_market_question') ? 'pm_market_question' : 'NULL AS pm_market_question'},
    ${apply || existing.has('kalshi_outcome_label') ? 'kalshi_outcome_label' : 'NULL AS kalshi_outcome_label'},
    ${apply || existing.has('pm_outcome_label') ? 'pm_outcome_label' : 'NULL AS pm_outcome_label'}
    FROM bot_positions WHERE status = 'open' ORDER BY id`);
  const positions = rows.rows.map((row) => ({
    id: Number(row.id), status: String(row.status), openedAt: String(row.opened_at),
    matchedMarketId: row.market_id == null ? null : String(row.market_id),
    kalshiTicker: row.kalshi_ticker == null ? null : String(row.kalshi_ticker),
    pmConditionId: row.pm_condition_id == null ? null : String(row.pm_condition_id),
    pmEntryTokenId: row.pm_entry_token_id == null ? null : String(row.pm_entry_token_id),
    kalshiSide: String(row.kalshi_side) as 'yes' | 'no',
    pmSide: String(row.pm_side) as 'yes' | 'no',
    outcomeIdentityStatus: row.outcome_identity_status === 'verified' ? 'verified' as const : 'unresolved' as const,
    kalshiMarketQuestion: row.kalshi_market_question == null ? null : String(row.kalshi_market_question),
    pmMarketQuestion: row.pm_market_question == null ? null : String(row.pm_market_question),
    kalshiOutcomeLabel: row.kalshi_outcome_label == null ? null : String(row.kalshi_outcome_label),
    pmOutcomeLabel: row.pm_outcome_label == null ? null : String(row.pm_outcome_label),
  }));
  const mappingStore = createMatchedMarketMappingStore(client);
  const plan = await planBotOutcomeIdentityReconciliation(positions, async (input) => {
    if (!input.kalshiTicker || !input.pmConditionId || !input.pmTokenId) return null;
    const resolved = await mappingStore.resolve({
      matchedMarketId: input.matchedMarketId,
      kalshiTicker: input.kalshiTicker,
      pmConditionId: input.pmConditionId,
      pmTokenId: input.pmTokenId,
      kalshiSide: input.kalshiSide,
      pmSide: input.pmSide,
    });
    return resolved.state === 'verified' ? resolved.relationship : null;
  });

  if (apply) {
    const transaction = await client.transaction('write');
    try {
      await applyBotOutcomeIdentityReconciliation(plan, {
        execute: async (statement) => transaction.execute(statement),
      }, new Date().toISOString());
      await transaction.commit();
    } catch (error) {
      if (!transaction.closed) await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
    const integrity = await client.execute('PRAGMA integrity_check');
    if (!isSqliteIntegrityCheckOk(integrity.rows[0])) throw new Error('SQLite integrity_check failed');
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run', dbPath, scannedOpenPositions: positions.length,
    corrections: plan.corrections, unresolved: plan.unresolved, applied: apply ? plan.corrections.length : 0,
  }, null, 2));
} finally {
  client.close();
}
