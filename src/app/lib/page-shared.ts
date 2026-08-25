// page-shared.ts — shared types, storage helpers, and utils for the main views.
// Extracted from page.tsx (PERF-002 split). No behavior changes.

import type { OutcomeContingentApy } from '@/lib/settlement-apy';
import { selectCanonicalSavedMarketMetrics } from '@/lib/canonical-saved-market-metrics';
import type { ArbType } from '@/lib/arb-types';
import { calculateApyPctFromDays } from '@/lib/scan-apy';

// ─── Generic localStorage helpers ───

function getStored<T>(key: string, fallback: T, validate?: (v: T) => boolean): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = JSON.parse(raw) as T;
    return validate && !validate(v) ? fallback : v;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* quota exceeded – ignore */ }
}

// ─── Storage keys ───
export const MF_SELECTED_IDS_KEY = "h2h-mf-selected-ids";
export const MF_CATEGORIES_KEY = "h2h-mf-categories";
export const MF_EXPIRY_DAYS_KEY = "h2h-mf-expiry-days";
export const FAVORITE_IDS_KEY = "h2h-favorites";
export const CUSTOM_TITLES_KEY = "h2h-custom-titles";
export const MAX_CUSTOM_TITLE_LEN = 100;
export const MF_AUTO_REFRESH_KEY = "h2h-mf-auto-refresh";
export const SIDEBAR_OPEN_KEY = "h2h-sidebar-open";
export const DEFAULT_MARKET_EXPIRY_FILTER = "all" as const;
export const DEFAULT_SHOW_ARB_ONLY = false;

export type QuickPricesLoadingMode = "foreground" | "background";

export interface QuickPricesRequestToken {
  controller: AbortController;
  marketId: string;
  sequence: number;
  mode: QuickPricesLoadingMode;
  displacedMode: QuickPricesLoadingMode | null;
}

/** Owns the single quick-price request allowed to mutate the active market view. */
export function createQuickPricesRequestOwner() {
  let current: QuickPricesRequestToken | null = null;
  let sequence = 0;

  return {
    begin(marketId: string, mode: QuickPricesLoadingMode = "foreground"): QuickPricesRequestToken {
      const displacedMode = current?.mode ?? null;
      current?.controller.abort();
      current = {
        controller: new AbortController(),
        marketId,
        sequence: ++sequence,
        mode,
        displacedMode,
      };
      return current;
    },
    owns(token: QuickPricesRequestToken, activeMarketId: string | null): boolean {
      return current === token && !token.controller.signal.aborted && token.marketId === activeMarketId;
    },
    finish(token: QuickPricesRequestToken): boolean {
      if (current !== token) return false;
      current = null;
      return true;
    },
    cancel(): QuickPricesLoadingMode | null {
      const cancelledMode = current?.mode ?? null;
      current?.controller.abort();
      current = null;
      return cancelledMode;
    },
  };
}

export interface SavedMarketsListRequest<T> {
  sequence: number;
  promise: Promise<T>;
  deduplicated: boolean;
}

/** Deduplicates rapid list refresh clicks and fences superseded responses. */
export function createSavedMarketsListRequestOwner() {
  let current: { sequence: number; promise: Promise<unknown> } | null = null;
  let sequence = 0;

  return {
    run<T>(loader: () => Promise<T>, options?: { supersede?: boolean }): SavedMarketsListRequest<T> {
      if (current && !options?.supersede) {
        return { sequence: current.sequence, promise: current.promise as Promise<T>, deduplicated: true };
      }
      const next = { sequence: ++sequence, promise: loader() };
      current = next;
      return { ...next, deduplicated: false };
    },
    owns<T>(request: SavedMarketsListRequest<T>): boolean {
      return current?.sequence === request.sequence && current.promise === request.promise;
    },
    finish<T>(request: SavedMarketsListRequest<T>): boolean {
      if (current?.sequence !== request.sequence || current.promise !== request.promise) return false;
      current = null;
      return true;
    },
  };
}

/** Build actionable persisted-list failure state without exposing transport details. */
export function buildSavedMarketsListFailureState(
  hasRetainedMarkets: boolean,
  responseStatus: number | null,
): { status: 'degraded' | 'error'; message: string } {
  const sessionExpired = responseStatus === 401 || responseStatus === 403;
  if (hasRetainedMarkets) {
    return {
      status: 'degraded',
      message: sessionExpired
        ? 'The saved-markets session expired. The last-known list is still shown. Reload the app and try Refresh again.'
        : 'Saved markets could not be refreshed. The last-known list is still shown. Try Refresh again.',
    };
  }
  return {
    status: 'error',
    message: sessionExpired
      ? 'Saved markets are unavailable because the session expired, so no markets can be shown. Reload the app, then try Refresh again.'
      : 'Saved markets are unavailable, so no markets can be shown. Reload the app, then try Refresh again.',
  };
}

/** Validate the server-action boundary and collapse duplicate IDs to the latest row. */
export function normalizeSavedMarketsList(value: unknown): SavedMarket[] | null {
  if (!Array.isArray(value)) return null;
  const byId = new Map<string, SavedMarket>();
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const market = item as Partial<SavedMarket>;
    if (
      typeof market.id !== 'string' || !market.id
      || typeof market.eventTitle !== 'string'
      || typeof market.kalshiUrl !== 'string'
      || typeof market.polymarketUrl !== 'string'
    ) return null;
    byId.set(market.id, {
      ...market,
      createdAt: typeof market.createdAt === 'string' ? market.createdAt : '',
    } as SavedMarket);
  }
  return [...byId.values()];
}

export interface SavedMarketHydrationToken {
  controller: AbortController;
  marketId: string;
  sequence: number;
}

/** Owns saved-market cache/look-up hydration before a price request begins. */
export function createSavedMarketHydrationOwner() {
  let current: SavedMarketHydrationToken | null = null;
  let sequence = 0;

  return {
    begin(marketId: string): SavedMarketHydrationToken {
      current?.controller.abort();
      current = {
        controller: new AbortController(),
        marketId,
        sequence: ++sequence,
      };
      return current;
    },
    owns(token: SavedMarketHydrationToken, activeMarketId: string | null): boolean {
      return current === token && !token.controller.signal.aborted && token.marketId === activeMarketId;
    },
    finish(token: SavedMarketHydrationToken): boolean {
      if (current !== token) return false;
      current = null;
      return true;
    },
    cancel(): void {
      current?.controller.abort();
      current = null;
    },
  };
}

