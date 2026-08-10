export type BotSelectionMethod = 'roi' | 'apy' | 'hybrid';

type CandidateMarket = {
  id: string;
  eventTitle: string;
  expiryDate?: string | null;
  liveResult?: unknown;
  lastScanResult?: unknown;
};

type RankedCandidate<T> = { market: T; roiPct: number; apyPct: number; scannedAt: string; selectionMethod: BotSelectionMethod };

const MAX_CANDIDATE_AGE_MS = 24 * 60 * 60 * 1000;

function scanSummary(
  market: CandidateMarket,
  method: BotSelectionMethod,
  thresholds: { minRoiPct?: number; minApyPct?: number },
): { roiPct: number; apyPct: number; scannedAt: string } | null {
  const result = (market.liveResult ?? market.lastScanResult) as Record<string, unknown> | null;
  if (!result) return null;
  const scannedAt = typeof result.scannedAt === 'string' ? result.scannedAt : '';
  const arbs = Array.isArray(result.allArbs) ? result.allArbs as Array<Record<string, unknown>> : [];
  const candidates = arbs.map((arb) => ({
    roiPct: typeof arb.roiPct === 'number' && Number.isFinite(arb.roiPct) ? arb.roiPct : 0,
    apyPct: typeof arb.apyPct === 'number' && Number.isFinite(arb.apyPct) ? Math.max(0, arb.apyPct) : 0,
  })).filter((arb) => {
    if (arb.roiPct <= 0) return false;
    if (method === 'roi') return arb.roiPct >= (thresholds.minRoiPct ?? 0);
    if (method === 'apy') return arb.apyPct >= (thresholds.minApyPct ?? 0);
    return arb.roiPct >= (thresholds.minRoiPct ?? 0) && arb.apyPct >= (thresholds.minApyPct ?? 0);
  });
  if (!scannedAt || !Number.isFinite(Date.parse(scannedAt)) || candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const primary = method === 'apy' ? b.apyPct - a.apyPct : b.roiPct - a.roiPct;
    return primary !== 0 ? primary : (method === 'apy' ? b.roiPct - a.roiPct : b.apyPct - a.apyPct);
  });
  return { ...candidates[0], scannedAt };
}

export function rankBotCandidates<T extends CandidateMarket>(
  markets: T[],
  method: BotSelectionMethod,
  now = Date.now(),
  thresholds: { minRoiPct?: number; minApyPct?: number } = {},
): RankedCandidate<T>[] {
  const minRoi = thresholds.minRoiPct ?? 0;
  const minApy = thresholds.minApyPct ?? 0;
  return markets.flatMap((market) => {
    const summary = scanSummary(market, method, thresholds);
    if (!summary || summary.roiPct <= 0) return [];
    const scanMs = Date.parse(summary.scannedAt);
    if (now - scanMs > MAX_CANDIDATE_AGE_MS || scanMs > now) return [];
    if (market.expiryDate) {
      const expiryMs = Date.parse(market.expiryDate);
      if (Number.isFinite(expiryMs) && expiryMs <= now) return [];
    }
    if (method === 'roi' && summary.roiPct < minRoi) return [];
    if (method === 'apy' && summary.apyPct < minApy) return [];
    if (method === 'hybrid' && (summary.roiPct < minRoi || summary.apyPct < minApy)) return [];
    return [{ market, ...summary, selectionMethod: method }];
  }).sort((a, b) => {
    const primary = method === 'apy' ? b.apyPct - a.apyPct : b.roiPct - a.roiPct;
    if (primary !== 0) return primary;
    if (method === 'hybrid' && b.apyPct !== a.apyPct) return b.apyPct - a.apyPct;
    const fresh = Date.parse(b.scannedAt) - Date.parse(a.scannedAt);
    return fresh !== 0 ? fresh : a.market.id.localeCompare(b.market.id);
  });
}
