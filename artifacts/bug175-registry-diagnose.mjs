import { createClient } from '@libsql/client';
import path from 'node:path';

const db = createClient({ url: `file:${path.join(process.cwd(), 'data', 'edgefinder.db')}` });
const run = async (sql, args = []) => (await db.execute({ sql, args })).rows;
try {
  const registered = await run(`SELECT s.id, s.market_id, s.scanned_at, s.best_roi_pct,
      json_extract(candidate.value, '$.artist') AS outcome,
      json_extract(candidate.value, '$.strategy') AS strategy,
      json_extract(candidate.value, '$.kalshiTicker') AS kalshi_ticker,
      json_extract(candidate.value, '$.pmConditionId') AS pm_condition_id,
      json_extract(candidate.value, '$.propositionRelationship') IS NOT NULL AS has_relationship
    FROM scan_results s JOIN json_each(json_extract(s.raw_result, '$.allArbs')) candidate
    WHERE json_extract(candidate.value, '$.kalshiTicker') IN ('KXF1ACTION-2026-COL','KXHOUSERACE-MO03-26-D')
    ORDER BY s.id DESC LIMIT 20`);
  const sourceBreakdown = await run(`SELECT
      SUM(CASE WHEN json_extract(candidate.value, '$.propositionRelationship') IS NOT NULL THEN 1 ELSE 0 END) AS with_relationship,
      SUM(CASE WHEN json_extract(candidate.value, '$.relationshipVerified') = 1 THEN 1 ELSE 0 END) AS relationship_verified,
      COUNT(*) AS candidates
    FROM scan_results s JOIN json_each(json_extract(s.raw_result, '$.allArbs')) candidate
    WHERE s.scanned_at >= datetime('now','-24 hours')`);
  const postDeploy = await run(`SELECT
      COUNT(*) AS completed_scans,
      SUM(CASE WHEN json_extract(candidate.value, '$.propositionRelationship') IS NOT NULL THEN 1 ELSE 0 END) AS with_relationship,
      COUNT(candidate.key) AS candidates
    FROM scan_results s LEFT JOIN json_each(json_extract(s.raw_result, '$.allArbs')) candidate
    WHERE s.scan_status='completed' AND s.scanned_at >= '2026-08-20T09:35:11.646Z'`);
  console.log(JSON.stringify({ registered, sourceBreakdown, postDeploy }, null, 2));
} finally { db.close(); }