interface SavedMarketPopNavigationActions {
  setViewMode: (viewMode: "scan") => void;
  setActiveMarketId: (marketId: string) => void;
  startRefresh: () => void;
}

/** Restore saved-market route identity before starting work on browser pop navigation. */
export function restoreSavedMarketPopNavigation(
  marketId: string,
  actions: SavedMarketPopNavigationActions,
): void {
  actions.setViewMode("scan");
  actions.setActiveMarketId(marketId);
  actions.startRefresh();
}

interface ScanLinkInput {
  kalshiUrl: string;
  polymarketUrl: string;
  platformLinks: Array<{ platform?: string | null; url: string }>;
  savedMarketId: string | null;
}

/** Saved-market scans must never inherit unrelated links from the manual form. */
export function buildScanLinkPayload(input: ScanLinkInput):
  | { kalshiUrl: string; polymarketUrl: string }
  | { platformLinks: Array<{ platform: string; url: string }> } {
  if (input.savedMarketId) {
    return { kalshiUrl: input.kalshiUrl, polymarketUrl: input.polymarketUrl };
  }

  const platformLinks = input.platformLinks
    .filter((link) => link.url)
    .map(({ platform, url }) => ({ platform: platform ?? "", url }));
  return platformLinks.length > 0
    ? { platformLinks }
    : { kalshiUrl: input.kalshiUrl, polymarketUrl: input.polymarketUrl };
}

// ─── Typed accessors ───
export const getStoredMfCategories = (): string[] => getStored<string[]>(MF_CATEGORIES_KEY, []);
export const persistMfCategories = (cats: string[]): void => persist(MF_CATEGORIES_KEY, cats);

export const getStoredMfExpiryDays = (): number =>
  getStored<number>(MF_EXPIRY_DAYS_KEY, 365, (n) => Number.isFinite(n) && n >= 1 && n <= 365);
export const persistMfExpiryDays = (days: number): void => persist(MF_EXPIRY_DAYS_KEY, days);

export const getStoredMfSelectedIds = (): Set<string> =>
  new Set(getStored<string[]>(MF_SELECTED_IDS_KEY, []));
export const persistMfSelectedIds = (ids: Set<string>): void => persist(MF_SELECTED_IDS_KEY, [...ids]);

export const getStoredFavoriteIds = (): Set<string> =>
  new Set(getStored<string[]>(FAVORITE_IDS_KEY, []));
export const persistFavoriteIds = (ids: Set<string>): void => persist(FAVORITE_IDS_KEY, [...ids]);

export const getStoredCustomTitles = (): Record<string, string> =>
  getStored<Record<string, string>>(CUSTOM_TITLES_KEY, {});

/** Persist a single custom title to localStorage */
export function setCustomTitle(marketId: string, title: string): void {
  const titles = getStoredCustomTitles();
  titles[marketId] = title;
  persist(CUSTOM_TITLES_KEY, titles);
}

/** Remove a custom title from localStorage */
export function removeCustomTitle(marketId: string): void {
  const titles = getStoredCustomTitles();
  delete titles[marketId];
  persist(CUSTOM_TITLES_KEY, titles);
}

export const getStoredMfAutoRefresh = (): boolean => getStored<boolean>(MF_AUTO_REFRESH_KEY, true);
export const persistMfAutoRefresh = (val: boolean): void => persist(MF_AUTO_REFRESH_KEY, val);

export const getStoredSidebarOpen = (): boolean => getStored<boolean>(SIDEBAR_OPEN_KEY, true);
export const persistSidebarOpen = (val: boolean): void => persist(SIDEBAR_OPEN_KEY, val);

export interface ArbitrageInfo {
  strategy: string;
  kalshiStake: number;
  pmStake: number;
  expectedProfit: number;
  roiPct: number;
  arbType?: ArbType | null;
  apyPct?: number | null;
  daysToExpiry?: number | null;
  expiryAt?: string | null;
  apyUnavailableReason?: import('@/lib/scan-apy').ScanApyUnavailableReason | null;
  outcomeApy?: OutcomeContingentApy;
  buyPlatform: "kalshi" | "polymarket" | null;
  buyPrice: number;
  sellPlatform: "kalshi" | "polymarket" | null;
  sellPrice: number;
  executionStatus?: 'executable' | 'non_executable' | 'unavailable';
  suspicious?: boolean;
}

export interface UnifiedOutcome {
  artist: string;
  kalshiStale?: boolean;
  polymarketStale?: boolean;
  kalshi: {
    ticker: string;
    yesBid: number;
    yesAsk: number;
    noBid: number;
    noAsk: number;
    lastPrice: number;
    volume24h?: string;
    yesAskDepth?: string;
    noAskDepth?: string;
  } | null;
  polymarket: {
    marketId: string;
    conditionId: string;
    yesPrice: number;
    noPrice: number;
    bestBid: number;
    bestAsk: number;
    lastTradePrice: number;
    volume?: string;
    liquidity?: string;
    askDepth?: number;
    noAskDepth?: number;
  } | null;
  arbitrage: ArbitrageInfo;
  source?: "auto" | "manual";
}

export interface UnmatchedKalshi {
  ticker: string;
  title: string;
  artist?: string;
  yesAsk: number;
  noAsk: number;
}

export interface UnmatchedPolymarket {
  conditionId: string;
  title: string;
  yesPrice: number;
  noPrice: number;
}

export interface ManualMatch {
  id: string;
  kalshiTicker: string;
  kalshiTitle: string;
  pmConditionId: string;
  pmTitle: string;
  orientation?: 'same' | 'inverted';
  createdAt: string;
}

