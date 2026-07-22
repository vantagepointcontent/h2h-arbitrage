/**
 * Platform Registry — the single source of truth for all trading platforms.
 *
 * Adding a new platform = adding a config entry here. No other code changes
 * required for the platform to be recognized, its links detected, and its
 * icon rendered in the UI.
 *
 * Existing Polymarket and Kalshi code is wrapped via thin adapter shims
 * (see adapters/ directory) so the hardcoded implementations continue to
 * work unchanged while new platforms use the adapter interface.
 */

// ── Core Types ────────────────────────────────────────────────────────

export type PlatformId = string; // 'polymarket' | 'kalshi' | 'ibkr' | ...

export interface PlatformConfig {
  /** Unique identifier used throughout the codebase */
  id: PlatformId;
  /** Human-readable display name */
  name: string;
  /** Short label for compact UI (e.g. badges, tables) */
  shortName: string;
  /** Icon path relative to /public (served at root) */
  iconPath: string;
  /** Brand color (hex) for UI accents */
  color: string;
  /** Base API URL for market data */
  apiBaseUrl: string;
  /** URL pattern(s) that identify this platform's market/event URLs */
  urlPatterns: RegExp[];
  /** Credential keys required for trading (empty = read-only/no trade) */
  credentialKeys: string[];
  /** Whether this platform is currently enabled/active */
  enabled: boolean;
  /** Whether the adapter implementation exists (vs stub) */
  adapterReady: boolean;
  /** Market data format — how outcomes/prices are structured */
  dataFormat: 'kalshi-native' | 'polymarket-gamma' | 'ibkr-native' | 'generic';
  /** Fee model identifier used by the fee calculation system */
  feeModel: 'kalshi' | 'polymarket' | 'ibkr' | 'generic';
  /** WS support for live orderbook streaming */
  supportsWebSocket: boolean;
  /** Sort order for UI display (lower = first) */
  sortOrder: number;
}

// ── Platform Definitions ──────────────────────────────────────────────

export const PLATFORMS: Record<PlatformId, PlatformConfig> = {
  polymarket: {
    id: 'polymarket',
    name: 'Polymarket',
    shortName: 'PM',
    iconPath: '/polymarket-icon.png',
    color: '#1652f0',
    apiBaseUrl: 'https://gamma-api.polymarket.com',
    urlPatterns: [/polymarket\.com/i],
    credentialKeys: [
      'POLYMARKET_PRIVATE_KEY',
      'POLYMARKET_API_KEY',
      'POLYMARKET_API_SECRET',
      'POLYMARKET_API_PASSPHRASE',
    ],
    enabled: true,
    adapterReady: true,
    dataFormat: 'polymarket-gamma',
    feeModel: 'polymarket',
    supportsWebSocket: true,
    sortOrder: 1,
  },
  kalshi: {
    id: 'kalshi',
    name: 'Kalshi',
    shortName: 'KS',
    iconPath: '/kalshi-icon.png',
    color: '#1a1a1a',
    apiBaseUrl: 'https://external-api.kalshi.com/trade-api/v2',
    urlPatterns: [/kalshi\.com/i],
    credentialKeys: [
      'KALSHI_API_KEY_ID',
      'KALSHI_API_PRIVATE_KEY',
    ],
    enabled: true,
    adapterReady: true,
    dataFormat: 'kalshi-native',
    feeModel: 'kalshi',
    supportsWebSocket: true,
    sortOrder: 2,
  },
  ibkr: {
    id: 'ibkr',
    name: 'Interactive Brokers',
    shortName: 'IBKR',
    iconPath: '/ibkr-icon.png',
    color: '#d4261e',
    apiBaseUrl: '',
    urlPatterns: [/interactivebrokers\.com/i, /ibkr\.com/i],
    credentialKeys: [],
    enabled: false,
    adapterReady: false,
    dataFormat: 'ibkr-native',
    feeModel: 'ibkr',
    supportsWebSocket: false,
    sortOrder: 3,
  },
};

// ── Registry API ──────────────────────────────────────────────────────

