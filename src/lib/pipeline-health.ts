export interface BotConsumerHeartbeat {
  state?: unknown;
  lastSuccessAt?: unknown;
  error?: unknown;
}

export interface BotScanCursorHealth {
  pendingScans?: unknown;
  cursorLag?: unknown;
  cursorScanId?: unknown;
  latestCompletedScanId?: unknown;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function classifyBotConsumerHealth(input: {
  heartbeat: BotConsumerHeartbeat | null;
  scanHealth: BotScanCursorHealth;
  now?: number;
  staleAfterMs?: number;
}) {
  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? 30_000;
  const heartbeatAt = typeof input.heartbeat?.lastSuccessAt === 'string'
    ? Date.parse(input.heartbeat.lastSuccessAt) : Number.NaN;
  const heartbeatAgeMs = Number.isFinite(heartbeatAt) ? Math.max(0, now - heartbeatAt) : null;
  const pendingScans = nonNegativeInteger(input.scanHealth.pendingScans);
  const cursorLag = nonNegativeInteger(input.scanHealth.cursorLag);
  const cursorScanId = nonNegativeInteger(input.scanHealth.cursorScanId);
  const latestCompletedScanId = nonNegativeInteger(input.scanHealth.latestCompletedScanId);
  const cursorEvidenceValid = [
    input.scanHealth.pendingScans,
    input.scanHealth.cursorLag,
    input.scanHealth.cursorScanId,
    input.scanHealth.latestCompletedScanId,
  ].every(isNonNegativeInteger);
  const reasons: string[] = [];

  if (input.heartbeat?.state !== 'healthy') {
    reasons.push(`Ragnar consumer state is ${String(input.heartbeat?.state ?? 'missing')}`);
  }
  if (heartbeatAgeMs == null || heartbeatAgeMs > staleAfterMs) {
    reasons.push('Ragnar consumer heartbeat is stale or missing');
  }
  if (!cursorEvidenceValid) {
    reasons.push('BotTrader cursor health evidence is missing or malformed');
  }
  if (pendingScans > 0) {
    reasons.push(`${pendingScans} persisted scan(s) await a terminal BotTrader decision`);
  }
  if (cursorLag > 0) {
    reasons.push(`BotTrader cursor ${cursorScanId} trails completed scan ${latestCompletedScanId}`);
  }

  return {
    state: reasons.length === 0 ? 'healthy' as const : 'degraded' as const,
    reasons,
    heartbeatAt: Number.isFinite(heartbeatAt) ? new Date(heartbeatAt).toISOString() : null,
    heartbeatAgeMs,
    pendingScans,
    cursorLag,
    cursorScanId,
    latestCompletedScanId,
    error: typeof input.heartbeat?.error === 'string' ? input.heartbeat.error : null,
  };
}

interface MarketsProjectionRow {
  lastScanResult?: { scannedAt?: unknown; matchStatus?: unknown; matchError?: unknown } | null;
  canonicalApyPct?: unknown;
  canonicalApyUnavailableReason?: unknown;
  canonicalCurrentRoiPct?: unknown;
  canonicalCurrentRoiStatus?: unknown;
  canonicalCurrentRoiUnavailableReason?: unknown;
  canonicalCurrentProfit?: unknown;
  canonicalCurrentProfitStatus?: unknown;
  canonicalCurrentProfitUnavailableReason?: unknown;
}

export function summarizeMarketsProjectionHealth(markets: MarketsProjectionRow[]) {
  let scanned = 0;
  let availableApy = 0;
  let unavailableWithReason = 0;
  let unavailableWithoutReason = 0;
  let zeroCurrentRoi = 0;
  let availableRoi = 0;
  let notApplicableRoi = 0;
  let unavailableRoi = 0;
  let unavailableRoiWithoutReason = 0;
  let availableProfit = 0;
  let notApplicableProfit = 0;
  let unavailableProfit = 0;
  let unavailableProfitWithoutReason = 0;
  let unavailableScanStates = 0;
  let unavailableScanStatesWithoutReason = 0;

  for (const market of markets) {
    if (typeof market.lastScanResult?.scannedAt === 'string') scanned += 1;
    if (typeof market.canonicalApyPct === 'number' && Number.isFinite(market.canonicalApyPct)) {
      availableApy += 1;
    } else if (typeof market.canonicalApyUnavailableReason === 'string'
      && market.canonicalApyUnavailableReason.length > 0) {
      unavailableWithReason += 1;
    } else {
      unavailableWithoutReason += 1;
    }
    if (market.canonicalCurrentRoiPct === 0) zeroCurrentRoi += 1;
    const noArb = market.canonicalApyUnavailableReason === 'no_canonical_arbitrage';
    const roiStatus = market.canonicalCurrentRoiStatus === 'available'
      || market.canonicalCurrentRoiStatus === 'not_applicable'
      || market.canonicalCurrentRoiStatus === 'unavailable' ? market.canonicalCurrentRoiStatus
      : typeof market.canonicalCurrentRoiPct === 'number' && Number.isFinite(market.canonicalCurrentRoiPct)
        ? 'available' : noArb ? 'not_applicable' : 'unavailable';
    if (roiStatus === 'available') availableRoi += 1;
    else if (roiStatus === 'not_applicable') notApplicableRoi += 1;
    else {
      unavailableRoi += 1;
      if (typeof market.canonicalCurrentRoiUnavailableReason !== 'string'
        || market.canonicalCurrentRoiUnavailableReason.length === 0) unavailableRoiWithoutReason += 1;
    }
    const profitStatus = market.canonicalCurrentProfitStatus === 'available'
      || market.canonicalCurrentProfitStatus === 'not_applicable'
      || market.canonicalCurrentProfitStatus === 'unavailable' ? market.canonicalCurrentProfitStatus
      : typeof market.canonicalCurrentProfit === 'number' && Number.isFinite(market.canonicalCurrentProfit)
        ? 'available' : noArb ? 'not_applicable' : 'unavailable';
    if (profitStatus === 'available') availableProfit += 1;
    else if (profitStatus === 'not_applicable') notApplicableProfit += 1;
    else {
      unavailableProfit += 1;
      if (typeof market.canonicalCurrentProfitUnavailableReason !== 'string'
        || market.canonicalCurrentProfitUnavailableReason.length === 0) unavailableProfitWithoutReason += 1;
    }
    if (market.lastScanResult?.matchStatus === 'unavailable') {
      unavailableScanStates += 1;
      if (typeof market.lastScanResult.matchError !== 'string' || market.lastScanResult.matchError.length === 0) {
        unavailableScanStatesWithoutReason += 1;
      }
    }
  }

  const unavailableScanStatesPct = markets.length === 0 ? 0 : unavailableScanStates * 100 / markets.length;
  const applicableRoi = availableRoi + unavailableRoi;
  const unavailableRoiPct = applicableRoi === 0 ? 0 : unavailableRoi * 100 / applicableRoi;
  const applicableProfit = availableProfit + unavailableProfit;
  const unavailableProfitPct = applicableProfit === 0 ? 0 : unavailableProfit * 100 / applicableProfit;

  const reasons: string[] = [];
  if (markets.length === 0) reasons.push('Canonical Markets population is empty');
  if (scanned !== markets.length) reasons.push(`${markets.length - scanned} market(s) have no persisted scan timestamp`);
  if (unavailableWithoutReason > 0) reasons.push(`${unavailableWithoutReason} unavailable APY field(s) lack a specific reason`);
  if (zeroCurrentRoi > 0) reasons.push(`${zeroCurrentRoi} current ROI field(s) were projected as zero instead of unavailable`);
  if (unavailableRoiWithoutReason > 0) reasons.push(`${unavailableRoiWithoutReason} unavailable current ROI field(s) lack a specific reason`);
  if (unavailableProfitWithoutReason > 0) reasons.push(`${unavailableProfitWithoutReason} unavailable current profit field(s) lack a specific reason`);
  if (unavailableRoiPct > 5) {
    reasons.push(`${unavailableRoi}/${applicableRoi} applicable current ROI field(s) are unavailable (${unavailableRoiPct.toFixed(2)}%), above the 5% degradation threshold`);
  }
  if (unavailableProfitPct > 5) {
    reasons.push(`${unavailableProfit}/${applicableProfit} applicable current profit field(s) are unavailable (${unavailableProfitPct.toFixed(2)}%), above the 5% degradation threshold`);
  }
  if (unavailableScanStatesWithoutReason > 0) {
    reasons.push(`${unavailableScanStatesWithoutReason} unavailable persisted market scan state(s) lack a specific reason`);
  }
  if (unavailableScanStatesPct > 5) {
    reasons.push(`${unavailableScanStates}/${markets.length} persisted market scan state(s) are unavailable (${unavailableScanStatesPct.toFixed(2)}%), above the 5% degradation threshold`);
  }

  return {
    state: reasons.length === 0 ? 'healthy' as const : 'degraded' as const,
    reasons,
    total: markets.length,
    scanned,
    availableApy,
    unavailableWithReason,
    unavailableWithoutReason,
    zeroCurrentRoi,
    availableRoi,
    notApplicableRoi,
    unavailableRoi,
    unavailableRoiWithoutReason,
    unavailableRoiPct,
    availableProfit,
    notApplicableProfit,
    unavailableProfit,
    unavailableProfitWithoutReason,
    unavailableProfitPct,
    unavailableScanStates,
    unavailableScanStatesPct,
    unavailableScanStatesWithoutReason,
  };
}