export interface LastScanResult {
  bestRoiPct: number;
  bestProfit: number;
  strategy: string;
  outcomeCount: number;
  matchedCount: number;
  kalshiCount: number;
  pmCount: number;
  scannedAt: string | null;
  matchStatus?: 'not_scanned' | 'refreshing' | 'unavailable' | 'confirmed_zero' | 'matched';
  matchError?: string;
  matchedPairs?: { artist: string; kalshiTicker: string; pmConditionId: string }[];
  publicationGeneration?: number;
  pmClosed?: boolean; // UI-013: PM reports market closed (endDate may still be future)
  priceResolved?: boolean; // BUG-05b: at least one outcome at 99/1 extremes
  allArbs?: {
    artist: string;
    kalshiMarketQuestion?: string | null;
    pmMarketQuestion?: string | null;
    kalshiOutcomeLabel?: string | null;
    pmOutcomeLabel?: string | null;
    relationshipVerified?: boolean;
    relationshipState?: import('@/lib/bot-leg-identity').BotLegRelationshipState;
    relationshipExplanation?: string | null;
    kalshiSide?: 'yes' | 'no';
    pmSide?: 'yes' | 'no';
    roiPct: number;
    expectedProfit: number;
    strategy: string;
    arbType?: import('@/lib/arb-types').ArbType;
    totalStake?: number;
    kalshiTicker?: string;
    kalshiYesAsk?: number;
    kalshiNoAsk?: number;
    kalshiYesBid?: number;
    kalshiNoBid?: number;
    pmConditionId?: string;
    pmYesPrice?: number;
    pmNoPrice?: number;
    pmBestBid?: number;
    pmBestAsk?: number;
    kalshiStake?: number;
    pmStake?: number;
    executionStatus?: 'executable' | 'non_executable' | 'unavailable';
    executionBlocker?: string;
    apyPct?: number | null;
    daysToExpiry?: number | null;
    expiryAt?: string | null;
    apyUnavailableReason?: import('@/lib/scan-apy').ScanApyUnavailableReason | null;
    outcomeApy?: OutcomeContingentApy;
    buyPlatform?: string | null;
    buyPrice?: number;
    sellPlatform?: string | null;
    sellPrice?: number;
  }[];
}

export interface SavedMarketScheduleState {
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  nextDueAt?: string | null;
  inProgress?: boolean;
  failureReason?: string | null;
  retryCount?: number;
  freshnessSlaMs?: number;
}

export function getSavedMarketScheduleView(
  scheduler: SavedMarketScheduleState | null | undefined,
  lastSuccessfulScanAt: string | null | undefined,
  now = Date.now(),
  freshnessSlaMs = scheduler?.freshnessSlaMs ?? 60 * 60_000,
): { status: 'fresh' | 'due' | 'scanning' | 'failed' | 'rate_limited' | 'overdue' | 'unavailable'; ageMs: number | null; reason: string | null } {
  const successAt = scheduler?.lastSuccessAt ?? lastSuccessfulScanAt;
  const parsed = successAt ? Date.parse(successAt) : NaN;
  const ageMs = Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
  if (scheduler?.inProgress) return { status: 'scanning', ageMs, reason: 'A recurring full scan is currently running.' };
  if (scheduler?.failureReason) {
    const rateLimited = /(?:http\s*429|rate[ -]?limit|too many requests)/i.test(scheduler.failureReason);
    return {
      status: rateLimited ? 'rate_limited' : 'failed',
      ageMs,
      reason: scheduler.failureReason,
    };
  }
  if (ageMs === null) return { status: 'unavailable', ageMs, reason: 'No successful full scan is available yet.' };
  if (ageMs > freshnessSlaMs) return { status: 'overdue', ageMs, reason: 'Full scan is past the freshness SLA.' };
  const nextDueAt = scheduler?.nextDueAt ? Date.parse(scheduler.nextDueAt) : NaN;
  if (Number.isFinite(nextDueAt) && nextDueAt <= now) {
    return { status: 'due', ageMs, reason: 'A recurring full scan is due and waiting in the fair queue.' };
  }
  return { status: 'fresh', ageMs, reason: null };
}

export interface SavedMarket {
  id: string;
  kalshiUrl: string;
  polymarketUrl: string;
  eventTitle: string;
  category?: string;
  createdAt: string;
  expiryDate?: string | null;
  favorited?: boolean;
  lastScanResult?: LastScanResult | null;
  scheduler?: SavedMarketScheduleState | null;
  liveResult?: {
    bestRoiPct: number;
    bestProfit: number;
    strategy: string;
    scannedAt: string | null;
    matchStatus?: LastScanResult['matchStatus'];
    matchError?: string;
    matchedPairs?: LastScanResult['matchedPairs'];
    publicationGeneration?: number;
    kalshiCount?: number;
    pmCount?: number;
    matchedCount?: number;
    pmClosed?: boolean;
    priceResolved?: boolean;
    allArbs?: {
      artist: string;
      kalshiMarketQuestion?: string | null;
      pmMarketQuestion?: string | null;
      kalshiOutcomeLabel?: string | null;
      pmOutcomeLabel?: string | null;
      relationshipVerified?: boolean;
      relationshipState?: import('@/lib/bot-leg-identity').BotLegRelationshipState;
      relationshipExplanation?: string | null;
      kalshiSide?: 'yes' | 'no';
      pmSide?: 'yes' | 'no';
      roiPct: number;
      expectedProfit: number;
      strategy: string;
      totalStake?: number;
      apyPct?: number | null;
      daysToExpiry?: number | null;
      expiryAt?: string | null;
      apyUnavailableReason?: import('@/lib/scan-apy').ScanApyUnavailableReason | null;
      outcomeApy?: OutcomeContingentApy;
    }[];
  } | null;
  canonicalApyPct?: number | null;
  canonicalApyUnavailableReason?: string | null;
  canonicalApyOutcome?: string | null;
  canonicalApyObservedAt?: string | null;
  canonicalApySource?: 'full_scan' | null;
  canonicalApyRevision?: number | null;
  canonicalCurrentRoiPct?: number | null;
  canonicalCurrentRoiStatus?: 'available' | 'not_applicable' | 'unavailable' | null;
  canonicalCurrentRoiUnavailableReason?: string | null;
  canonicalCurrentProfit?: number | null;
  canonicalCurrentProfitStatus?: 'available' | 'not_applicable' | 'unavailable' | null;
  canonicalCurrentProfitUnavailableReason?: string | null;
  canonicalCurrentStrategy?: string | null;
  canonicalCurrentDaysToExpiry?: number | null;
  canonicalCurrentExpiryAt?: string | null;
  canonicalCurrentRevision?: number | null;
}

