import { detectPlatformFromUrl, type PlatformId } from './platforms/registry';
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

/**
 * Normalize scan input at the API boundary. The canonical shape is a list of
 * platform links, but legacy named URL fields remain accepted while callers
 * migrate. Unknown platforms are retained for future adapters; current scan
 * execution still requires one Kalshi and one Polymarket link.
 */
export function resolveScanLinks(payload: ScanLinkPayload): ResolvedScanLinks {
  const platformLinks: MarketLink[] = Array.isArray(payload.platformLinks)
    ? payload.platformLinks
        .filter((link: unknown): link is { url: string; platform?: string } =>
          typeof (link as { url?: unknown })?.url === 'string')
        .map(link => {
          const platform = link.platform ?? detectPlatformFromUrl(link.url);
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
