export type SavedMarketLifecycleStatus =
  | 'fresh'
  | 'partial'
  | 'stale'
  | 'refreshing'
  | 'failed'
  | 'rate_limited'
  | 'credentials_unavailable'
  | 'not_scanned'
  | 'not_refreshed';

export interface SavedMarketLifecycleOperation {
  status: SavedMarketLifecycleStatus;
  attemptedAt: string | null;
  completedAt: string | null;
  observedAt: string | null;
  lastSuccessAt: string | null;
  reason: string | null;
}

export interface SavedMarketVenueLifecycle {
  status: 'fresh' | 'stale' | 'partial' | 'failed' | 'rate_limited' | 'credentials_unavailable' | 'unknown';
  observedAt: string | null;
  reason: string | null;
}

export interface SavedMarketLifecycle {
  overallStatus: Exclude<SavedMarketLifecycleStatus, 'not_scanned' | 'not_refreshed'>;
  fullScan: SavedMarketLifecycleOperation;
  manualRefresh: SavedMarketLifecycleOperation;
  venues: Record<'kalshi' | 'polymarket', SavedMarketVenueLifecycle>;
  cachedData: { status: 'available' | 'unavailable'; observedAt: string | null };
}

interface ScanLike {
  matchStatus?: string | null;
  matchError?: string | null;
  scannedAt?: string | null;
  publicationGeneration?: number | null;
  matchedCount?: number;
  allArbs?: unknown[];
  refreshStatus?: 'complete' | 'partial' | 'failed';
  refreshLifecycle?: {
    requestedAt?: string | null;
    structureFetchedAt?: string | null;
    completedAt?: string | null;
  };
  _priceDataObservedAt?: string | null;
  _kalshiFetchedAt?: string | null;
  _pmFetchedAt?: string | null;
  platformDiagnostics?: Partial<Record<'kalshi' | 'polymarket', {
    status: 'fresh' | 'partial' | 'empty' | 'failed';
    count: number;
    reason?: string;
  }>>;
}

interface SchedulerLike {
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  nextDueAt?: string | null;
  inProgress?: boolean;
  failureReason?: string | null;
  freshnessSlaMs?: number;
}