export interface MarketApySummary {
  scalarApyPct: number | null;
  scenarioApyPct: { kalshi: number; polymarket: number } | null;
  sortApyPct: number | null;
  unavailableReason: string | null;
  observedAt: string | null;
  source: 'full_scan' | null;
  revision: number | null;
  quickApyPct: number | null;
  quickObservedAt: string | null;
}

export interface CanonicalCurrentMarketMetrics {
  roiPct: number | null;
  roiStatus: 'available' | 'not_applicable' | 'unavailable';
  roiUnavailableReason: string | null;
  profit: number | null;
  profitStatus: 'available' | 'not_applicable' | 'unavailable';
  profitUnavailableReason: string | null;
  strategy: string;
  apyPct: number | null;
  daysToExpiry: number | null;
  expiryAt: string | null;
  revision: number | null;
  valid: boolean;
}

export function getCanonicalCurrentMarketMetrics(market: SavedMarket): CanonicalCurrentMarketMetrics {
  const roiPct = typeof market.canonicalCurrentRoiPct === 'number' && Number.isFinite(market.canonicalCurrentRoiPct)
    ? market.canonicalCurrentRoiPct : null;
  const profit = typeof market.canonicalCurrentProfit === 'number' && Number.isFinite(market.canonicalCurrentProfit)
    ? market.canonicalCurrentProfit : null;
  const strategy = typeof market.canonicalCurrentStrategy === 'string' && market.canonicalCurrentStrategy.trim()
    ? market.canonicalCurrentStrategy : 'No arb';
  const roiStatus = market.canonicalCurrentRoiStatus === 'available'
    || market.canonicalCurrentRoiStatus === 'not_applicable'
    || market.canonicalCurrentRoiStatus === 'unavailable' ? market.canonicalCurrentRoiStatus
    : roiPct != null ? 'available' : strategy === 'No arb' ? 'not_applicable' : 'unavailable';
  const roiUnavailableReason = roiStatus === 'unavailable'
    ? market.canonicalCurrentRoiUnavailableReason ?? 'canonical_roi_status_missing' : null;
  const profitStatus = market.canonicalCurrentProfitStatus === 'available'
    || market.canonicalCurrentProfitStatus === 'not_applicable'
    || market.canonicalCurrentProfitStatus === 'unavailable' ? market.canonicalCurrentProfitStatus
    : profit != null ? 'available' : roiStatus === 'not_applicable' ? 'not_applicable' : 'unavailable';
  const profitUnavailableReason = profitStatus === 'unavailable'
    ? market.canonicalCurrentProfitUnavailableReason ?? 'canonical_profit_status_missing' : null;
  const rawApy = typeof market.canonicalApyPct === 'number' && Number.isFinite(market.canonicalApyPct)
    ? market.canonicalApyPct : null;
  const daysToExpiry = typeof market.canonicalCurrentDaysToExpiry === 'number'
    && Number.isFinite(market.canonicalCurrentDaysToExpiry) && market.canonicalCurrentDaysToExpiry > 0
    ? market.canonicalCurrentDaysToExpiry : null;
  const expiryAt = typeof market.canonicalCurrentExpiryAt === 'string'
    && Number.isFinite(Date.parse(market.canonicalCurrentExpiryAt)) ? market.canonicalCurrentExpiryAt : null;
  const revision = Number.isSafeInteger(market.canonicalCurrentRevision) ? market.canonicalCurrentRevision! : null;
  const apyRevision = Number.isSafeInteger(market.canonicalApyRevision) ? market.canonicalApyRevision! : null;
  const expectedApy = roiPct != null && daysToExpiry != null
    ? calculateApyPctFromDays(roiPct, daysToExpiry) : null;
  const apyMatches = rawApy != null && expectedApy != null && Number.isFinite(expectedApy)
    && Math.abs(rawApy - expectedApy) <= Math.max(1e-9, Math.abs(expectedApy) * 1e-9);
  const valid = rawApy != null && roiPct != null && roiPct > 0
    && strategy !== 'No arb' && !strategy.startsWith('Unavailable')
    && daysToExpiry != null && expiryAt != null && revision != null && revision === apyRevision
    && market.canonicalApySource === 'full_scan' && apyMatches;
  return {
    roiPct, roiStatus, roiUnavailableReason,
    profit, profitStatus, profitUnavailableReason,
    strategy, apyPct: valid ? rawApy : null, daysToExpiry, expiryAt, revision, valid,
  };
}

export interface QuickApyProvenance {
  apyPct: number | null;
  observedAt: string | null;
  status: 'complete' | 'partial' | 'failed' | 'stale' | 'unavailable';
  reason: string | null;
}

/** A quick APY is executable only when the scoped refresh completed with fresh
 * quotes from both venues. Partial/stale results keep their age and reason but
 * never publish an implicit numeric zero. */
export function getQuickApyProvenance(result: ScanResult): QuickApyProvenance {
  const observedAt = result._priceDataObservedAt ?? null;
  const diagnostics = Object.values(result.platformDiagnostics ?? {});
  const diagnosticFailure = diagnostics.find((entry) => entry.status === 'failed' || entry.status === 'partial');
  const hasStaleOutcome = result.outcomes.some((outcome) => outcome.kalshiStale === true || outcome.polymarketStale === true);
  const status: QuickApyProvenance['status'] = result.refreshStatus === 'failed'
    ? 'failed'
    : result.refreshStatus === 'partial' || diagnosticFailure
      ? 'partial'
      : hasStaleOutcome
        ? 'stale'
        : result.refreshStatus === 'complete'
          ? 'complete'
          : 'unavailable';
  const reason = diagnosticFailure?.reason
    ?? (hasStaleOutcome ? 'One or more venue quotes are stale' : null)
    ?? (status === 'failed' ? 'Quick refresh failed' : null)
    ?? (status === 'partial' ? 'Quick refresh was partial' : null);
  if (status !== 'complete' || !observedAt) return { apyPct: null, observedAt, status, reason };

  const best = result.outcomes.filter((outcome) =>
    outcome.arbitrage.strategy !== 'No arb'
    && !outcome.arbitrage.strategy.startsWith('Unavailable')
    && outcome.kalshiStale !== true
    && outcome.polymarketStale !== true
    && Number.isFinite(outcome.arbitrage.roiPct),
  ).sort((a, b) => b.arbitrage.roiPct - a.arbitrage.roiPct || a.artist.localeCompare(b.artist))[0];
  const apyPct = typeof best?.arbitrage.apyPct === 'number' && Number.isFinite(best.arbitrage.apyPct)
    ? best.arbitrage.apyPct : null;
  return {
    apyPct,
    observedAt,
    status,
    reason: apyPct == null ? 'No executable arbitrage APY in the quick refresh' : null,
  };
}

