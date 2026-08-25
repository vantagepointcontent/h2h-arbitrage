import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  getSavedMarkets,
  reconcileSavedMarketMatchSummaries,
  type SavedMarket,
} from './persistence';
import { getCanonicalCurrentMarketMetrics, type SavedMarket as SavedMarketView } from '@/app/lib/page-shared';

export async function readSavedMarketSchedulerState(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'saved-market-scheduler.json'), 'utf8'));
  } catch {
    return {};
  }
}

// The persisted scan envelope is backward-compatible and intentionally wider
// than the current SavedMarket TypeScript projection.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizeArb(a: any) {
  return {
    artist: a.artist ?? '', roiPct: a.roiPct ?? 0, expectedProfit: a.expectedProfit ?? 0,
    strategy: a.strategy ?? '', apyPct: a.apyPct ?? null, daysToExpiry: a.daysToExpiry ?? null,
    expiryAt: a.expiryAt ?? null, apyUnavailableReason: a.apyUnavailableReason ?? null,
    outcomeApy: a.outcomeApy ?? null, kalshiTicker: a.kalshiTicker ?? null,
    pmConditionId: a.pmConditionId ?? null, kalshiYesAsk: a.kalshiYesAsk ?? null,
    kalshiNoAsk: a.kalshiNoAsk ?? null, pmYesPrice: a.pmYesPrice ?? null,
    pmNoPrice: a.pmNoPrice ?? null, kalshiStake: a.kalshiStake ?? null,
    pmStake: a.pmStake ?? null, totalStake: a.totalStake ?? a.maxCapital ?? null,
    calculationEnvelope: a.calculationEnvelope,
    fees: a.fees ? {
      kalshiFee: a.fees.kalshiFee ?? null,
      polymarketFee: a.fees.polymarketFee ?? a.fees.pmFee ?? null,
      totalFees: a.fees.totalFees ?? (
        a.fees.kalshiFee != null && (a.fees.polymarketFee ?? a.fees.pmFee) != null
          ? a.fees.kalshiFee + (a.fees.polymarketFee ?? a.fees.pmFee) : null
      ),
      worstCaseNetProfit: a.fees.worstCaseNetProfit ?? null,
      kalshiFeeAuthority: a.fees.kalshiFeeAuthority ?? undefined,
    } : undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizeScan(ls: any, defaultNotScanned: boolean) {
  if (!ls) return null;
  const allArbs = Array.isArray(ls.allArbs) ? ls.allArbs : [];
  return {
    bestRoiPct: ls.bestRoiPct ?? 0, bestProfit: ls.bestProfit ?? 0, strategy: ls.strategy ?? '',
    scannedAt: ls.scannedAt ?? null, matchedCount: ls.matchedCount ?? 0,
    matchStatus: ls.matchStatus ?? (defaultNotScanned && !ls.scannedAt
      ? 'not_scanned' : ((ls.matchedCount ?? 0) > 0 ? 'matched' : 'confirmed_zero')),
    matchError: ls.matchError ?? null,
    matchedPairs: Array.isArray(ls.matchedPairs) ? ls.matchedPairs : [],
    allArbs: allArbs.map(summarizeArb),
  };
}

/** Canonical projection shared by GET ?fields=basic and the protected list refresh. */
export function buildBasicSavedMarketList(savedMarkets: SavedMarket[], schedulerState: Record<string, unknown>) {
  return savedMarkets.map((market) => {
    const scheduler = schedulerState[market.id] as Record<string, unknown> | undefined;
    const scanAt = market.lastScanResult?.scannedAt;
    const scanSucceeded = market.lastScanResult?.matchStatus === 'matched'
      || market.lastScanResult?.matchStatus === 'confirmed_zero';
    const schedulerSuccessAt = typeof scheduler?.lastSuccessAt === 'string' ? scheduler.lastSuccessAt : null;
    const lastSuccessAt = scanSucceeded && scanAt
      && (!schedulerSuccessAt || Date.parse(scanAt) > Date.parse(schedulerSuccessAt)) ? scanAt : schedulerSuccessAt;
    const current = getCanonicalCurrentMarketMetrics(market as SavedMarketView);
    return {
      id: market.id,
      eventTitle: market.eventTitle,
      kalshiUrl: market.kalshiUrl,
      polymarketUrl: market.polymarketUrl,
      expiryDate: market.expiryDate,
      expirySource: market.expirySource ?? null,
      expirySourceId: market.expirySourceId ?? null,
      expiryObservedAt: market.expiryObservedAt ?? null,
      category: market.category,
      scheduler: scheduler ? { ...scheduler, lastSuccessAt } : null,
      canonicalApyPct: current.apyPct,
      canonicalApyUnavailableReason: market.canonicalApyPct != null && !current.valid
        ? 'current_metric_invariant_failed' : market.canonicalApyUnavailableReason ?? null,
      canonicalApyOutcome: market.canonicalApyOutcome ?? null,
      canonicalApyObservedAt: market.canonicalApyObservedAt ?? null,
      canonicalApySource: market.canonicalApySource ?? null,
      canonicalApyRevision: market.canonicalApyRevision ?? null,
      canonicalCurrentRoiPct: market.canonicalCurrentRoiPct ?? null,
      canonicalCurrentRoiStatus: current.roiStatus,
      canonicalCurrentRoiUnavailableReason: current.roiUnavailableReason,
      canonicalCurrentProfit: market.canonicalCurrentProfit ?? null,
      canonicalCurrentProfitStatus: current.profitStatus,
      canonicalCurrentProfitUnavailableReason: current.profitUnavailableReason,
      canonicalCurrentStrategy: market.canonicalCurrentStrategy ?? 'No arb',
      canonicalCurrentDaysToExpiry: market.canonicalCurrentDaysToExpiry ?? null,
      canonicalCurrentExpiryAt: market.canonicalCurrentExpiryAt ?? null,
      canonicalCurrentRevision: market.canonicalCurrentRevision ?? null,
      lastScanResult: summarizeScan(market.lastScanResult, true),
      liveResult: summarizeScan(market.liveResult, false),
    };
  });
}

export async function getCanonicalSavedMarketsBasicSnapshot() {
  await reconcileSavedMarketMatchSummaries();
  const [savedMarkets, schedulerState] = await Promise.all([getSavedMarkets(), readSavedMarketSchedulerState()]);
  const markets = buildBasicSavedMarketList(savedMarkets, schedulerState);
  return {
    markets,
    revision: createHash('sha1').update(JSON.stringify(markets)).digest('hex'),
    observedAt: new Date().toISOString(),
    source: 'persisted-saved-markets' as const,
  };
}
