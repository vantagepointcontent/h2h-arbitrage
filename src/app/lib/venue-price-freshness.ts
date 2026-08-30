export type VenuePriceFreshnessStatus = 'fresh' | 'stale_last_known' | 'unavailable'
  | 'failed' | 'rate_limited' | 'credentials_unavailable' | 'not_scanned';

export interface VenuePriceFreshness {
  status: VenuePriceFreshnessStatus;
  observedAt: string | null;
  source: 'saved-market-full-scan' | 'saved-market-quick-refresh' | null;
  reason: string | null;
}

export type VenuePriceFreshnessMap = Record<'kalshi' | 'polymarket', VenuePriceFreshness>;

type VenueScanFreshnessInput = {
  _kalshiFetchedAt?: string | null;
  _pmFetchedAt?: string | null;
  platformDiagnostics?: Partial<Record<'kalshi' | 'polymarket', {
    status: 'fresh' | 'partial' | 'empty' | 'failed';
    count?: number;
    reason?: string;
  }>>;
};

function failedVenueStatus(reason: string | null): VenuePriceFreshnessStatus {
  if (reason && /credential|api key|authentication|unauthorized/i.test(reason)) return 'credentials_unavailable';
  if (reason && /(?:http\s*429|rate[ -]?limit|too many requests)/i.test(reason)) return 'rate_limited';
  return 'failed';
}

export function venuePriceFreshnessFromScan(
  scan: VenueScanFreshnessInput,
  source: NonNullable<VenuePriceFreshness['source']>,
): VenuePriceFreshnessMap {
  const forVenue = (platform: 'kalshi' | 'polymarket'): VenuePriceFreshness => {
    const diagnostic = scan.platformDiagnostics?.[platform];
    const rawObservedAt = platform === 'kalshi' ? scan._kalshiFetchedAt : scan._pmFetchedAt;
    const observedAt = rawObservedAt && Number.isFinite(Date.parse(rawObservedAt)) ? rawObservedAt : null;
    const reason = diagnostic?.reason?.trim() || null;
    const label = platform === 'kalshi' ? 'Kalshi' : 'Polymarket';
    if (diagnostic?.status === 'fresh') {
      return observedAt
        ? { status: 'fresh', observedAt, source, reason: null }
        : { status: 'unavailable', observedAt: null, source: null, reason: `${label} refresh returned no trustworthy price timestamp` };
    }
    if (diagnostic?.status === 'failed') {
      return { status: failedVenueStatus(reason), observedAt: null, source: null, reason: reason ?? `${label} refresh failed` };
    }
    if (diagnostic?.status === 'partial') {
      return { status: 'stale_last_known', observedAt, source: observedAt ? source : null, reason: reason ?? `${label} refresh was partial` };
    }
    if (diagnostic?.status === 'empty') {
      return { status: 'unavailable', observedAt: null, source: null, reason: reason ?? `${label} returned no price data` };
    }
    return observedAt
      ? { status: 'fresh', observedAt, source, reason: null }
      : { status: 'not_scanned', observedAt: null, source: null, reason: `No ${label} price snapshot has been recorded` };
  };
  return { kalshi: forVenue('kalshi'), polymarket: forVenue('polymarket') };
}

export function mergeVenuePriceFreshness(
  previous: VenuePriceFreshnessMap | null | undefined,
  incoming: VenuePriceFreshnessMap,
): VenuePriceFreshnessMap {
  const mergeVenue = (platform: 'kalshi' | 'polymarket'): VenuePriceFreshness => {
    const next = incoming[platform];
    if (next.status === 'fresh' || next.observedAt) return next;
    const retained = previous?.[platform];
    return retained?.observedAt
      ? { ...retained, status: next.status, reason: next.reason }
      : next;
  };
  return { kalshi: mergeVenue('kalshi'), polymarket: mergeVenue('polymarket') };
}