/** Read scan-time APY only; never re-annualize from the saved market's generic expiry. */
export function getMarketApySummary(market: SavedMarket): MarketApySummary {
  const detailArbs = market.liveResult?.allArbs ?? market.lastScanResult?.allArbs ?? [];
  const arbs = market.lastScanResult?.allArbs ?? [];
  const best = arbs.reduce<(typeof arbs)[number] | null>(
    (current, arb) => !current || arb.roiPct > current.roiPct ? arb : current,
    null,
  );
  const outcomeApy = best?.outcomeApy;
  const kalshi = outcomeApy?.scenarioA.apyPct;
  const polymarket = outcomeApy?.scenarioB.apyPct;
  const scenarios = outcomeApy?.apyPct == null && kalshi != null && polymarket != null
    ? { kalshi, polymarket }
    : null;
  const quickBest = detailArbs.reduce<(typeof detailArbs)[number] | null>(
    (current, arb) => !current || arb.roiPct > current.roiPct ? arb : current,
    null,
  );
  const current = getCanonicalCurrentMarketMetrics(market);
  const scalarApyPct = current.apyPct;
  return {
    scalarApyPct,
    scenarioApyPct: scenarios,
    sortApyPct: scalarApyPct,
    unavailableReason: scalarApyPct == null
      ? (market.canonicalApyPct != null ? 'current_metric_invariant_failed'
        : market.canonicalApyUnavailableReason ?? 'canonical_apy_unavailable') : null,
    observedAt: market.canonicalApyObservedAt ?? null,
    source: market.canonicalApySource ?? null,
    revision: Number.isSafeInteger(market.canonicalApyRevision) ? market.canonicalApyRevision! : null,
    quickApyPct: typeof quickBest?.apyPct === 'number' && Number.isFinite(quickBest.apyPct)
      ? quickBest.apyPct : null,
    quickObservedAt: market.liveResult?.scannedAt ?? null,
  };
}

/** Total deterministic order for compact persisted APY. Finite values always
 * precede unavailable values; display rounding never participates. */
export function compareSavedMarketApy(
  a: SavedMarket,
  b: SavedMarket,
  direction: 'asc' | 'desc',
): number {
  const av = getCanonicalCurrentMarketMetrics(a).apyPct;
  const bv = getCanonicalCurrentMarketMetrics(b).apyPct;
  if (av == null && bv != null) return 1;
  if (av != null && bv == null) return -1;
  if (av != null && bv != null && av !== bv) return direction === 'asc' ? av - bv : bv - av;
  const title = a.eventTitle.localeCompare(b.eventTitle);
  return title !== 0 ? title : a.id.localeCompare(b.id);
}

/** Merge delayed list/detail hydration without allowing an older publication
 * to roll back a newer local full-scan APY or result. */
export function mergeSavedMarketHydration(current: SavedMarket, incoming: SavedMarket): SavedMarket {
  const rank = (observedAt: string | null | undefined, revision: number | null | undefined) => {
    const parsed = observedAt ? Date.parse(observedAt) : NaN;
    return {
      observedAt: Number.isFinite(parsed) ? parsed : -Infinity,
      revision: Number.isSafeInteger(revision) ? revision! : null,
    };
  };
  const newer = (left: ReturnType<typeof rank>, right: ReturnType<typeof rank>) => {
    if (left.revision != null && right.revision != null && left.revision !== right.revision) {
      return left.revision > right.revision;
    }
    if (left.observedAt !== right.observedAt) return left.observedAt > right.observedAt;
    return (left.revision ?? -Infinity) > (right.revision ?? -Infinity);
  };
  const merged: SavedMarket = { ...current, ...incoming };
  if (newer(
    rank(current.canonicalApyObservedAt, current.canonicalApyRevision),
    rank(incoming.canonicalApyObservedAt, incoming.canonicalApyRevision),
  )) {
    merged.canonicalApyPct = current.canonicalApyPct ?? null;
    merged.canonicalApyUnavailableReason = current.canonicalApyUnavailableReason ?? null;
    merged.canonicalApyOutcome = current.canonicalApyOutcome ?? null;
    merged.canonicalApyObservedAt = current.canonicalApyObservedAt ?? null;
    merged.canonicalApySource = current.canonicalApySource ?? null;
    merged.canonicalApyRevision = current.canonicalApyRevision ?? null;
    merged.canonicalCurrentRoiPct = current.canonicalCurrentRoiPct ?? null;
    merged.canonicalCurrentRoiStatus = current.canonicalCurrentRoiStatus ?? null;
    merged.canonicalCurrentRoiUnavailableReason = current.canonicalCurrentRoiUnavailableReason ?? null;
    merged.canonicalCurrentProfit = current.canonicalCurrentProfit ?? null;
    merged.canonicalCurrentProfitStatus = current.canonicalCurrentProfitStatus ?? null;
    merged.canonicalCurrentProfitUnavailableReason = current.canonicalCurrentProfitUnavailableReason ?? null;
    merged.canonicalCurrentStrategy = current.canonicalCurrentStrategy ?? null;
    merged.canonicalCurrentDaysToExpiry = current.canonicalCurrentDaysToExpiry ?? null;
    merged.canonicalCurrentExpiryAt = current.canonicalCurrentExpiryAt ?? null;
    merged.canonicalCurrentRevision = current.canonicalCurrentRevision ?? null;
  }
  if (newer(
    rank(current.lastScanResult?.scannedAt, current.lastScanResult?.publicationGeneration),
    rank(incoming.lastScanResult?.scannedAt, incoming.lastScanResult?.publicationGeneration),
  )) merged.lastScanResult = current.lastScanResult;
  if (newer(
    rank(current.liveResult?.scannedAt, current.liveResult?.publicationGeneration),
    rank(incoming.liveResult?.scannedAt, incoming.liveResult?.publicationGeneration),
  )) merged.liveResult = current.liveResult;
  return merged;
}

