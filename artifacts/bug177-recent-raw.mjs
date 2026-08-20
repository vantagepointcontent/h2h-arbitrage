import { createClient } from '@libsql/client';
const db = createClient({ url: 'file:data/edgefinder.db' });
try {
  const ids = [815818, 815804, 815803];
  const result = await db.execute({ sql: `SELECT id, best_roi_pct, best_profit, total_stake, raw_result FROM scan_results WHERE id IN (${ids.map(() => '?').join(',')})`, args: ids });
  for (const row of result.rows) {
    let raw = null;
    try { raw = JSON.parse(String(row.raw_result)); } catch {}
    console.log(JSON.stringify({ id: row.id, bestRoi: row.best_roi_pct, bestProfit: row.best_profit, totalStake: row.total_stake, arbs: raw?.allArbs?.map(({roiPct, expectedProfit, totalStake, strategy}) => ({roiPct, expectedProfit, totalStake, strategy})) }));
  }
} finally { db.close(); }
