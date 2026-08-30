import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import registryJson from '../data/proposition-relationships.json';
import { migrateLegacyRegistryToMatchedMarkets } from '../src/lib/matched-market-mapping';


const sourceDb = process.env.H2H_SQLITE_PATH || path.join(process.cwd(), 'data', 'edgefinder.db');
const apply = process.argv.includes('--apply');
const outputArg = process.argv.find((item) => item.startsWith('--output='));
const outputPath = outputArg?.slice('--output='.length)
  || path.join(process.cwd(), 'artifacts', `bug860-migration-${apply ? 'apply' : 'dry-run'}.json`);

function selectedSides(strategy: string): { kalshiSide: 'yes' | 'no'; pmSide: 'yes' | 'no' } | null {
  const value = strategy.toLowerCase();
  if (value.includes('yes kalshi') && value.includes('no pm')) return { kalshiSide: 'yes', pmSide: 'no' };
  if (value.includes('no kalshi') && value.includes('yes pm')) return { kalshiSide: 'no', pmSide: 'yes' };
  if (value.startsWith('buy yes both sides:')) return { kalshiSide: 'yes', pmSide: 'yes' };
  return null;
}

function parsedDetails(value: unknown): Record<string, unknown> {
  try { return typeof value === 'string' ? JSON.parse(value) : {}; } catch { return {}; }
}

type MigrationStatement = string | { sql: string; args: Array<string | number | null> };

async function executeWithBusyRetry(client: Client, statement: MigrationStatement) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await (typeof statement === 'string' ? client.execute(statement) : client.execute(statement));
    } catch (error) {
      if (!String(error).includes('SQLITE_BUSY') || attempt >= 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function auditHistoricalDecisions(client: Client) {
  await executeWithBusyRetry(client, `CREATE TABLE IF NOT EXISTS bot_matched_market_mapping_audit (
    scan_id INTEGER NOT NULL,
    candidate_index INTEGER NOT NULL,
    matched_market_id TEXT NOT NULL,
    classification TEXT NOT NULL CHECK(classification IN ('false_duplicate_gate_rejection','genuinely_rejected_mapping','missing_or_unverified_mapping','insufficient_historical_identifiers')),
    mapping_id TEXT,
    exact_ids_json TEXT NOT NULL,
    previous_reason TEXT NOT NULL,
    audited_at TEXT NOT NULL,
    PRIMARY KEY(scan_id,candidate_index)
  )`);
  const rows = await client.execute(`SELECT scan_id,candidate_index,market_id,strategy,reason,details
    FROM bot_opportunity_decisions WHERE lower(reason) LIKE '%canonical proposition registry%'
    ORDER BY scan_id,candidate_index`);
  const counts = {
    total: rows.rows.length,
    falseDuplicateGateRejection: 0,
    genuinelyRejectedMapping: 0,
    missingOrUnverifiedMapping: 0,
    insufficientHistoricalIdentifiers: 0,
  };
  for (const row of rows.rows) {
    const details = parsedDetails(row.details);
    const inputs = details.inputs && typeof details.inputs === 'object' ? details.inputs as Record<string, unknown> : {};
    const ids = inputs.exactIds && typeof inputs.exactIds === 'object' ? inputs.exactIds as Record<string, unknown> : {};
    const sides = selectedSides(String(row.strategy));
    const kalshiTicker = typeof ids.kalshiTicker === 'string' ? ids.kalshiTicker.trim().toUpperCase() : '';
    const pmConditionId = typeof ids.pmConditionId === 'string' ? ids.pmConditionId.trim().toLowerCase() : '';
    const pmTokenId = sides?.pmSide === 'yes'
      ? (typeof ids.pmYesTokenId === 'string' ? ids.pmYesTokenId.trim() : '')
      : (typeof ids.pmNoTokenId === 'string' ? ids.pmNoTokenId.trim() : '');
    let classification: 'false_duplicate_gate_rejection' | 'genuinely_rejected_mapping' | 'missing_or_unverified_mapping' | 'insufficient_historical_identifiers';
    let mappingId: string | null = null;
    if (!sides || !kalshiTicker || !pmConditionId || !pmTokenId) {
      classification = 'insufficient_historical_identifiers';
      counts.insufficientHistoricalIdentifiers += 1;
    } else {
      const exact = await client.execute({
        sql: `SELECT mapping_id FROM matched_market_mappings WHERE matched_market_id=? AND kalshi_ticker=?
          AND pm_condition_id=? AND pm_token_id=? AND kalshi_side=? AND pm_side=? LIMIT 1`,
        args: [String(row.market_id), kalshiTicker, pmConditionId, pmTokenId, sides.kalshiSide, sides.pmSide],
      });
      if (exact.rows[0]) {
        classification = 'false_duplicate_gate_rejection';
        mappingId = String(exact.rows[0].mapping_id);
        counts.falseDuplicateGateRejection += 1;
      } else {
        const rejected = await client.execute({
          sql: `SELECT rejection_id FROM matched_market_mapping_rejections WHERE kalshi_ticker=? AND pm_condition_id=?
            AND pm_token_id=? AND kalshi_side=? AND pm_side=? LIMIT 1`,
          args: [kalshiTicker, pmConditionId, pmTokenId, sides.kalshiSide, sides.pmSide],
        });
        if (rejected.rows[0]) {
          classification = 'genuinely_rejected_mapping';
          mappingId = String(rejected.rows[0].rejection_id);
          counts.genuinelyRejectedMapping += 1;
        } else {
          classification = 'missing_or_unverified_mapping';
          counts.missingOrUnverifiedMapping += 1;
        }
      }
    }
    await executeWithBusyRetry(client, {
      sql: `INSERT INTO bot_matched_market_mapping_audit
        (scan_id,candidate_index,matched_market_id,classification,mapping_id,exact_ids_json,previous_reason,audited_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(scan_id,candidate_index) DO UPDATE SET classification=excluded.classification,
          mapping_id=excluded.mapping_id,exact_ids_json=excluded.exact_ids_json,previous_reason=excluded.previous_reason,audited_at=excluded.audited_at`,
      args: [Number(row.scan_id), Number(row.candidate_index), String(row.market_id), classification, mappingId,
        JSON.stringify({ kalshiTicker, pmConditionId, pmTokenId, ...sides }), String(row.reason), new Date().toISOString()],
    });
  }
  return counts;
}

let workingDb = sourceDb;
let temporaryDirectory: string | null = null;
if (!apply) {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bug860-migration-'));
  workingDb = path.join(temporaryDirectory, 'edgefinder.db');
  // A file/WAL copy can capture different generations while production is
  // writing. SQLite's online VACUUM INTO produces one coherent snapshot.
  const source = createClient({ url: `file:${sourceDb}` });
  try {
    await source.execute(`VACUUM INTO '${workingDb.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
}
const client = createClient({ url: `file:${workingDb}` });
try {
  await client.execute('PRAGMA busy_timeout=10000');
  const migration = await migrateLegacyRegistryToMatchedMarkets(
    client,
    registryJson as Parameters<typeof migrateLegacyRegistryToMatchedMarkets>[1],
  );
  const historicalAudit = await auditHistoricalDecisions(client);
  const report = {
    schemaVersion: 1,
    mode: apply ? 'apply' : 'dry-run',
    sourceDatabase: sourceDb,
    generatedAt: new Date().toISOString(),
    migration,
    historicalAudit,
    safety: {
      historicalDecisionsReplayed: 0,
      historicalTradesPlaced: 0,
      eligibilityRequiresFreshNaturalScan: true,
    },
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  client.close();
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
