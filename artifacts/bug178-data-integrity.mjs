import { createClient } from '@libsql/client';
import { readFile, writeFile } from 'node:fs/promises';
import { projectCanonicalArbClassification } from '../src/lib/arb-types.ts';

const client = createClient({ url: 'file:data/edgefinder.db' });
const strategyType = `CASE
  WHEN strategy GLOB 'Buy YES both sides: Kalshi ?* + PM ?*'
    OR strategy GLOB 'Buy YES both sides: Kalshi ?* + Polymarket ?*' THEN 'cross'
  WHEN strategy GLOB 'Same-platform YES+NO Kalshi: ?*'
    OR strategy GLOB 'Same-platform YES+NO Polymarket: ?*' THEN 'internal'
  WHEN strategy = 'Buy YES Kalshi + NO PM'
    OR strategy = 'Buy YES PM + NO Kalshi'
    OR strategy = 'direct' THEN 'direct'
END`;
const canonicalType = `CASE
  WHEN typeof(positive_arb_count) = 'integer'
    AND positive_arb_count > 0
    AND positive_arb_count <= 9007199254740991
    AND NULLIF(arb_invalidation_reason, '') IS NULL
    AND arb_valid IS NOT 0
    AND (${strategyType}) IS NOT NULL
    AND (
      arb_type IS NULL
      OR arb_type NOT IN ('direct', 'cross', 'internal')
      OR arb_type = (${strategyType})
    )
    THEN (${strategyType})
END`;
const canonicalCount = `CASE
  WHEN (${canonicalType}) IN ('direct', 'cross', 'internal') THEN positive_arb_count
  ELSE 0
END`;

const quickCheck = await client.execute('PRAGMA quick_check');
const counts = await client.execute(`SELECT
  COUNT(*) AS scan_rows,
  SUM(CASE WHEN strategy = 'No arb' AND (arb_type IS NOT NULL OR arb_valid = 0) THEN 1 ELSE 0 END) AS stale_no_arb_evidence_rows,
  SUM(CASE WHEN positive_arb_count = 0 AND arb_type IS NOT NULL THEN 1 ELSE 0 END) AS stale_non_opportunity_type_rows
FROM scan_results`);
const countRow = counts.rows[0];
const canonical = { totalArbs: 0, direct: 0, cross: 0, internal: 0 };
const sqlProjectionMismatchSamples = [];
let sqlProjectionMismatches = 0;
let afterId = 0;
for (;;) {
  const page = await client.execute({
    sql: `SELECT id, strategy, arb_type, arb_valid, arb_invalidation_reason, positive_arb_count,
            (${canonicalType}) AS sql_type, (${canonicalCount}) AS sql_count
          FROM scan_results WHERE id > ? ORDER BY id LIMIT 5000`,
    args: [afterId],
  });
  if (page.rows.length === 0) break;
  for (const row of page.rows) {
    const projection = projectCanonicalArbClassification(row);
    canonical.totalArbs += projection.positiveArbCount;
    if (projection.arbType) canonical[projection.arbType] += projection.positiveArbCount;
    const sqlType = typeof row.sql_type === 'string' ? row.sql_type : null;
    const sqlCount = Number(row.sql_count ?? 0);
    if (sqlType !== projection.arbType || sqlCount !== projection.positiveArbCount) {
      sqlProjectionMismatches += 1;
      if (sqlProjectionMismatchSamples.length < 10) {
        sqlProjectionMismatchSamples.push({
          id: Number(row.id),
          sql: { arbType: sqlType, positiveArbCount: sqlCount },
          canonical: projection,
        });
      }
    }
  }
  afterId = Number(page.rows.at(-1).id);
}

const files = {};
for (const path of ['data/saved-markets.json', 'data/manual-matches.json', 'data/predictionhunt-markets.json']) {
  const bytes = await readFile(path);
  const parsed = JSON.parse(bytes.toString('utf8'));
  files[path] = {
    bytes: bytes.length,
    topLevel: Array.isArray(parsed) ? 'array' : typeof parsed,
    records: Array.isArray(parsed) ? parsed.length : null,
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  quickCheck: quickCheck.rows,
  scanRows: Number(countRow.scan_rows),
  canonical,
  reconciles: canonical.totalArbs === canonical.direct + canonical.cross + canonical.internal,
  sqlProjectionParity: {
    mismatches: sqlProjectionMismatches,
    samples: sqlProjectionMismatchSamples,
  },
  immutableEvidence: {
    staleNoArbEvidenceRows: Number(countRow.stale_no_arb_evidence_rows),
    staleNonOpportunityTypeRows: Number(countRow.stale_non_opportunity_type_rows),
    rewritten: false,
    correctionMode: 'canonical read projection',
  },
  files,
};
await writeFile('artifacts/bug178-data-integrity.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
client.close();
