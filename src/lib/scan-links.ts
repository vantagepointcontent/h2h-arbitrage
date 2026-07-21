import { detectPlatformFromUrl, getPlatformOrNull, type PlatformId } from './platforms/registry';
import type { MarketLink } from './platforms/types';

export interface ScanLinkPayload {
  platformLinks?: unknown;
  kalshiUrl?: unknown;
  polymarketUrl?: unknown;
}

export interface ResolvedScanLinks {
  platformLinks: MarketLink[];
  kalshiUrl?: string;
  polymarketUrl?: string;
}

/** A recognized link whose platform cannot yet participate in a scan. */
export interface UnavailableScanPlatform {
  platform: PlatformId;
  name: string;
}

/**
 * Return recognized platforms that have no enabled, fetch-capable adapter.
 * This lets API routes explain why a valid-looking URL cannot be scanned
 * instead of falling through to a misleading missing-platform error.
 */
export function getUnavailableScanPlatforms(links: MarketLink[]): UnavailableScanPlatform[] {
  const seen = new Set<string>();
  return links.flatMap(link => {
    if (seen.has(link.platform)) return [];
    seen.add(link.platform);
    const config = getPlatformOrNull(link.platform);
    if (!config) return [{ platform: link.platform, name: link.platform }];
    if (!config.enabled || !config.adapterReady) {
      return [{ platform: config.id, name: config.name }];
    }
    return [];
  });
}

/**
 * Normalize scan input at the API boundary. The canonical shape is a list of
 * platform links, but legacy named URL fields remain accepted while callers
 * migrate. URL detection wins over a stale client-side platform selection so
 * a pasted link is never interpreted according to its input position.
 */
export function resolveScanLinks(payload: ScanLinkPayload): ResolvedScanLinks {
  const platformLinks: MarketLink[] = Array.isArray(payload.platformLinks)
    ? payload.platformLinks
        .filter((link: unknown): link is { url: string; platform?: string } =>
          typeof (link as { url?: unknown })?.url === 'string')
        .map(link => {
          const platform = detectPlatformFromUrl(link.url) ?? link.platform;
          return platform ? { url: link.url, platform: platform as PlatformId } : null;
        })
        .filter((link): link is MarketLink => link !== null)
    : [];

  return {
    platformLinks,
    kalshiUrl: platformLinks.find(link => link.platform === 'kalshi')?.url
      ?? (typeof payload.kalshiUrl === 'string' ? payload.kalshiUrl : undefined),
    polymarketUrl: platformLinks.find(link => link.platform === 'polymarket')?.url
      ?? (typeof payload.polymarketUrl === 'string' ? payload.polymarketUrl : undefined),
  };
}