function formatAge(value: string | null, now: number): string {
  const parsed = timestamp(value);
  if (!Number.isFinite(parsed)) return 'unknown age';
  const seconds = Math.max(0, Math.round((now - parsed) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function statusPhrase(status: SavedMarketLifecycleStatus): string {
  if (status === 'rate_limited') return 'rate limited';
  if (status === 'credentials_unavailable') return 'credentials unavailable';
  return status.replaceAll('_', ' ');
}

interface LifecycleMarket {
  scheduler?: SchedulerLike | null;
  lastScanResult?: ScanLike | null;
  liveResult?: ScanLike | null;
  canonicalApyObservedAt?: string | null;
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

function classifyFailure(reason: string | null | undefined): 'failed' | 'rate_limited' | 'credentials_unavailable' {
  if (/(?:http\s*429|rate[ -]?limit|too many requests)/i.test(reason ?? '')) return 'rate_limited';
  if (/(?:credential|unauthori[sz]ed|forbidden|api[ _-]?key|http\s*(?:401|403))/i.test(reason ?? '')) {
    return 'credentials_unavailable';
  }
  return 'failed';
}

function successful(scan: ScanLike | null | undefined): boolean {
  return scan?.matchStatus === 'matched' || scan?.matchStatus === 'confirmed_zero';
}

function venueLifecycle(
  diagnostic: NonNullable<ScanLike['platformDiagnostics']>[keyof NonNullable<ScanLike['platformDiagnostics']>] | undefined,
  observedAt: string | null,
  stale: boolean,
): SavedMarketVenueLifecycle {
  if (!diagnostic) return { status: 'unknown', observedAt: null, reason: null };
  const reason = diagnostic.reason ?? null;
  if (diagnostic.status === 'failed') return { status: classifyFailure(reason), observedAt: null, reason };
  if (diagnostic.status === 'partial') return { status: 'partial', observedAt, reason };
  if (diagnostic.status === 'empty') return { status: 'failed', observedAt: null, reason };
  return { status: stale ? 'stale' : 'fresh', observedAt, reason };
}

export function buildSavedMarketLifecycle(
  market: LifecycleMarket,
  now = Date.now(),
  options: { manualFreshnessMs?: number } = {},
): SavedMarketLifecycle {
  const scheduler = market.scheduler;
  const full = market.lastScanResult;
  const fullSuccessAt = successful(full) && full?.scannedAt
    && timestamp(full.scannedAt) > timestamp(scheduler?.lastSuccessAt)
    ? full.scannedAt
    : scheduler?.lastSuccessAt ?? (successful(full) ? full?.scannedAt ?? null : null);
  const fullAttemptAt = scheduler?.lastAttemptAt ?? full?.scannedAt ?? null;
  const schedulerFailureIsCurrent = Boolean(scheduler?.failureReason)
    && (scheduler?.lastAttemptAt == null || timestamp(scheduler.lastAttemptAt) >= timestamp(fullSuccessAt));
  const fullAgeMs = fullSuccessAt ? Math.max(0, now - timestamp(fullSuccessAt)) : null;
  const fullFreshnessMs = scheduler?.freshnessSlaMs ?? 60 * 60_000;
  let fullStatus: SavedMarketLifecycleOperation['status'];
  let fullReason: string | null = null;
  if (scheduler?.inProgress) {
    fullStatus = 'refreshing';
    fullReason = 'A recurring full scan is currently running.';
  } else if (schedulerFailureIsCurrent) {
    fullStatus = classifyFailure(scheduler?.failureReason);
    fullReason = scheduler?.failureReason ?? null;
  } else if (!fullSuccessAt) {
    fullStatus = 'not_scanned';
    fullReason = 'No successful full scan is available yet.';
  } else if (fullAgeMs != null && fullAgeMs > fullFreshnessMs) {
    fullStatus = 'stale';
    fullReason = 'Full scan is past the freshness SLA.';
  } else {
    fullStatus = 'fresh';
  }

  const live = market.liveResult;
  const manualAttemptedAt = live?.refreshLifecycle?.requestedAt ?? null;
  const manualCompletedAt = live?.refreshLifecycle?.completedAt ?? null;
  const manualObservedAt = live?._priceDataObservedAt ?? null;
  const manualFreshnessMs = options.manualFreshnessMs ?? 10 * 60_000;
  const manualStale = manualObservedAt != null && now - timestamp(manualObservedAt) > manualFreshnessMs;
  let manualStatus: SavedMarketLifecycleOperation['status'] = 'not_refreshed';
  let manualReason: string | null = null;
  if (live?.matchStatus === 'refreshing' && live.refreshLifecycle) {
    manualStatus = 'refreshing';
  } else if (live?.refreshStatus === 'failed') {
    manualStatus = classifyFailure(live.platformDiagnostics?.kalshi?.reason
      ?? live.platformDiagnostics?.polymarket?.reason ?? null);
    manualReason = live.platformDiagnostics?.kalshi?.reason
      ?? live.platformDiagnostics?.polymarket?.reason ?? live.matchError ?? 'Manual refresh failed.';
  } else if (live?.refreshStatus === 'partial') {
    manualStatus = 'partial';
    manualReason = live.platformDiagnostics?.kalshi?.reason
      ?? live.platformDiagnostics?.polymarket?.reason ?? 'Manual refresh was partial.';
  } else if (live?.refreshStatus === 'complete') {
    manualStatus = manualStale ? 'stale' : 'fresh';
  }

  const cachedObservedAt = [market.canonicalApyObservedAt, fullSuccessAt, manualObservedAt]
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(timestamp(value)))
    .sort((left, right) => timestamp(right) - timestamp(left))[0] ?? null;
  const cachedAvailable = cachedObservedAt != null;
  const venueSource = live?.platformDiagnostics ? live : full;
  const venueStale = venueSource === live ? manualStale : fullStatus === 'stale';
  const venues = {
    kalshi: venueLifecycle(venueSource?.platformDiagnostics?.kalshi, venueSource?._kalshiFetchedAt ?? manualObservedAt, venueStale),
    polymarket: venueLifecycle(venueSource?.platformDiagnostics?.polymarket, venueSource?._pmFetchedAt ?? manualObservedAt, venueStale),
  };

  let overallStatus: SavedMarketLifecycle['overallStatus'];
  if (manualStatus === 'refreshing' || fullStatus === 'refreshing') overallStatus = 'refreshing';
  else if (manualStatus === 'partial' || (manualStatus === 'fresh' && fullStatus !== 'fresh')) overallStatus = 'partial';
  else if (manualStatus === 'stale') overallStatus = 'stale';
  else if (manualStatus === 'rate_limited' || manualStatus === 'credentials_unavailable' || manualStatus === 'failed') {
    overallStatus = manualStatus;
  }
  else if (manualStatus === 'fresh' || fullStatus === 'fresh') overallStatus = 'fresh';
  else if (fullStatus === 'stale') overallStatus = 'stale';
  else if (fullStatus === 'rate_limited') overallStatus = 'rate_limited';
  else if (fullStatus === 'credentials_unavailable') overallStatus = 'credentials_unavailable';
  else overallStatus = 'failed';

  return {
    overallStatus,
    fullScan: {
      status: fullStatus,
      attemptedAt: fullAttemptAt,
      completedAt: successful(full) ? full?.scannedAt ?? null : null,
      observedAt: fullSuccessAt,
      lastSuccessAt: fullSuccessAt,
      reason: fullReason,
    },
    manualRefresh: {
      status: manualStatus,
      attemptedAt: manualAttemptedAt,
      completedAt: manualCompletedAt,
      observedAt: manualObservedAt,
      lastSuccessAt: live?.refreshStatus === 'complete' ? manualObservedAt : null,
      reason: manualReason,
    },
    venues,
    cachedData: { status: cachedAvailable ? 'available' : 'unavailable', observedAt: cachedObservedAt },
  };
}

export function formatSavedMarketLifecycleSummary(
  lifecycle: SavedMarketLifecycle,
  now = Date.now(),
): { label: string; reason: string | null } {
  const cachedAge = formatAge(lifecycle.cachedData.observedAt, now);
  const cachedSuffix = lifecycle.cachedData.status === 'available'
    ? ` · showing data from ${cachedAge}`
    : ' · no cached data available';
  const fullFailure = ['failed', 'rate_limited', 'credentials_unavailable'].includes(lifecycle.fullScan.status)
    ? lifecycle.fullScan : null;
  const manualFailure = ['failed', 'rate_limited', 'credentials_unavailable'].includes(lifecycle.manualRefresh.status)
    ? lifecycle.manualRefresh : null;

  if (lifecycle.manualRefresh.status === 'refreshing') {
    return { label: `Refreshing prices${cachedSuffix}`, reason: lifecycle.manualRefresh.reason };
  }
  if (lifecycle.fullScan.status === 'refreshing') {
    return { label: `Scanning${cachedSuffix}`, reason: lifecycle.fullScan.reason };
  }
  if (lifecycle.manualRefresh.status === 'partial') {
    const fullSuffix = fullFailure ? ` · last scan ${statusPhrase(fullFailure.status)}` : '';
    return {
      label: `Partial refresh${fullSuffix}${cachedSuffix}`,
      reason: lifecycle.manualRefresh.reason ?? fullFailure?.reason ?? null,
    };
  }
  if (manualFailure) {
    return {
      label: `Last refresh ${statusPhrase(manualFailure.status)}${cachedSuffix}`,
      reason: manualFailure.reason,
    };
  }
  if (lifecycle.manualRefresh.status === 'fresh' && fullFailure) {
    return {
      label: `Prices refreshed · last scan ${statusPhrase(fullFailure.status)}${cachedSuffix}`,
      reason: fullFailure.reason,
    };
  }
  if (fullFailure) {
    return {
      label: `Last scan ${statusPhrase(fullFailure.status)}${cachedSuffix}`,
      reason: fullFailure.reason,
    };
  }
  if (lifecycle.overallStatus === 'stale') {
    return { label: `Stale · showing data from ${cachedAge}`, reason: lifecycle.manualRefresh.reason ?? lifecycle.fullScan.reason };
  }
  if (lifecycle.cachedData.status === 'available') {
    return { label: cachedAge, reason: null };
  }
  return { label: 'Unavailable · Never', reason: lifecycle.fullScan.reason ?? lifecycle.manualRefresh.reason };
}
