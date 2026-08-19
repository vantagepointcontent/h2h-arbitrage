import fs from 'node:fs';
import path from 'node:path';

const sourcePath = process.argv[2] ?? '/home/scott/.hermes/cache/terminal-output/out-1787150530-3234082-5550.log';
const outputPath = process.argv[3] ?? path.join(import.meta.dirname, 'res848-candidate-gates.json');
const raw = fs.readFileSync(sourcePath, 'utf8');
const marker = raw.indexOf('\n__HERMES_CWD_');
const evidence = JSON.parse(marker >= 0 ? raw.slice(0, marker) : raw);
const finiteNonNegative = (value) => Number.isFinite(value) && value >= 0;
const status = (passed, evidenceText) => ({ status: passed ? 'pass' : 'fail', evidence: evidenceText });

const candidates = evidence.latest.map((row) => {
  const inputs = row.details?.inputs ?? {};
  const evaluation = row.details?.evaluation ?? {};
  const fees = inputs.fees ?? {};
  const constraints = inputs.venueConstraints ?? {};
  const selectedPmMinimum = row.strategy.includes('NO PM') ? constraints.pmNoMinimumOrder : constraints.pmYesMinimumOrder;
  const feePairFinite = finiteNonNegative(fees.kalshiFee) && finiteNonNegative(fees.pmFee);
  const fiveShareAuthority = feePairFinite && /buy 5 @/.test(fees.kalshiFeeDetails ?? '') && /buy 5 @/.test(fees.pmFeeDetails ?? '');
  const matchedDepth = Number(evaluation.sharesK) >= 5 && Number(evaluation.sharesP) >= 5;
  const reason = String(row.reason ?? '');
  const canonical = !reason.includes('absent from the server-owned canonical proposition registry');
  const roiPass = Number(row.roi_pct) >= Number(row.details?.thresholds?.minRoiPct ?? 2);
  const apyActive = row.details?.thresholds?.selectionMethod !== 'roi' && Number(row.details?.thresholds?.minApyPct ?? 0) > 0;
  const scanPassed = row.state === 'eligible' || row.state === 'accepted';
  return {
    source: { scanId: Number(row.scan_id), candidateIndex: Number(row.candidate_index), marketId: row.market_id, outcome: row.outcome, strategy: row.strategy, updatedAt: row.updated_at },
    terminal: { state: row.state, reasonCode: row.reason_code, reason: row.reason },
    inputs,
    gates: {
      authoritativeFeePresence: status(inputs.fees != null, inputs.fees ? 'Persisted candidate audit contains fees' : 'No persisted fee object'),
      finiteNonNegativeFiveShareFees: status(fiveShareAuthority, feePairFinite ? 'Finite non-negative fees present; one or both detail strings do not explicitly identify quantity 5' : 'Missing/non-finite/negative fee'),
      selectedVenueMinimumQuantity: status(Number(selectedPmMinimum) === 5, `Selected Polymarket minimum=${selectedPmMinimum ?? 'missing'}; evidence contract requested 5 shares`),
      matchedExecutableDepth: status(matchedDepth, `sharesK=${evaluation.sharesK ?? 'missing'}, sharesP=${evaluation.sharesP ?? 'missing'}, requested=5`),
      netProfitabilityAfterFees: status(Number(row.roi_pct) > 0, `Persisted fee-inclusive ROI=${row.roi_pct}%`),
      activeRoiThreshold: status(roiPass, `ROI=${row.roi_pct}% versus min=${row.details?.thresholds?.minRoiPct ?? 2}%`),
      activeApyThreshold: apyActive ? status(Number(row.apy_pct ?? 0) >= Number(row.details.thresholds.minApyPct), `APY=${row.apy_pct ?? 0}%`) : { status: 'not_applicable', evidence: 'selectionMethod=roi; APY threshold inactive' },
      freshness: { status: 'pass_at_capture', evidence: `Candidate updated ${row.updated_at}; audit generated ${evidence.generatedAt}` },
      canonicalPropositionIdentity: status(canonical, canonical ? 'No canonical-identity rejection recorded' : 'Server-owned canonical proposition registry has no exact selected-contract pair'),
      malformedOrUnsupportedShape: status(Boolean(inputs.exactIds?.kalshiTicker && inputs.exactIds?.pmConditionId && row.strategy), 'Persisted row parsed into a candidate decision with exact IDs and strategy'),
      currentRevalidation: scanPassed ? { status: 'not_recorded', evidence: 'Recovered extract does not contain a later revalidation event' } : { status: 'not_reached', evidence: 'Terminal scan-time rejection' },
      duplicateOrAlreadyClaimed: { status: 'not_reached', evidence: 'Reservation follows scan eligibility' },
      riskAndDailyLimits: { status: 'not_reached', evidence: 'Risk/daily-limit checks follow scan eligibility and execution request construction' },
      executionValidation: { status: 'not_reached', evidence: 'No candidate in this recovered population passed scan eligibility; no live execution attempted' },
    },
    additionalFailedGates: [
      ...(!fiveShareAuthority ? ['finite_non_negative_five_share_fees'] : []),
      ...(Number(selectedPmMinimum) !== 5 ? ['selected_venue_minimum_quantity'] : []),
      ...(!matchedDepth ? ['matched_executable_depth'] : []),
      ...(!(Number(row.roi_pct) > 0) ? ['net_profitability_after_fees'] : []),
      ...(!roiPass ? ['active_roi_threshold'] : []),
      ...(!canonical ? ['canonical_proposition_identity'] : []),
    ],
  };
});

const count = (field, state = 'fail') => candidates.filter((candidate) => candidate.gates[field]?.status === state).length;
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  recoveredEvidence: {
    sourcePath,
    originalGeneratedAt: evidence.generatedAt,
    sinceScanId: evidence.sinceScanId,
    populationAggregate: evidence.feeSummary,
    terminalReasonCounts: evidence.reasonCounts,
    detailedPopulation: candidates.length,
    limitation: 'The workspace deletion incident removed the original OPS-847 artifacts and production DB snapshot. This file deterministically recovers the surviving 50-row persisted-candidate extract from Hermes terminal cache; aggregate counts remain those emitted by the original read-only query.',
  },
  detailedGateTotals: {
    candidates: candidates.length,
    terminalReasons: Object.fromEntries(Object.entries(candidates.reduce((acc, candidate) => { acc[candidate.terminal.reasonCode] = (acc[candidate.terminal.reasonCode] ?? 0) + 1; return acc; }, {})).sort()),
    additionalFailures: {
      finiteNonNegativeFiveShareFees: count('finiteNonNegativeFiveShareFees'),
      selectedVenueMinimumQuantity: count('selectedVenueMinimumQuantity'),
      matchedExecutableDepth: count('matchedExecutableDepth'),
      netProfitabilityAfterFees: count('netProfitabilityAfterFees'),
      activeRoiThreshold: count('activeRoiThreshold'),
      canonicalPropositionIdentity: count('canonicalPropositionIdentity'),
    },
    allRecordedScanGatesPass: candidates.filter((candidate) => Object.values(candidate.gates).every((gate) => !['fail', 'not_recorded'].includes(gate.status))).length,
  },
  candidates,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, detailedPopulation: candidates.length, totals: output.detailedGateTotals }, null, 2));