/** Get a platform config by id. Throws if not found. */
export function getPlatform(id: PlatformId): PlatformConfig {
  const p = PLATFORMS[id];
  if (!p) throw new Error(`Unknown platform: ${id}`);
  return p;
}

/** Get a platform config by id, or null if not found. */
export function getPlatformOrNull(id: PlatformId): PlatformConfig | null {
  return PLATFORMS[id] ?? null;
}

/** Get all registered platforms. */
export function getAllPlatforms(): PlatformConfig[] {
  return Object.values(PLATFORMS).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Get all enabled platforms. */
export function getEnabledPlatforms(): PlatformConfig[] {
  return getAllPlatforms().filter(p => p.enabled);
}

/** Get all platforms with ready adapters (can fetch market data). */
export function getAdapterReadyPlatforms(): PlatformConfig[] {
  return getAllPlatforms().filter(p => p.adapterReady && p.enabled);
}

/**
 * Detect which platform a URL belongs to.
 * Returns the PlatformId or null if no match.
 */
export function detectPlatformFromUrl(url: string): PlatformId | null {
  if (!url) return null;
  for (const platform of getAllPlatforms()) {
    for (const pattern of platform.urlPatterns) {
      if (pattern.test(url)) {
        return platform.id;
      }
    }
  }
  return null;
}

/**
 * Get the icon path for a platform.
 * Falls back to a placeholder if the platform's icon doesn't exist.
 */
export function getPlatformIcon(platformId: PlatformId): string {
  const p = getPlatformOrNull(platformId);
  return p?.iconPath ?? '/platform-placeholder.png';
}

/**
 * Get the short name for a platform.
 * Falls back to the id if not found.
 */
export function getPlatformShortName(platformId: PlatformId): string {
  const p = getPlatformOrNull(platformId);
  return p?.shortName ?? platformId;
}

/**
 * Get the display name for a platform.
 * Falls back to the id if not found.
 */
export function getPlatformName(platformId: PlatformId): string {
  const p = getPlatformOrNull(platformId);
  return p?.name ?? platformId;
}

/**
 * Check if a platform is enabled and its adapter is ready.
 */
export function isPlatformOperational(platformId: PlatformId): boolean {
  const p = getPlatformOrNull(platformId);
  return p?.enabled === true && p?.adapterReady === true;
}

// ── Legacy Compatibility Helpers ──────────────────────────────────────
// These provide backward-compatible access for code that hasn't been
// migrated yet. They map old hardcoded platform identifiers to the
// registry so existing code keeps working without changes.

/** Map old 'pm' / 'polymarket' identifiers to the registry id */
export function normalizePlatformId(id: string): PlatformId {
  const lower = id.toLowerCase();
  if (lower === 'pm' || lower === 'poly' || lower === 'polymarket') return 'polymarket';
  if (lower === 'ks' || lower === 'kalshi') return 'kalshi';
  return lower;
}

/**
 * Get the two currently-active platforms for backward compatibility.
 * This returns the first two enabled, adapter-ready platforms — which
 * today is always [polymarket, kalshi] in sortOrder.
 *
 * Code that still expects a fixed two-platform model can use this
 * until it's migrated to the N-platform model.
 */
export function getActivePlatformPair(): [PlatformConfig, PlatformConfig] {
  const ready = getAdapterReadyPlatforms();
  if (ready.length < 2) {
    throw new Error('Less than 2 adapter-ready platforms available');
  }
  return [ready[0], ready[1]];
}

/**
 * Convenience: the "primary" platform (first in sort order).
 * Today this is Polymarket.
 */
export function getPrimaryPlatform(): PlatformConfig {
  const ready = getAdapterReadyPlatforms();
  if (ready.length === 0) {
    throw new Error('No adapter-ready platforms available');
  }
  return ready[0];
}

/**
 * Convenience: the "secondary" platform (second in sort order).
 * Today this is Kalshi.
 */
export function getSecondaryPlatform(): PlatformConfig {
  const ready = getAdapterReadyPlatforms();
  if (ready.length < 2) {
    throw new Error('Less than 2 adapter-ready platforms available');
  }
  return ready[1];
}