import { createClient } from '@libsql/client';

const client = createClient({ url: `file:${process.env.H2H_SQLITE_PATH || 'data/edgefinder.db'}` });
try {
  const summary = await client.execute(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN scan_status = 'completed' AND arb_valid = 1 AND positive_arb_count > 0 THEN 1 ELSE 0 END) AS eligible,
    SUM(CASE WHEN scan_status = 'completed' AND arb_valid = 1 AND positive_arb_count > 0 AND best_roi_pct IS NULL THEN 1 ELSE 0 END) AS roi_null,
    SUM(CASE WHEN scan_status = 'completed' AND arb_valid = 1 AND positive_arb_count > 0 AND (best_profit IS NULL OR best_profit = 0) THEN 1 ELSE 0 END) AS profit_missing,
    SUM(CASE WHEN scan_status = 'completed' AND arb_valid = 1 AND positive_arb_count > 0 AND apy_pct IS NULL THEN 1 ELSE 0 END) AS apy_null,
    SUM(CASE WHEN scan_status = 'completed' AND arb_valid = 1 AND positive_arb_count > 0 AND (total_stake IS NULL OR total_stake = 0) THEN 1 ELSE 0 END) AS stake_missing,
    SUM(CASE WHEN scan_status = 'completed' AND arb_valid = 1 AND positive_arb_count > 0 AND (kalshi_url IS NULL OR kalshi_url = '' OR polymarket_url IS NULL OR polymarket_url = '') THEN 1 ELSE 0 END) AS identity_missing,
    SUM(CASE WHEN scan_status = 'completed' AND arb_valid = 1 AND positive_arb_count > 0 THEN best_profit ELSE 0 END) AS eligible_profit
  FROM scan_results`);
  const statuses = await client.execute(`SELECT scan_status, COUNT(*) AS count FROM scan_results GROUP BY scan_status ORDER BY scan_status`);
  const recent = await client.execute(`SELECT id, market_id, scan_status, arb_valid, positive_arb_count, best_roi_pct, best_profit, apy_pct, total_stake, calculation_envelope FROM scan_results WHERE positive_arb_count > 0 ORDER BY scanned_at DESC, id DESC LIMIT 5`);
  process.stdout.write(`${JSON.stringify({ summary: summary.rows[0], statuses: statuses.rows, recent: recent.rows }, null, 2)}\n`);
} finally {
  client.close();
}
