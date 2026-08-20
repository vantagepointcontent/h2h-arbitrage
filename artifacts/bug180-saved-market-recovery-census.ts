import { createClient } from '@libsql/client';
import { selectCanonicalSavedMarketMetrics, type CanonicalSavedMarketCandidate } from '../src/lib/canonical-saved-market-metrics';
import { auditArbClassification } from '../src/lib/arb-types';

async function main(): Promise<void> {
  const dbPath = process.env.H2H_SQLITE_PATH || 'data/edgefinder.db';
  const client = createClient({ url: `file:${dbPath}` });
  try {
  const result = await client.execute(`SELECT id, last_scan_result,
    canonical_current_roi_pct, canonical_apy_pct FROM saved_markets WHERE archived = 0 ORDER BY id`);
  const reasons: Record<string, number> = {};
  let payloads = 0;
  let malformed = 0;
  let recoverableRoi = 0;
  let recoverableApy = 0;
  let alreadyRoi = 0;
  const candidateStages = {
    total: 0, classified: 0, positiveRoi: 0, positiveProfit: 0, positiveStake: 0,
    explicitExecutable: 0, legacyExecutionStatus: 0, explicitNonExecutable: 0, explicitUnavailable: 0,
  };
  for (const row of result.rows) {
    if (row.canonical_current_roi_pct != null) alreadyRoi += 1;
    if (typeof row.last_scan_result !== 'string') {
      reasons.no_persisted_full_scan = (reasons.no_persisted_full_scan ?? 0) + 1;
      continue;
    }
    payloads += 1;
    try {
      const parsed = JSON.parse(row.last_scan_result) as { scannedAt?: string; allArbs?: CanonicalSavedMarketCandidate[] };
      const candidates = Array.isArray(parsed.allArbs) ? parsed.allArbs : [];
      for (const candidate of candidates) {
        candidateStages.total += 1;
        const declared = candidate.arbType === 'cross' || candidate.arbType === 'direct' || candidate.arbType === 'internal'
          ? candidate.arbType : null;
        if (auditArbClassification(candidate.strategy, declared).canonicalType != null) candidateStages.classified += 1;
        if (Number.isFinite(candidate.roiPct) && candidate.roiPct > 0) candidateStages.positiveRoi += 1;
        if (Number.isFinite(candidate.expectedProfit) && candidate.expectedProfit > 0) candidateStages.positiveProfit += 1;
        if (Number.isFinite(candidate.totalStake) && Number(candidate.totalStake) > 0) candidateStages.positiveStake += 1;
        if (candidate.executionStatus === 'executable') candidateStages.explicitExecutable += 1;
        else if (candidate.executionStatus === 'non_executable') candidateStages.explicitNonExecutable += 1;
        else if (candidate.executionStatus === 'unavailable') candidateStages.explicitUnavailable += 1;
        else candidateStages.legacyExecutionStatus += 1;
      }
      const canonical = selectCanonicalSavedMarketMetrics(candidates, parsed.scannedAt);
      if (canonical.roiPct != null) recoverableRoi += 1;
      if (canonical.value != null) recoverableApy += 1;
      const reason = canonical.roiPct != null
        ? canonical.value != null ? 'recoverable_roi_and_apy' : canonical.unavailableReason ?? 'roi_only'
        : canonical.unavailableReason ?? 'unavailable';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    } catch {
      malformed += 1;
      reasons.malformed_last_scan_result = (reasons.malformed_last_scan_result ?? 0) + 1;
    }
  }
    process.stdout.write(`${JSON.stringify({
      observedAt: new Date().toISOString(), dbPath,
      totalMarkets: result.rows.length, payloads, malformed, alreadyRoi, recoverableRoi, recoverableApy,
      candidateStages, reasons,
    }, null, 2)}\n`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Saved-market recovery census failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
