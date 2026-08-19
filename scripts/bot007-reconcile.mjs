import { createClient } from '@libsql/client';

const db = createClient({ url: 'file:data/edgefinder.db' });
const rows = async (sql, args = []) => (await db.execute({ sql, args })).rows;

try {
  const [lastPosition] = await rows(`SELECT MAX(opened_at) AS opened_at FROM bot_positions`);
  const since = String(lastPosition?.opened_at ?? '1970-01-01T00:00:00.000Z');
  const summary = await rows(`SELECT
    COUNT(DISTINCT s.id) AS completed_positive_scans,
    COUNT(o.scan_id) AS candidate_decisions,
    SUM(CASE WHEN o.state IN ('eligible','accepted') THEN 1 ELSE 0 END) AS eligible_or_accepted,
    SUM(CASE WHEN json_type(o.details,'$.inputs.fees.kalshiFee') IN ('integer','real') AND json_type(o.details,'$.inputs.fees.pmFee') IN ('integer','real') THEN 1 ELSE 0 END) AS finite_fee_pairs,
    MIN(s.id) AS first_scan_id, MAX(s.id) AS last_scan_id
    FROM scan_results s
    LEFT JOIN bot_opportunity_decisions o ON o.scan_id=s.id
    WHERE s.scanned_at > ? AND s.positive_arb_count > 0`, [since]);
  const reasons = await rows(`SELECT o.reason_code, COUNT(*) AS count
    FROM bot_opportunity_decisions o JOIN scan_results s ON s.id=o.scan_id
    WHERE s.scanned_at > ? AND s.positive_arb_count > 0
    GROUP BY o.reason_code ORDER BY count DESC`, [since]);
  const terminal = await rows(`SELECT d.state,d.reason_code,COUNT(*) AS count
    FROM bot_scan_decisions d JOIN scan_results s ON s.id=d.scan_id
    WHERE s.scanned_at > ? AND s.positive_arb_count > 0
    GROUP BY d.state,d.reason_code ORDER BY count DESC`, [since]);
  const qualifying = await rows(`SELECT o.scan_id,o.candidate_index,o.market_id,o.outcome,o.strategy,o.roi_pct,o.state,o.reason_code,o.reason,o.details,s.scanned_at
    FROM bot_opportunity_decisions o JOIN scan_results s ON s.id=o.scan_id
    WHERE s.scanned_at > ? AND o.roi_pct >= 2
    ORDER BY o.scan_id DESC,o.candidate_index`, [since]);
  const mapped = qualifying.map((row) => {
    let details = null;
    try { details = JSON.parse(String(row.details)); } catch {}
    return {
      scanId: Number(row.scan_id), candidateIndex: Number(row.candidate_index), scannedAt: row.scanned_at,
      marketId: row.market_id, outcome: row.outcome, strategy: row.strategy, roiPct: Number(row.roi_pct),
      state: row.state, reasonCode: row.reason_code, reason: row.reason,
      operands: details?.inputs ?? null, configVersion: details?.configVersion ?? null,
    };
  });
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), lastPositionAt: since, summary: summary[0], reasons, terminal, roiAtLeastTwo: mapped }, null, 2));
} finally {
  db.close();
}
