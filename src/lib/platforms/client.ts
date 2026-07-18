/**
 * Client-safe platform configuration.
 *
 * This is a static mirror of the server-side registry that can be imported
 * in client components ("use client") without pulling in server-only deps.
 * The registry.ts module is the source of truth — keep this in sync when
 * adding platforms.
 *
 * Usage in components:
 *   import { PlatformIcon, getPlatformName, detectPlatformFromUrl } from '@/lib/platforms/client';
 */

export type PlatformId = 'polymarket' | 'kalshi' | 'opinion' | 'ibkr' | string;

export interface ClientPlatformConfig {
  id: PlatformId;
  name: string;
  shortName: string;
  iconPath: string;
  color: string;
  enabled: boolean;
  adapterReady: boolean;
  sortOrder: number;
}

// ── Static platform definitions (mirror of registry.ts) ──

export const CLIENT_PLATFORMS: Record<PlatformId, ClientPlatformConfig> = {
  polymarket: {
    id: 'polymarket',
    name: 'Polymarket',
    shortName: 'PM',
    iconPath: '/polymarket-icon.png',
    color: '#1652f0',
    enabled: true,
    adapterReady: true,
    sortOrder: 1,
  },
  kalshi: {
    id: 'kalshi',
    name: 'Kalshi',
    shortName: 'KS',
    iconPath: '/kalshi-icon.png',
    color: '#1a1a1a',
    enabled: true,
    adapterReady: true,
    sortOrder: 2,
  },
  opinion: {
    id: 'opinion',
    name: 'Opinion',
    shortName: 'OP',
    iconPath: '/opinion-icon.png',
    color: '#6366f1',
    enabled: false,
    adapterReady: false,
    sortOrder: 3,
  },
  ibkr: {
    id: 'ibkr',
    name: 'Interactive Brokers',
    shortName: 'IBKR',
    iconPath: '/ibkr-icon.png',
    color: '#d4261e',
    enabled: false,
    adapterReady: false,
    sortOrder: 4,
  },
};

// ── URL detection patterns (mirror of registry.ts) ──

const URL_PATTERNS: Record<PlatformId, RegExp[]> = {
  polymarket: [/polymarket\.com/i],
  kalshi: [/kalshi\.com/i],
  opinion: [/opinion\.com/i, /opinion\.finance/i],
  ibkr: [/interactivebrokers\.com/i, /ibkr\.com/i],
};

/** Detect which platform a URL belongs to. Returns null if no match. */
export function detectPlatformFromUrl(url: string): PlatformId | null {
  if (!url) return null;
  for (const platformId of Object.keys(URL_PATTERNS)) {
    for (const pattern of URL_PATTERNS[platformId]) {
      if (pattern.test(url)) return platformId as PlatformId;
    }
  }
  return null;
}

/** Get platform config by id. Returns null if not found. */
export function getPlatform(id: PlatformId): ClientPlatformConfig | null {
  return CLIENT_PLATFORMS[id] ?? null;
}

/** Get all enabled platforms sorted by display order. */
export function getEnabledPlatforms(): ClientPlatformConfig[] {
  return Object.values(CLIENT_PLATFORMS)
    .filter(p => p.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Get all platforms with ready adapters. */
export function getAdapterReadyPlatforms(): ClientPlatformConfig[] {
  return Object.values(CLIENT_PLATFORMS)
    .filter(p => p.adapterReady && p.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Get the icon path for a platform. Falls back to placeholder. */
export function getPlatformIcon(platformId: PlatformId): string {
  return CLIENT_PLATFORMS[platformId]?.iconPath ?? '/platform-placeholder.png';
}

/** Get the short name for a platform (e.g. "PM", "KS"). */
export function getPlatformShortName(platformId: PlatformId): string {
  return CLIENT_PLATFORMS[platformId]?.shortName ?? platformId;
}

/** Get the display name for a platform. */
export function getPlatformName(platformId: PlatformId): string {
  return CLIENT_PLATFORMS[platformId]?.name ?? platformId;
}

/** Check if a platform is operational (enabled + adapter ready). */
export function isPlatformOperational(platformId: PlatformId): boolean {
  const p = CLIENT_PLATFORMS[platformId];
  return p?.enabled === true && p?.adapterReady === true;
}

// ── Legacy compat: map old identifiers ──

export function normalizePlatformId(id: string): PlatformId {
  const lower = id.toLowerCase();
  if (lower === 'pm' || lower === 'poly' || lower === 'polymarket') return 'polymarket';
  if (lower === 'ks' || lower === 'kalshi') return 'kalshi';
  return lower;
}