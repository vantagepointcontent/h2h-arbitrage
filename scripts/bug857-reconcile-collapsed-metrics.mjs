#!/usr/bin/env node
import { createClient } from '@libsql/client';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSqliteBackup } from './safe-sqlite-backup.mjs';

const LEGACY_REASON = 'no_positive_candidate_persists_prior:%';
const RECOVERY_REASON = 'collapsed_no_positive_backfilled';

function value(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function parseArgs(argv) {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const dbPath = path.resolve(value(argv, '--db') ?? process.env.H2H_SQLITE_PATH ?? 'data/edgefinder.db');
  const apply = argv.includes('--apply');
  return {
    apply,
    dbPath,
    backupPath: path.resolve(value(argv, '--backup') ?? `backups/bug857-edgefinder-${stamp}.db`),
    outputPath: path.resolve(value(argv, '--output') ?? `artifacts/bug857-reconciliation-${apply ? 'apply' : 'dry-run'}-${stamp}.json`),
  };
}

const eligibleSql = `
  SELECT id,
         scan_publication_generation AS revision,
         json_extract(last_scan_result, '$.scannedAt') AS scanned_at,
         json_extract(last_scan_result, '$.matchError') AS prior_reason,
         json_array_length(COALESCE(json_extract(last_scan_result, '$.allArbs'), '[]')) AS candidate_count
  FROM saved_markets
  WHERE json_valid(last_scan_result)
    AND json_extract(last_scan_result, '$.matchStatus') = 'unavailable'
    AND json_extract(last_scan_result, '$.matchError') LIKE ?
    AND CAST(json_extract(last_scan_result, '$.publicationGeneration') AS INTEGER) = scan_publication_generation
  ORDER BY id`;

async function census(client) {
  const statuses = await client.execute(`
    SELECT COALESCE(json_extract(last_scan_result, '$.matchStatus'), 'never_scanned') AS status,
           COUNT(*) AS count
    FROM saved_markets GROUP BY status ORDER BY status`);
  const reasons = await client.execute(`
    SELECT CASE
             WHEN json_extract(last_scan_result, '$.matchError') LIKE 'no_positive_candidate_persists_prior:%'
               THEN 'no_positive_candidate_persists_prior'
             WHEN json_extract(last_scan_result, '$.matchError') LIKE 'executable_candidate_unavailable:%'
               THEN 'executable_candidate_unavailable'
             WHEN json_extract(last_scan_result, '$.matchError') IS NULL THEN 'none'
             ELSE 'other'
           END AS reason,
           COUNT(*) AS count
    FROM saved_markets GROUP BY reason ORDER BY reason`);
  return {
    statuses: Object.fromEntries(statuses.rows.map((row) => [String(row.status), Number(row.count)])),
    reasons: Object.fromEntries(reasons.rows.map((row) => [String(row.reason), Number(row.count)])),
  };
}

async function applyRecovery(client, expectedIds) {
  const tx = await client.transaction('write');
  try {
    const current = await tx.execute({ sql: eligibleSql, args: [LEGACY_REASON] });
    const currentIds = current.rows.map((row) => String(row.id));
    if (JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) {
      throw new Error('Eligible row set changed after the backup/census fence; refusing stale reconciliation');
    }

    await tx.execute({
      sql: `INSERT INTO saved_market_metric_alerts
              (market_id, detected_at, reason, source_revision, reconciled)
            SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, scan_publication_generation, 1
            FROM saved_markets
            WHERE json_valid(last_scan_result)
              AND json_extract(last_scan_result, '$.matchStatus') = 'unavailable'
              AND json_extract(last_scan_result, '$.matchError') LIKE ?
              AND CAST(json_extract(last_scan_result, '$.publicationGeneration') AS INTEGER) = scan_publication_generation
              AND NOT EXISTS (
                SELECT 1 FROM saved_market_metric_alerts alert
                WHERE alert.market_id = saved_markets.id
                  AND alert.reason = ?
                  AND alert.source_revision = saved_markets.scan_publication_generation
              )`,
      args: [RECOVERY_REASON, LEGACY_REASON, RECOVERY_REASON],
    });

    const updated = await tx.execute({
      sql: `UPDATE saved_markets SET
              last_scan_result = json_remove(json_set(last_scan_result,
                '$.bestRoiPct', 0,
                '$.bestProfit', 0,
                '$.strategy', 'No arb',
                '$.arbType', json('null'),
                '$.matchStatus', 'confirmed_zero'),
                '$.matchError', '$.calculationEnvelope'),
              canonical_apy_pct = NULL,
              canonical_apy_unavailable_reason = 'no_canonical_arbitrage',
              canonical_apy_outcome = NULL,
              canonical_apy_observed_at = json_extract(last_scan_result, '$.scannedAt'),
              canonical_apy_source = 'full_scan',
              canonical_apy_revision = scan_publication_generation,
              canonical_current_roi_pct = NULL,
              canonical_current_profit = NULL,
              canonical_current_strategy = 'No arb',
              canonical_current_days_to_expiry = NULL,
              canonical_current_expiry_at = NULL,
              canonical_current_revision = scan_publication_generation
            WHERE json_valid(last_scan_result)
              AND json_extract(last_scan_result, '$.matchStatus') = 'unavailable'
              AND json_extract(last_scan_result, '$.matchError') LIKE ?
              AND CAST(json_extract(last_scan_result, '$.publicationGeneration') AS INTEGER) = scan_publication_generation`,
      args: [LEGACY_REASON],
    });
    if (Number(updated.rowsAffected) !== expectedIds.length) {
      throw new Error(`Expected to reconcile ${expectedIds.length} row(s), updated ${Number(updated.rowsAffected)}`);
    }
    await tx.commit();
    return Number(updated.rowsAffected);
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = createClient({ url: `file:${options.dbPath}` });
  try {
    await client.execute('PRAGMA busy_timeout = 5000');
    const integrity = await client.execute('PRAGMA integrity_check');
    if (String(integrity.rows[0]?.integrity_check ?? '') !== 'ok') {
      throw new Error('Source SQLite integrity check failed; reconciliation aborted');
    }
    const before = await census(client);
    const eligible = await client.execute({ sql: eligibleSql, args: [LEGACY_REASON] });
    const candidates = eligible.rows.map((row) => ({
      id: String(row.id),
      revision: Number(row.revision),
      scannedAt: row.scanned_at == null ? null : String(row.scanned_at),
      priorReason: String(row.prior_reason),
      candidateCount: Number(row.candidate_count),
    }));
    const report = {
      generatedAt: new Date().toISOString(),
      mode: options.apply ? 'apply' : 'dry-run',
      database: options.dbPath,
      eligibility: {
        reasonPrefix: 'no_positive_candidate_persists_prior',
        rationale: 'Only rows produced by the retired successful-zero preservation branch are authoritative enough to reclassify. executable_candidate_unavailable rows remain untouched because no completed replacement payload was persisted.',
      },
      before,
      eligibleCount: candidates.length,
      candidates,
      backup: null,
      reconciledCount: 0,
      after: before,
    };

    if (options.apply) {
      report.backup = await createSqliteBackup({ source: options.dbPath, destination: options.backupPath });
      report.reconciledCount = await applyRecovery(client, candidates.map((candidate) => candidate.id));
      report.after = await census(client);
    }

    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 });
    process.stdout.write(`${JSON.stringify({ output: options.outputPath, eligible: report.eligibleCount, reconciled: report.reconciledCount, backup: report.backup?.destination ?? null })}\n`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`BUG-857 reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
