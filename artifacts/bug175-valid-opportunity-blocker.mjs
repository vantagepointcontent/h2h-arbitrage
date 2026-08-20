import { createClient } from '@libsql/client';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const registry = JSON.parse(await readFile(path.join(root, 'data', 'proposition-relationships.json'), 'utf8'));
const scale = 1_000_000;
const parsePriceMicros = (value) => {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const padded = `${fraction}000000`.slice(0, 6);
  const result = Number(whole) * scale + Number(padded);
  return Number.isSafeInteger(result) && result > 0 && result <= scale ? result : null;
};
const fetchJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
};
const checks = [];
for (const relationship of registry.relationships) {
  const kalshiLeg = relationship.legs.kalshi;
  const pmLeg = relationship.legs.polymarket;
  const [kalshiPayload, pmPayload, pmBook] = await Promise.all([
    fetchJson(`https://external-api.kalshi.com/trade-api/v2/markets/${encodeURIComponent(kalshiLeg.platformMarketId)}?depthP=Infinity`),
    fetchJson(`https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(pmLeg.platformMarketId)}`),
    fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(pmLeg.tokenId)}`),
  ]);
  const kalshiMarket = kalshiPayload.market;
  const pmMarket = pmPayload[0];
  const kalshiAskRaw = kalshiLeg.contractSide === 'yes' ? kalshiMarket.yes_ask_dollars : kalshiMarket.no_ask_dollars;
  const pmAskMicros = Math.min(...(Array.isArray(pmBook.asks) ? pmBook.asks : [])
    .map((level) => parsePriceMicros(level.price))
    .filter((value) => value != null));
  const kalshiAskMicros = parsePriceMicros(kalshiAskRaw);
  if (kalshiAskMicros == null || !Number.isSafeInteger(pmAskMicros)) throw new Error(`Missing executable ask for ${relationship.humanLabel}`);
  const grossCostMicros = kalshiAskMicros + pmAskMicros;
  checks.push({
    humanLabel: relationship.humanLabel,
    exactIdentity: {
      kalshiTicker: kalshiLeg.platformMarketId,
      kalshiSide: kalshiLeg.contractSide,
      pmConditionId: pmLeg.platformMarketId,
      pmTokenId: pmLeg.tokenId,
      pmSide: pmLeg.contractSide,
    },
    authority: {
      kalshiQuestion: kalshiMarket.title,
      kalshiRules: kalshiMarket.rules_primary,
      pmQuestion: pmMarket.question,
      pmDescription: pmMarket.description,
    },
    executableAsks: { kalshiMicros: kalshiAskMicros, polymarketMicros: pmAskMicros },
    grossCostMicros,
    grossEdgeMicrosBeforeFees: scale - grossCostMicros,
    qualifiesBeforeFees: grossCostMicros < scale,
    blocker: grossCostMicros >= scale
      ? 'Exact reviewed legs cost at least the guaranteed payout before fees'
      : null,
  });
}
const db = createClient({ url: `file:${path.join(root, 'data', 'edgefinder.db')}` });
let postDeploy;
try {
  postDeploy = (await db.execute(`SELECT COUNT(DISTINCT s.id) AS completed_scans,
      COUNT(candidate.key) AS persisted_candidates,
      SUM(CASE WHEN json_extract(candidate.value, '$.roiPct') >= 2 THEN 1 ELSE 0 END) AS candidates_at_or_above_threshold,
      SUM(CASE WHEN json_extract(candidate.value, '$.roiPct') >= 2
        AND json_extract(candidate.value, '$.propositionRelationship') IS NOT NULL THEN 1 ELSE 0 END) AS reviewed_candidates_at_or_above_threshold
    FROM scan_results s LEFT JOIN json_each(json_extract(s.raw_result, '$.allArbs')) candidate
    WHERE s.scan_status='completed' AND s.scanned_at >= '2026-08-20T09:35:11.646Z'`)).rows[0];
} finally { db.close(); }
const report = {
  revision: 1,
  generatedAt: new Date().toISOString(),
  deployment: { commit: '4f32696dadbcea709773aed7142f6ba40822e96c', buildId: 'PtdzAfrx6ExTPLo7U3xk0' },
  policy: 'Read-only production verification. No unreviewed relationship was promoted and no stale trade was replayed.',
  postDeploy,
  reviewedRegistryLiveChecks: checks,
  conclusion: checks.every((check) => !check.qualifiesBeforeFees)
    ? 'No server-reviewed exact relationship currently has a positive executable gross edge; fees can only worsen these costs.'
    : 'At least one reviewed exact relationship has a positive pre-fee edge and requires full execution-path verification.',
};
const outputPath = path.join(root, 'artifacts', 'bug175-valid-opportunity-blocker.json');
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, postDeploy, checks: checks.map(({ humanLabel, grossCostMicros, grossEdgeMicrosBeforeFees, qualifiesBeforeFees, blocker }) => ({ humanLabel, grossCostMicros, grossEdgeMicrosBeforeFees, qualifiesBeforeFees, blocker })), conclusion: report.conclusion }, null, 2));
