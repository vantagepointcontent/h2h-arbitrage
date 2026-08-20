import type { Client } from '@libsql/client';
import { HISTORICAL_SCAN_FINANCIALS_REVISION, resolveHistoricalScanFinancials } from './historical-scan-financials';

export interface HistoricalFinancialRecoveryReport {
  revision: typeof HISTORICAL_SCAN_FINANCIALS_REVISION;
  apply: boolean;
  counts: {
    inspected: number;
    recovered: number;
    fullyRecoverable: number;
    partiallyRecoverable: number;
    unrecoverable: number;
    conflicted: number;
    applied: number;
    alreadyCurrent: number;
  };
}

type RecoveryRow = Record<string, unknown> & { id: number };

async function hasColumn(client: Client, name: string): Promise<boolean> {
  const columns = await client.execute('PRAGMA table_info(scan_results)');
  return columns.rows.some((row) => row.name === name);
}

async function ensureRecoveryColumns(client: Client): Promise<void> {
  for (const ddl of [
    'ALTER TABLE scan_results ADD COLUMN historical_financials_revision INTEGER',
    'ALTER TABLE scan_results ADD COLUMN historical_financials_provenance TEXT',
  ]) {
    try {
      await client.execute(ddl);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.toLowerCase().includes('duplicate column')) throw error;
    }
  }
}

function stableProvenance(row: RecoveryRow) {
  const resolved = resolveHistoricalScanFinancials(row);
  return {
    revision: resolved.revision,
    scanId: resolved.scanId,
    envelope: {
      version: resolved.envelope.version,
      status: resolved.envelope.status,
      blockerCode: resolved.envelope.blocker?.code ?? null,
    },
    fields: Object.fromEntries(Object.entries(resolved.fields).map(([name, field]) => [name, field.status === 'available'
      ? { status: field.status, source: field.source, sourceRevision: field.sourceRevision }
      : {
          status: field.status,
          source: field.source,
          sourceRevision: field.sourceRevision,
          reasonCode: field.reasonCode,
          reason: field.reason,
        }])),
  };
}

/**
 * Recover only directly persisted scalar/raw snapshot evidence. Existing valid
 * scalars are never overwritten, and a higher revision always fences this run.
 */
export async function recoverHistoricalScanFinancials(
  client: Client,
  options: { apply: boolean },
): Promise<HistoricalFinancialRecoveryReport> {
  if (options.apply) await ensureRecoveryColumns(client);
  const hasRevision = await hasColumn(client, 'historical_financials_revision');
  const hasProvenance = await hasColumn(client, 'historical_financials_provenance');
  const hasStrategy = await hasColumn(client, 'strategy');
  const result = await client.execute(`SELECT id, ${hasStrategy ? 'strategy' : 'NULL AS strategy'}, positive_arb_count, best_roi_pct, best_profit,
    apy_pct, total_stake, raw_result, calculation_envelope,
    ${hasRevision ? 'historical_financials_revision' : 'NULL'} AS historical_financials_revision,
    ${hasProvenance ? 'historical_financials_provenance' : 'NULL'} AS historical_financials_provenance
    FROM scan_results WHERE positive_arb_count > 0 ORDER BY id`);

  const counts: HistoricalFinancialRecoveryReport['counts'] = {
    inspected: 0,
    recovered: 0,
    fullyRecoverable: 0,
    partiallyRecoverable: 0,
    unrecoverable: 0,
    conflicted: 0,
    applied: 0,
    alreadyCurrent: 0,
  };
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = [];

  for (const rawRow of result.rows) {
    const row = rawRow as unknown as RecoveryRow;
    const existingRevision = typeof row.historical_financials_revision === 'number'
      ? row.historical_financials_revision
      : null;
    if (existingRevision != null && existingRevision > HISTORICAL_SCAN_FINANCIALS_REVISION) {
      counts.conflicted += 1;
      continue;
    }
    if (existingRevision === HISTORICAL_SCAN_FINANCIALS_REVISION) {
      counts.alreadyCurrent += 1;
      continue;
    }

    counts.inspected += 1;
    const resolved = resolveHistoricalScanFinancials(row);
    const available = Object.values(resolved.fields).filter((field) => field.status === 'available').length;
    if (available === 0) counts.unrecoverable += 1;
    else {
      counts.recovered += 1;
      if (available === 4) counts.fullyRecoverable += 1;
      else counts.partiallyRecoverable += 1;
    }

    if (!options.apply) continue;
    const rawValue = (name: keyof typeof resolved.fields): number | null => {
      const field = resolved.fields[name];
      return field.status === 'available' && field.source === 'raw_result_snapshot' ? field.value : null;
    };
    statements.push({
      sql: `UPDATE scan_results SET
        best_roi_pct = CASE WHEN (best_roi_pct IS NULL OR best_roi_pct = 0) AND ? IS NOT NULL THEN ? ELSE best_roi_pct END,
        best_profit = CASE WHEN (best_profit IS NULL OR best_profit = 0) AND ? IS NOT NULL THEN ? ELSE best_profit END,
        apy_pct = CASE WHEN (apy_pct IS NULL OR apy_pct = 0) AND ? IS NOT NULL THEN ? ELSE apy_pct END,
        total_stake = CASE WHEN (total_stake IS NULL OR total_stake = 0) AND ? IS NOT NULL THEN ? ELSE total_stake END,
        historical_financials_revision = ?, historical_financials_provenance = ?
        WHERE id = ?
          AND positive_arb_count IS ?
          AND best_roi_pct IS ?
          AND best_profit IS ?
          AND apy_pct IS ?
          AND total_stake IS ?
          AND raw_result IS ?
          AND calculation_envelope IS ?
          AND COALESCE(historical_financials_revision, 0) < ?`,
      args: [
        rawValue('roiPct'), rawValue('roiPct'),
        rawValue('profitUsd'), rawValue('profitUsd'),
        rawValue('apyPct'), rawValue('apyPct'),
        rawValue('stakeUsd'), rawValue('stakeUsd'),
        HISTORICAL_SCAN_FINANCIALS_REVISION,
        JSON.stringify(stableProvenance(row)),
        Number(row.id),
        Number(row.positive_arb_count),
        typeof row.best_roi_pct === 'number' ? row.best_roi_pct : null,
        typeof row.best_profit === 'number' ? row.best_profit : null,
        typeof row.apy_pct === 'number' ? row.apy_pct : null,
        typeof row.total_stake === 'number' ? row.total_stake : null,
        typeof row.raw_result === 'string' ? row.raw_result : null,
        typeof row.calculation_envelope === 'string' ? row.calculation_envelope : null,
        HISTORICAL_SCAN_FINANCIALS_REVISION,
      ],
    });
  }

  if (options.apply && statements.length > 0) {
    const applied = await client.batch(statements, 'write');
    counts.applied = applied.reduce((sum, item) => sum + Number(item.rowsAffected ?? 0), 0);
    counts.conflicted += statements.length - counts.applied;
  }

  return { revision: HISTORICAL_SCAN_FINANCIALS_REVISION, apply: options.apply, counts };
}