/**
 * Watcher results intentionally carry only ROI summaries for HOT markets. They
 * are newer than the poller's full result, but cannot populate executable
 * Market prices rows. Prefer them only when they actually contain venue ids and
 * prices; otherwise retain the full persisted scan until quick-prices returns.
 */
export function selectSavedMarketPriceCache(
  market: Pick<SavedMarket, 'lastScanResult' | 'liveResult'>,
): LastScanResult | NonNullable<SavedMarket['liveResult']> | null {
  const live = market.liveResult;
  const hasLivePrices = Array.isArray(live?.allArbs) && live.allArbs.some((candidate) => {
    const priced = candidate as NonNullable<LastScanResult['allArbs']>[number];
    return typeof priced.kalshiTicker === 'string' && priced.kalshiTicker !== '' &&
      typeof priced.pmConditionId === 'string' && priced.pmConditionId !== '' &&
      priced.kalshiYesAsk != null && priced.pmYesPrice != null;
  });
  return hasLivePrices ? live! : market.lastScanResult ?? null;
}

export function getSavedMarketLastSuccessAt(market: SavedMarket): string | null {
  if (market.scheduler?.lastSuccessAt) return market.scheduler.lastSuccessAt;
  const status = market.lastScanResult?.matchStatus;
  return status === 'matched' || status === 'confirmed_zero'
    ? market.lastScanResult?.scannedAt ?? null
    : null;
}

export function applyDurableFullScanToSavedMarket(
  market: SavedMarket,
  scan: Pick<ScanResult, 'outcomes' | 'kalshiCount' | 'pmCount' | 'matchedCount'> & { fullScanPersisted?: boolean; publicationGeneration?: number },
  scannedAt: string,
): SavedMarket {
  const liveResult = {
    ...summarizeScanForSidebar(scan.outcomes),
    scannedAt,
    kalshiCount: scan.kalshiCount,
    pmCount: scan.pmCount,
    matchedCount: scan.matchedCount,
  };
  if (scan.fullScanPersisted !== true) return { ...market, liveResult };
  const canonical = selectCanonicalSavedMarketMetrics(scan.outcomes.map((outcome) => ({
    artist: outcome.artist,
    ...outcome.arbitrage,
    totalStake: outcome.arbitrage.kalshiStake + outcome.arbitrage.pmStake,
  })), scannedAt);
  const freshnessSlaMs = market.scheduler?.freshnessSlaMs ?? 60 * 60_000;
  const scannedAtMs = Date.parse(scannedAt);
  const nextDueAt = new Date(scannedAtMs + freshnessSlaMs).toISOString();
  return {
    ...market,
    canonicalApyPct: canonical.value,
    canonicalApyUnavailableReason: canonical.unavailableReason,
    canonicalApyOutcome: canonical.outcome,
    canonicalApyObservedAt: canonical.observedAt,
    canonicalApySource: 'full_scan',
    canonicalApyRevision: Number.isSafeInteger(scan.publicationGeneration) ? scan.publicationGeneration! : null,
    canonicalCurrentRoiPct: canonical.roiPct,
    canonicalCurrentRoiStatus: canonical.roiStatus,
    canonicalCurrentRoiUnavailableReason: canonical.roiUnavailableReason,
    canonicalCurrentProfit: canonical.profit,
    canonicalCurrentProfitStatus: canonical.profitStatus,
    canonicalCurrentProfitUnavailableReason: canonical.profitUnavailableReason,
    canonicalCurrentStrategy: canonical.strategy,
    canonicalCurrentDaysToExpiry: canonical.daysToExpiry,
    canonicalCurrentExpiryAt: canonical.expiryAt,
    canonicalCurrentRevision: Number.isSafeInteger(scan.publicationGeneration) ? scan.publicationGeneration! : null,
    scheduler: {
      ...market.scheduler,
      lastSuccessAt: scannedAt,
      nextDueAt,
      inProgress: false,
      failureReason: null,
      retryCount: 0,
      freshnessSlaMs,
    },
    liveResult,
  };
}

export interface ScanResult {
  eventTitle: string;
  kalshiCount: number;
  pmCount: number;
  matchedCount: number;
  expiryDate?: string;
  category?: string;
  kalshiRawCount?: number;
  pmRawCount?: number;
  pmFilteredCount?: number;
  kalshiFetchSource?: string;
  clobHitCount?: number;
  clobMissCount?: number;
  expired?: boolean;
  noPrices?: boolean;
  platformWarnings?: string[];
  refreshStatus?: 'complete' | 'partial' | 'failed';
  retryable?: boolean;
  fullScanPersisted?: boolean;
  publicationGeneration?: number;
  _priceDataObservedAt?: string | null;
  refreshLifecycle?: { requestedAt: string; structureFetchedAt: string | null; completedAt: string };
  pmRefresh?: import('@/lib/quick-prices').QuickPmRefresh;
  platformDiagnostics?: Record<'kalshi' | 'polymarket', {
    status: 'fresh' | 'partial' | 'empty' | 'failed';
    count: number;
    reason?: string;
  }>;
  outcomes: UnifiedOutcome[];
  unmatchedKalshi: UnmatchedKalshi[];
  unmatchedPolymarket: UnmatchedPolymarket[];
}

/** Merge a scoped quick refresh without promoting last-known failed-venue quotes
 * to current executable data. Genuine empty results are not retained. */
