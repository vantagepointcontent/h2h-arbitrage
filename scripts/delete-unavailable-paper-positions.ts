/// <reference types="node" />

/**
 * BUG-173 bounded deletion for the owner-approved unavailable paper cohort.
 *
 * Dry-run: npm run delete:unavailable-paper-positions -- --output=artifacts/bug173-deletion-dry-run.json
 * Apply:   npm run delete:unavailable-paper-positions -- --apply --manifest=artifacts/bug173-deletion-dry-run.json
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient, type Client, type InValue } from '@libsql/client';
import {
  applyPaperPositionDeletion,
  auditPaperPositionDeletion,
  type PaperPositionDeletionCohortRow,
  type PaperPositionDeletionPlan,
} from '../src/lib/bot-paper-position-deletion';

type Row = Record<string, unknown>;

function option(prefix: string): string | null {
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function sqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function hashRows(rows: readonly Row[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function tableExists(client: Client, table: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
    args: [table],
  });
  return result.rows.length > 0;
}

async function dependencyCounts(client: Client, plan: PaperPositionDeletionPlan): Promise<Record<string, number>> {
  const positionIds = [...plan.eligible, ...plan.alreadyDeleted].map((row) => row.positionId);
  const executionIds = [...plan.eligible, ...plan.alreadyDeleted].map((row) => row.executionId);
  const count = async (table: string, column: string, values: number[]): Promise<number> => {
    if (values.length === 0 || !await tableExists(client, table)) return 0;
    const result = await client.execute({
      sql: `SELECT COUNT(*) AS count FROM ${JSON.stringify(table)} WHERE ${JSON.stringify(column)} IN (${values.map(() => '?').join(',')})`,
      args: values,
    });
    return Number(result.rows[0]?.count ?? 0);
  };
  return {
    botPositions: await count('bot_positions', 'id', positionIds),
    settlementSummaries: await count('bot_position_settlements', 'position_id', positionIds),
    settlementLegs: await count('bot_position_settlement_legs', 'position_id', positionIds),
    entryRecoveryDecisions: await count('bot_entry_recovery_decisions', 'position_id', positionIds),
    entryRecoveryEvidence: await count('bot_entry_recovery_evidence', 'execution_id', executionIds),
  };
}

async function retainedPositionDigest(client: Client, cohort: PaperPositionDeletionCohortRow[]): Promise<string> {
  const ids = cohort.map((row) => row.positionId);
  const result = await client.execute({
    sql: `SELECT * FROM bot_positions ${ids.length ? `WHERE id NOT IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY id`,
    args: ids as InValue[],
  });
  return hashRows(result.rows as unknown as Row[]);
}

async function writeReport(file: string, report: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const dbPath = path.resolve(option('--db=') ?? process.env.H2H_SQLITE_PATH ?? 'data/edgefinder.db');
  const inventoryPath = path.resolve(option('--inventory=') ?? 'artifacts/bug173-inventory.json');
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const outputPath = path.resolve(option('--output=')
    ?? `artifacts/bug173-paper-deletion-${apply ? 'apply' : 'dry-run'}-${stamp}.json`);
  const backupPath = apply ? path.resolve(option('--backup=') ?? `backups/bug173-pre-delete-${stamp}.db`) : null;
  if (!existsSync(dbPath) || !existsSync(inventoryPath)) throw new Error('Database or BUG-173 inventory does not exist');

  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) as {
    candidates?: Array<{ positionId: unknown; executionId: unknown; currentExposureIdentity: unknown }>;
  };
  const cohort: PaperPositionDeletionCohortRow[] = (inventory.candidates ?? []).map((row) => ({
    positionId: Number(row.positionId),
    executionId: Number(row.executionId),
    exposureIdentity: String(row.currentExposureIdentity),
  }));
  if (cohort.length !== 88) throw new Error(`Expected exact BUG-172 unavailable cohort of 88; found ${cohort.length}`);

  const client = createClient({ url: `file:${dbPath}` });
  try {
    await client.execute('PRAGMA busy_timeout=30000');
    const integrityBefore = String((await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check);
    const foreignKeysBefore = (await client.execute('PRAGMA foreign_key_check')).rows.length;
    if (integrityBefore !== 'ok' || foreignKeysBefore !== 0) throw new Error('Pre-deletion SQLite integrity or FK check failed');
    const positionCountBefore = Number((await client.execute('SELECT COUNT(*) AS count FROM bot_positions')).rows[0]?.count ?? 0);
    const retainedDigestBefore = await retainedPositionDigest(client, cohort);
    const currentPlan = await auditPaperPositionDeletion(client, cohort);
    const dependenciesBefore = await dependencyCounts(client, currentPlan);

    if (!apply) {
      const report = {
        schemaVersion: 1,
        task: 'BUG-173',
        mode: 'dry-run',
        generatedAt: new Date().toISOString(),
        dbPath,
        inventoryPath,
        counts: currentPlan.counts,
        positionCountBefore,
        dependenciesBefore,
        retainedPositionDigestBefore: retainedDigestBefore,
        integrityBefore,
        foreignKeysBefore,
        zeroVenueCalls: true,
        reason: 'product_owner_deleted_unavailable_paper_positions',
        plan: currentPlan,
      };
      await writeReport(outputPath, report);
      console.log(JSON.stringify({ outputPath, counts: currentPlan.counts, sourceRevision: currentPlan.sourceRevision }, null, 2));
      return;
    }

    const manifestPath = option('--manifest=');
    if (!manifestPath) throw new Error('Apply requires --manifest=<verified dry-run report>');
    const manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8')) as {
      mode?: string; plan?: PaperPositionDeletionPlan; retainedPositionDigestBefore?: string;
    };
    if (manifest.mode !== 'dry-run' || !manifest.plan) throw new Error('Apply manifest is not a BUG-173 dry-run report');
    if (manifest.plan.counts.requested !== 88 || manifest.plan.counts.eligible !== 88
      || manifest.plan.counts.excluded !== 0 || manifest.plan.counts.missing !== 0) {
      throw new Error('Dry-run manifest did not prove all 88 rows eligible');
    }

    const expectedById = new Map(manifest.plan.eligible.map((row) => [row.positionId, row]));
    const allAlreadyDeleted = currentPlan.counts.alreadyDeleted === 88
      && currentPlan.counts.eligible === 0 && currentPlan.counts.excluded === 0 && currentPlan.counts.missing === 0;
    if (!allAlreadyDeleted) {
      if (currentPlan.counts.eligible !== 88 || currentPlan.counts.excluded !== 0 || currentPlan.counts.missing !== 0) {
        throw new Error('Production cohort no longer matches the verified dry-run manifest');
      }
      for (const row of currentPlan.eligible) {
        if (expectedById.get(row.positionId)?.revision !== row.revision) {
          throw new Error(`Position ${row.positionId} changed after dry-run manifest`);
        }
      }
    }

    let backupSha256: string | null = null;
    let applyResult = {
      positionsDeleted: 0, executionsTombstoned: 0, settlementRowsDeleted: 0,
      recoveryDecisionRowsDeleted: 0, recoveryEvidenceRowsDeleted: 0,
      reservationsDeleted: 0, alreadyDeleted: 88,
    };
    if (!allAlreadyDeleted) {
      await mkdir(path.dirname(backupPath!), { recursive: true });
      if (existsSync(backupPath!)) throw new Error(`Refusing to overwrite rollback backup: ${backupPath}`);
      await client.execute(`VACUUM INTO ${sqliteLiteral(backupPath!)}`);
      await chmod(backupPath!, 0o600);
      const backupClient = createClient({ url: `file:${backupPath}` });
      try {
        if (String((await backupClient.execute('PRAGMA integrity_check')).rows[0]?.integrity_check) !== 'ok') {
          throw new Error('Rollback backup integrity_check failed');
        }
      } finally {
        backupClient.close();
      }
      backupSha256 = await sha256File(backupPath!);
      applyResult = await applyPaperPositionDeletion(client, manifest.plan, {
        appliedAt: new Date().toISOString(),
        reason: 'product_owner_deleted_unavailable_paper_positions',
      });
    }

    const afterPlan = await auditPaperPositionDeletion(client, cohort);
    const dependenciesAfter = await dependencyCounts(client, afterPlan);
    const positionCountAfter = Number((await client.execute('SELECT COUNT(*) AS count FROM bot_positions')).rows[0]?.count ?? 0);
    const retainedDigestAfter = await retainedPositionDigest(client, cohort);
    const integrityAfter = String((await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check);
    const foreignKeysAfter = (await client.execute('PRAGMA foreign_key_check')).rows.length;
    if (afterPlan.counts.alreadyDeleted !== 88 || positionCountBefore - positionCountAfter !== applyResult.positionsDeleted
      || retainedDigestBefore !== retainedDigestAfter || integrityAfter !== 'ok' || foreignKeysAfter !== 0) {
      throw new Error('Post-deletion integrity verification failed');
    }

    const report = {
      schemaVersion: 1,
      task: 'BUG-173',
      mode: 'apply',
      generatedAt: new Date().toISOString(),
      dbPath,
      inventoryPath,
      manifestPath: path.resolve(manifestPath),
      sourceRevision: manifest.plan.sourceRevision,
      counts: {
        requested: 88,
        deleted: applyResult.positionsDeleted,
        alreadyDeleted: applyResult.alreadyDeleted,
        excluded: 0,
        errors: 0,
        remainingPositions: positionCountAfter,
      },
      applyResult,
      positionCountBefore,
      positionCountAfter,
      dependenciesBefore,
      dependenciesAfter,
      retainedPositionDigestBefore: retainedDigestBefore,
      retainedPositionDigestAfter: retainedDigestAfter,
      retainedPositionsUnchanged: retainedDigestBefore === retainedDigestAfter,
      integrityBefore,
      integrityAfter,
      foreignKeysBefore,
      foreignKeysAfter,
      backup: backupSha256 ? { path: backupPath, mode: '0600', sha256: backupSha256, integrity: 'ok' } : null,
      zeroVenueCalls: true,
      afterPlan,
    };
    await writeReport(outputPath, report);
    console.log(JSON.stringify({ outputPath, counts: report.counts, applyResult, backup: report.backup }, null, 2));
  } finally {
    client.close();
  }
}

await main();
