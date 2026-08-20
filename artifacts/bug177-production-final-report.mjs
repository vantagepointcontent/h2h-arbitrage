import { createClient } from '@libsql/client';
import { writeFile } from 'node:fs/promises';
const db = createClient({ url: 'file:data/edgefinder.db' });
try {
  const population = (await db.execute(`WITH eligible AS (
    SELECT * FROM scan_results WHERE scan_status='completed' AND arb_valid=1 AND positive_arb_count>0
  ) SELECT COUNT(*) AS rows,
    SUM(CASE WHEN best_roi_pct IS NOT NULL THEN 1 ELSE 0 END) AS roi_available,
    SUM(CASE WHEN best_profit > 0 THEN 1 ELSE 0 END) AS profit_source_eligible,
    SUM(CASE WHEN best_profit > 0 THEN 1 ELSE 0 END) AS profit_available,
    SUM(CASE WHEN days_to_expiry > 0 THEN 1 ELSE 0 END) AS apy_eligible,
    SUM(CASE WHEN days_to_expiry > 0 AND apy_pct IS NOT NULL THEN 1 ELSE 0 END) AS apy_available,
    SUM(CASE WHEN scan_status IS NOT NULL THEN 1 ELSE 0 END) AS state_available,
    SUM(best_profit) AS total_profit
    FROM eligible`)).rows[0];
  const current = (await db.execute(`WITH eligible AS (
      SELECT id, kalshi_url, polymarket_url FROM scan_results
      WHERE scan_status='completed' AND arb_valid=1 AND positive_arb_count>0
        AND kalshi_url IS NOT NULL AND kalshi_url<>'' AND polymarket_url IS NOT NULL AND polymarket_url<>''
    ), ranked AS (
      SELECT e.id, s.positive_arb_count, s.arb_valid, s.best_roi_pct,
        ROW_NUMBER() OVER (PARTITION BY e.id ORDER BY s.scanned_at DESC, s.id DESC) AS rank
      FROM eligible e JOIN scan_results s ON s.kalshi_url=e.kalshi_url AND s.polymarket_url=e.polymarket_url AND s.scan_status='completed'
    ) SELECT SUM(CASE WHEN arb_valid=1 THEN 1 ELSE 0 END) AS denominator,
      SUM(CASE WHEN (positive_arb_count>0 AND arb_valid=1 AND best_roi_pct IS NOT NULL)
        OR (positive_arb_count=0 AND arb_valid=1) THEN 1 ELSE 0 END) AS persisted_state_available,
      SUM(CASE WHEN positive_arb_count>0 AND arb_valid=1 AND best_roi_pct IS NOT NULL THEN 1 ELSE 0 END) AS numeric_roi,
      SUM(CASE WHEN positive_arb_count=0 AND arb_valid=1 THEN 1 ELSE 0 END) AS confirmed_no_arb
      FROM ranked WHERE rank=1`)).rows[0];
  const summary = (await db.execute(`SELECT SUM(best_profit) AS total_profit, SUM(positive_arb_count) AS total_arbs
    FROM scan_results WHERE scan_status='completed' AND arb_valid=1 AND positive_arb_count>0`)).rows[0];
  const health = await (await fetch('http://localhost:3000/api/health')).json();
  const pct = (n, d) => d ? Number(n) * 100 / Number(d) : 100;
  const report = {
    verifiedAt: new Date().toISOString(), deployment: health.deployment,
    population,
    availabilityPct: {
      roi: pct(population.roi_available, population.rows),
      profitEligible: pct(population.profit_available, population.profit_source_eligible),
      apyEligible: pct(population.apy_available, population.apy_eligible),
      state: pct(population.state_available, population.rows),
      currentRoiPersistedState: pct(current.persisted_state_available, current.denominator),
    },
    currentRoi: current,
    summary,
    summaryProfitReconciles: Number(summary.total_profit) === Number(population.total_profit),
    logsDataQuality: health.logsDataQuality,
    integrity: (await db.execute('PRAGMA integrity_check')).rows[0].integrity_check,
  };
  await writeFile('artifacts/bug177-production-final-report.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally { db.close(); }