export function mergeQuickPricesResult(previous: ScanResult, incoming: ScanResult): ScanResult {
  const kalshiFailed = incoming.platformDiagnostics?.kalshi.status === 'failed';
  const polymarketFailed = incoming.platformDiagnostics?.polymarket.status === 'failed';
  const previousByArtist = new Map(previous.outcomes.map((outcome) => [outcome.artist, outcome]));
  const incomingByArtist = new Map(incoming.outcomes.map((outcome) => [outcome.artist, outcome]));
  const artists = new Set([...previousByArtist.keys(), ...incomingByArtist.keys()]);
  const outcomes = [...artists].map((artist) => {
    const old = previousByArtist.get(artist);
    const fresh = incomingByArtist.get(artist);
    if (!old) return fresh!;
    if (!fresh && !kalshiFailed && !polymarketFailed) return null;
    const kalshi = kalshiFailed ? old.kalshi : fresh?.kalshi ?? null;
    const polymarket = polymarketFailed ? old.polymarket : fresh?.polymarket ?? null;
    const kalshiOutcomeStale = kalshiFailed || fresh?.kalshiStale === true;
    const polymarketOutcomeStale = polymarketFailed || fresh?.polymarketStale === true;
    const stale = kalshiOutcomeStale || polymarketOutcomeStale;
    const arbitrage = stale
      ? {
          ...(fresh?.arbitrage ?? old.arbitrage),
          expectedProfit: 0,
          roiPct: 0,
          apyPct: null,
          kalshiStake: 0,
          pmStake: 0,
          maxCapital: 0,
          depthVerified: false,
          strategy: 'Unavailable — stale outcome data',
        }
      : fresh?.arbitrage ?? old.arbitrage;
    return {
      ...old,
      ...fresh,
      kalshi,
      polymarket,
      arbitrage,
      kalshiStale: kalshiOutcomeStale,
      polymarketStale: polymarketOutcomeStale,
    };
  }).filter((outcome): outcome is UnifiedOutcome => outcome !== null);
  return { ...previous, ...incoming, outcomes };
}

/* ── Utility helpers ── */
export function formatPercent(n: number): string {
  return Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n / 100);
}

export function summarizeScanForSidebar(outcomes: UnifiedOutcome[]): Pick<LastScanResult, "bestRoiPct" | "bestProfit" | "strategy"> {
  const candidates = outcomes.filter((outcome) =>
    outcome.arbitrage
    && outcome.arbitrage.strategy !== "No arb"
    && !outcome.arbitrage.suspicious,
  );
  if (candidates.length === 0) {
    return { bestRoiPct: 0, bestProfit: 0, strategy: "No arb" };
  }
  const best = candidates.reduce((current, outcome) =>
    outcome.arbitrage.roiPct > current.arbitrage.roiPct ? outcome : current,
  );
  return {
    bestRoiPct: best.arbitrage.roiPct,
    bestProfit: best.arbitrage.expectedProfit,
    strategy: best.arbitrage.strategy,
  };
}

export function formatCurrency(dollars: number): string {
  return Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(dollars);
}

/**
 * Adaptive precision price formatting for probability prices (0–1 range).
 * >= $0.01 → 2 decimals (e.g. "$0.50")
 * > 0 and < $0.01 → 4 decimals (e.g. "$0.0040")
 * null/undefined/0 → "—"
 */
