import { createClient } from '@libsql/client';
import path from 'path';
import { createRequire } from 'module';

const dbPath = path.resolve(process.cwd(), 'data', 'edgefinder.db');
const c = createClient({ url: `file:${dbPath}` });
const require = createRequire(import.meta.url);
const persistence = require(path.resolve(process.cwd(), 'dist/lib/persistence.js'));

async function run() {
  await c.execute('PRAGMA busy_timeout = 5000');
  const rows = await c.execute(`SELECT id, raw_result, calculation_envelope
    FROM scan_results
    WHERE scan_status='completed' AND arb_valid=1 AND positive_arb_count>0
      AND best_profit=0 AND best_roi_pct>0
    ORDER BY id DESC LIMIT 100`);
  let recoverable = 0;
  let nonRecoverable = 0;
  for (const row of rows.rows) {
    const resolved = persistence.resolveHistoricalScanFinancials({
      id: row.id,
      positive_arb_count: 1,
      best_roi_pct: row.best_roi_pct,
      best_profit: row.best_profit,
      apy_pct: row.apy_pct,
      total_stake: row.total_stake,
      raw_result: row.raw_result,
      calculation_envelope: row.calculation_envelope,
    });
    if (resolved.fields.profitUsd.status === 'available') recoverable += 1;
    else nonRecoverable += 1;
  }
  console.log('sample size', rows.rows.length, 'recoverable', recoverable, 'nonRecoverable', nonRecoverable);
  await c.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
