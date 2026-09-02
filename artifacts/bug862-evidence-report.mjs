import { createClient } from '@libsql/client';
import { writeFile } from 'node:fs/promises';

const dbPath = process.env.H2H_SQLITE_PATH || 'data/edgefinder.db';
const client = createClient({ url: `file:${dbPath}` });
const rows = (await client.execute(`
  SELECT s.id AS scan_id, s.market_id, s.market_title, s.scanned_at, s.raw_result,
         d.candidate_index, d.outcome, d.strategy, d.reason, d.created_at AS decision_at,
         d.details AS decision_details
  FROM bot_opportunity_decisions d
  JOIN scan_results s ON s.id = d.scan_id
  WHERE d.reason LIKE '%Polymarket%executable quote is unavailable%'
     OR s.raw_result LIKE '%"reason":"below_minimum_order"%'
  ORDER BY s.id DESC, d.candidate_index ASC
  LIMIT 500
`)).rows;

const classify = (quote, depthUsd, price, minimumOrder) => {
  const shares = Number.isFinite(Number(depthUsd)) && Number(price) > 0 ? Number(depthUsd) / Number(price) : null;
  if (quote?.status === 'executable' && Number(minimumOrder) > 1) return 'venue-minimum-only rejection';
  if (quote?.reason === 'below_minimum_order' && shares != null && shares >= 1) return 'venue-minimum-only rejection';
  if (quote?.reason === 'authoritative_empty') return 'authoritative empty asks';
  if (quote?.reason === 'insufficient_depth') return 'insufficient one-share depth';
  if (quote?.reason === 'inactive_market') return 'inactive/closed contract';
  if (quote?.reason === 'stale_book') return 'stale book';
  if (quote?.reason === 'malformed_depth' || quote?.reason === 'malformed_level') return 'parser/normalization error';
  if (quote?.sourceFailureKind === 'rate_limited') return 'rate limit/upstream failure';
  if (quote?.sourceFailureKind === 'timeout') return 'timeout';
  if (quote?.reason === 'source_unavailable') return 'rate limit/upstream failure';
  if (quote == null && shares != null && shares >= 1 && Number(minimumOrder) > 1) return 'parser/normalization error';
  if (quote?.reason === 'empty_book') return 'cache miss/corruption';
  return 'cache miss/corruption';
};

const evidence = [];
for (const row of rows) {
  let raw;
  try { raw = JSON.parse(String(row.raw_result || '{}')); } catch { continue; }
  const arbs = Array.isArray(raw.allArbs) ? raw.allArbs : [];
  const arb = arbs.find((candidate) => String(candidate.artist) === String(row.outcome)
    && String(candidate.strategy) === String(row.strategy)) || arbs[row.candidate_index] || arbs[0];
  if (!arb) continue;
  const pmSide = String(arb.pmSide || (String(arb.strategy).toLowerCase().includes('yes pm') || String(arb.strategy).toLowerCase().includes('both sides') ? 'yes' : 'no')).toLowerCase();
  const quote = pmSide === 'yes' ? arb.pmYesExecutableQuote : arb.pmNoExecutableQuote;
  const tokenId = pmSide === 'yes' ? arb.pmYesTokenId : arb.pmNoTokenId;
  const depthUsd = pmSide === 'yes' ? arb.pmYesDepth : arb.pmNoDepth;
  const price = pmSide === 'yes' ? arb.pmYesPrice : arb.pmNoPrice;
  const minimumOrder = pmSide === 'yes' ? arb.pmYesMinOrderSize : arb.pmNoMinOrderSize;
  const availableShares = Number(price) > 0 && Number.isFinite(Number(depthUsd)) ? Number(depthUsd) / Number(price) : null;
  evidence.push({
    scanId: Number(row.scan_id), marketId: String(row.market_id), marketTitle: row.market_title,
    candidateIndex: Number(row.candidate_index), outcome: row.outcome, strategy: row.strategy,
    conditionId: arb.pmConditionId ?? null, tokenId: tokenId ?? null, outcomeSide: pmSide, orderSide: 'BUY',
    scanTimestamp: row.scanned_at, decisionTimestamp: row.decision_at,
    requestTimestamp: quote?.sourceAttemptedAt ?? quote?.depthTimestamp ?? row.scanned_at,
    providerHttpStatus: quote?.providerHttpStatus ?? null,
    rawAskLevelCount: quote?.rawAskLevelCount ?? null,
    bestAsk: Number.isFinite(Number(price)) ? Number(price) : null,
    availableShares: Number.isFinite(availableShares) ? availableShares : null,
    depthUsd: Number.isFinite(Number(depthUsd)) ? Number(depthUsd) : null,
    freshnessMs: quote?.sourceAttemptedAt && quote?.sourceObservedAt
      ? Date.parse(quote.sourceAttemptedAt) - Date.parse(quote.sourceObservedAt) : null,
    minimumOrderSize: Number.isFinite(Number(minimumOrder)) ? Number(minimumOrder) : null,
    quoteStatus: quote?.status ?? null, quoteReason: quote?.reason ?? null,
    failureCategory: classify(quote, depthUsd, price, minimumOrder),
    renderedReason: row.reason,
    historicalEvidenceLimit: quote?.providerHttpStatus == null || quote?.rawAskLevelCount == null
      ? 'Historical producer did not persist provider status/raw level count; values intentionally remain null.' : null,
  });
}

const selected = evidence.slice(0, Math.min(500, Math.max(100, evidence.length)));
const counts = Object.fromEntries([...new Set(selected.map((item) => item.failureCategory))]
  .sort().map((category) => [category, selected.filter((item) => item.failureCategory === category).length]));
const report = {
  generatedAt: new Date().toISOString(), database: dbPath, affectedRowsQueried: rows.length,
  classifiedCandidates: selected.length, uniqueScans: new Set(selected.map((item) => item.scanId)).size,
  uniqueMarkets: new Set(selected.map((item) => item.marketId)).size, counts,
  rootCause: 'quoteOneShareFromTopAsk applied Polymarket minimumOrderSize before walking canonical one-share depth, producing below_minimum_order with no VWAP even when the authoritative top ask had >=1 share. BotTrader persistence then discarded the non-executable quote as generic unavailable.',
  evidence: selected,
};
await writeFile('artifacts/bug862-evidence-report.json', `${JSON.stringify(report, null, 2)}\n`);
const lines = [
  '# BUG-862 timestamp-aligned affected-candidate evidence', '',
  `Generated: ${report.generatedAt}`,
  `Candidates: ${report.classifiedCandidates}; scans: ${report.uniqueScans}; markets: ${report.uniqueMarkets}`,
  '', '## Classification', ...Object.entries(counts).map(([key, value]) => `- ${key}: ${value}`),
  '', '## Root cause', report.rootCause, '',
  'Historical rows retain null provider/raw-level fields where the old producer did not persist them; the report does not fabricate those values.',
];
await writeFile('artifacts/bug862-evidence-report.md', `${lines.join('\n')}\n`);
console.log(JSON.stringify({ generatedAt: report.generatedAt, classifiedCandidates: report.classifiedCandidates, uniqueScans: report.uniqueScans, uniqueMarkets: report.uniqueMarkets, counts }, null, 2));
client.close();
