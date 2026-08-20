import { createClient } from '@libsql/client';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'data', 'edgefinder.db');
const c = createClient({ url: `file:${dbPath}` });

async function run() {
  await c.execute('PRAGMA busy_timeout = 5000');
  const rows = await c.execute(`SELECT id, calculation_envelope, raw_result
    FROM scan_results
    WHERE scan_status='completed' AND arb_valid=1 AND positive_arb_count>0
      AND best_profit=0 AND best_roi_pct>0
    ORDER BY id DESC LIMIT 20`);
  for (const row of rows.rows) {
    let env = null;
    let raw = null;
    try { env = JSON.parse(String(row.calculation_envelope)); } catch {}
    try { raw = JSON.parse(String(row.raw_result)); } catch {}
    const bestRaw = raw?.allArbs?.reduce((b, cand) => (!b || cand.roiPct > b.roiPct) ? cand : b, null);
    console.log('id', row.id, 'envStatus', env?.status, 'envNetPnl', env?.totals?.netPnlMicros, 'rawProfit', bestRaw?.expectedProfit, 'rawStake', bestRaw?.totalStake, 'rawStrategy', bestRaw?.strategy);
  }
  await c.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