export function formatPrice(price: number | null | undefined): string {
  if (price == null || price === 0) return "—";
  if (price >= 0.01) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(4)}`;
}

/** Sum of all positive expected profits from allArbs */
export function getTotalProfit(allArbs?: { expectedProfit: number }[] | null): number {
  if (!allArbs) return 0;
  return allArbs
    .filter(a => a.expectedProfit > 0)
    .reduce((sum, a) => sum + a.expectedProfit, 0);
}

/** Format profit display: "$15.00" for single position, "$15.00 ($24.00 total)" for multiple */
export function formatProfitDisplay(bestProfit: number, allArbs?: { expectedProfit: number }[] | null): string {
  if (bestProfit === 0) return "";
  const profitableCount = allArbs ? allArbs.filter(a => a.expectedProfit > 0).length : 0;
  if (profitableCount <= 1) {
    return formatCurrency(bestProfit);
  }
  const totalProfit = getTotalProfit(allArbs);
  return `${formatCurrency(bestProfit)} (${formatCurrency(totalProfit)} total)`;
}

/** Sum of all positive expected profits from scan outcomes */
export function getTotalProfitFromOutcomes(outcomes: UnifiedOutcome[]): number {
  return outcomes
    .filter(o => o.arbitrage.expectedProfit > 0)
    .reduce((sum, o) => sum + o.arbitrage.expectedProfit, 0);
}

export function formatExpiry(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function timeUntilExpiry(iso?: string | null, priceResolved?: boolean): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) {
    // BUG-05b: closeTime passed but prices still trading → in-play, not expired
    return priceResolved === false ? "In play" : "Expired";
  }
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

/** Compact relative time: "2min", "1h", "3d". No "ago" suffix. */
export function formatRelativeTime(iso?: string | null): string {
  if (!iso) return "—";
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}min`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d`;
}

/** Check whether a saved market has at least one matched outcome pair */
export function isMatched(m: SavedMarket): boolean {
  if (m.liveResult && m.liveResult.allArbs && m.liveResult.allArbs.length > 0) return true;
  return (m.lastScanResult?.matchedCount ?? 0) > 0;
}

export function getCanonicalMatchState(market: SavedMarket): {
  status: NonNullable<LastScanResult['matchStatus']>;
  count: number;
  error?: string;
} {
  const liveScannedAt = Date.parse(market.liveResult?.scannedAt ?? '');
  const persistedScannedAt = Date.parse(market.lastScanResult?.scannedAt ?? '');
  const liveIsCurrent = market.liveResult != null && (
    !Number.isFinite(persistedScannedAt) ||
    (Number.isFinite(liveScannedAt) && liveScannedAt >= persistedScannedAt)
  );
  const scan = liveIsCurrent ? market.liveResult : market.lastScanResult;
  if (!scan || !scan.scannedAt || scan.strategy === 'Not scanned') {
    return { status: 'not_scanned', count: 0 };
  }
  const pairCount = scan.matchedPairs?.length;
  const scanCount = pairCount != null && pairCount > 0
    ? pairCount
    : scan.matchStatus === 'confirmed_zero'
      ? 0
      : scan.matchedCount ?? 0;
  const retainedCount = scan.matchStatus === 'unavailable' || scan.matchStatus === 'refreshing'
    ? Math.max(scanCount, market.lastScanResult?.matchedCount ?? 0)
    : scanCount;
  const count = retainedCount;
  const status = scan.matchStatus ?? (count > 0 ? 'matched' : 'confirmed_zero');
  return { status, count, error: scan.matchError };
}

export function formatCanonicalMatchState(market: SavedMarket): string {
  const state = getCanonicalMatchState(market);
  if (state.status === 'not_scanned') return 'Not scanned';
  if (state.status === 'refreshing') return state.count > 0 ? `${state.count} matched · Refreshing` : 'Refreshing';
  if (state.status === 'unavailable') {
    const unavailable = `Unavailable${state.error ? `: ${state.error}` : ''}`;
    return state.count > 0 ? `${state.count} matched · ${unavailable}` : unavailable;
  }
  return `${state.count} matched`;
}

type SavedMarketMatchRefresh = Pick<LastScanResult,
  'matchedCount' | 'matchStatus' | 'matchError' | 'matchedPairs' | 'scannedAt'>;

/** Preserve the last authoritative pair set while exposing refresh/error state. */
export function mergeSavedMarketMatchRefresh(
  market: SavedMarket,
  refresh: SavedMarketMatchRefresh,
): SavedMarket {
  const previous = market.lastScanResult;
  const retainConfirmed = refresh.matchStatus === 'unavailable' || refresh.matchStatus === 'refreshing';
  return {
    ...market,
    lastScanResult: {
      ...(previous ?? {
        bestRoiPct: 0, bestProfit: 0, strategy: 'No arb', outcomeCount: 0,
        kalshiCount: 0, pmCount: 0, allArbs: [],
      }),
      scannedAt: retainConfirmed ? previous?.scannedAt ?? refresh.scannedAt : refresh.scannedAt,
      matchedCount: retainConfirmed ? previous?.matchedCount ?? 0 : refresh.matchedCount,
      matchStatus: refresh.matchStatus,
      matchError: refresh.matchError,
      matchedPairs: retainConfirmed ? previous?.matchedPairs ?? [] : refresh.matchedPairs ?? [],
    },
  };
}

export function markSavedMarketMatchRefreshing(market: SavedMarket): SavedMarket {
  return mergeSavedMarketMatchRefresh(market, {
    matchedCount: market.lastScanResult?.matchedCount ?? 0,
    matchStatus: 'refreshing',
    matchedPairs: market.lastScanResult?.matchedPairs ?? [],
    scannedAt: market.lastScanResult?.scannedAt ?? null,
  });
}

/** BUG-05b: Check if prices are at resolution extremes (one side >=99%, other <=1%).
 *  Prices are decimal (0.99 = 99%). Returns true only when at least one matched
 *  outcome shows a clear resolution signal on BOTH Kalshi and Polymarket. */
export function pricesAtResolution(scan: { priceResolved?: boolean } | null | undefined): boolean {
  if (!scan) return false;
  return scan.priceResolved === true;
}

/** BUG-05b: Detect resolution extremes in a set of matched outcomes.
 *  Returns true if at least one outcome has prices pinned at 99/1 (or 1/99)
 *  on BOTH Kalshi and Polymarket. Prices are decimal (0.99 = 99%).
 *  This is the signal that a market has actually resolved, not just that
 *  closeTime has passed (in-play markets still trade at 68/32 etc). */
export function computePriceResolved(outcomes: { kalshi: { yesAsk: number; noAsk: number } | null; polymarket: { yesPrice: number; noPrice: number } | null }[]): boolean {
  const RES_THRESHOLD = 0.99;  // >=99% on one side
  const OTHER_THRESHOLD = 0.01; // <=1% on the other
  return outcomes.some(o => {
    if (!o.kalshi || !o.polymarket) return false;
    // Kalshi YES resolved (yesAsk >= 0.99, noAsk <= 0.01) AND PM YES resolved
    const kYesRes = o.kalshi.yesAsk >= RES_THRESHOLD && o.kalshi.noAsk <= OTHER_THRESHOLD;
    const kNoRes  = o.kalshi.noAsk >= RES_THRESHOLD && o.kalshi.yesAsk <= OTHER_THRESHOLD;
    const pYesRes = o.polymarket.yesPrice >= RES_THRESHOLD && o.polymarket.noPrice <= OTHER_THRESHOLD;
    const pNoRes  = o.polymarket.noPrice >= RES_THRESHOLD && o.polymarket.yesPrice <= OTHER_THRESHOLD;
    // Both platforms must agree on resolution (same direction or at least both at extremes)
    return (kYesRes && pYesRes) || (kNoRes && pNoRes) || (kYesRes && pNoRes) || (kNoRes && pYesRes);
  });
}

/** BUG-05b: Smart expiry detection.
 *  A market is truly expired ONLY when:
 *  1. closeTime has passed (expiryDate < now) AND prices are at resolution extremes (>=99/<=1)
 *  2. OR PM explicitly reports the market as closed (pmClosed)
 *  In-play markets with trading prices (e.g. 68/32) are NOT expired even if closeTime passed. */
export function isMarketExpired(m: SavedMarket): boolean {
  // PM's own closed signal is authoritative regardless of prices
  if (m.lastScanResult?.pmClosed) return true;

  const expiryMs = m.expiryDate ? new Date(m.expiryDate).getTime() : 0;
  if (expiryMs > 0 && expiryMs <= Date.now()) {
    // closeTime passed — check if prices are at resolution extremes
    const scan = m.liveResult ?? m.lastScanResult;
    if (pricesAtResolution(scan)) return true;
    // closeTime passed but prices still trading → NOT expired (in-play market)
    return false;
  }
  return false;
}


// ─── Types used across components ───
export type OverviewSort = "name" | "roi" | "expiry" | "apy" | "profit" | "strategy" | "matched" | "arbs" | "scanned";

export function getTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
