import { createClient } from '@libsql/client';

async function main() {
  const client = createClient({ url: `file:${process.cwd()}/data/edgefinder.db` });
  const triggers = await client.execute(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name IN ('saved_market_metric_revision_guard', 'saved_market_apy_invariant_guard')
    ORDER BY name`);
  const invalid = await client.execute(`SELECT COUNT(*) AS count FROM saved_markets
    WHERE canonical_apy_pct IS NOT NULL AND (
      canonical_current_roi_pct IS NULL OR canonical_current_roi_pct <= 0
      OR canonical_current_strategy IS NULL OR canonical_current_strategy = 'No arb'
      OR canonical_current_days_to_expiry IS NULL OR canonical_current_days_to_expiry <= 0
      OR canonical_apy_revision IS NULL OR canonical_current_revision IS NULL
      OR canonical_apy_revision <> canonical_current_revision
    )`);
  console.log(JSON.stringify({ triggers: triggers.rows, invalid: Number(invalid.rows[0]?.count ?? 0) }, null, 2));
  client.close();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
