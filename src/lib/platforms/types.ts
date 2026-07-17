/**
 * Platform-agnostic market data model.
 *
 * These types represent normalized market data that works across all
 * platforms. Platform-specific adapters convert their native format
 * into these types so the rest of the system (matcher, scanner, UI)
 * doesn't need to know about individual platform APIs.
 *
 * Platform-specific fields that don't have a common equivalent are
 * stored in the `raw` field and accessed via the adapter's mapper methods.
 */

import type { PlatformId } from './registry';

// ── Common Types ──────────────────────────────────────────────────────

export interface PlatformOutcome {
  /** Platform-native identifier for this outcome (ticker, conditionId, etc.) */
  nativeId: string;
  /** Human-readable outcome name (e.g. "Yes", "No", "Team A", "Team B") */
  name: string;
  /** Current YES/ask price (0-1) */
  yesPrice: number;
  /** Current NO/bid price (0-1) */
  noPrice: number;
  /** Best bid price (0-1) */
  bestBid: number;
  /** Best ask price (0-1) */
  bestAsk: number;
  /** Last traded price (0-1) */
  lastPrice: number;
  /** 24h volume in USD (optional) */
  volume24h?: number;
  /** Orderbook depth at the ask (optional, in contracts) */
  askDepth?: number;
  /** Orderbook depth at the bid (optional, in contracts) */
  bidDepth?: number;
  /** Whether this is a neg-risk outcome (independent YES/NO, not complementary) */
  negRisk?: boolean;
  /** Platform-specific raw data */
  raw?: unknown;
}

export interface PlatformMarket {
  /** Platform that this market belongs to */
  platform: PlatformId;
  /** Platform-native market identifier */
  marketId: string;
  /** Human-readable market question/title */
  title: string;
  /** URL to the market page on the platform */
  url: string;
  /** Market close/expiry time (ISO 8601) */
  closeTime?: string;
  /** Category (sports, politics, crypto, etc.) */
  category?: string;
  /** Outcomes for this market (usually 2 for binary, more for multi-outcome) */
  outcomes: PlatformOutcome[];
  /** Whether the market is active/tradable */
  active: boolean;
  /** Whether the market is closed/resolved */
  closed: boolean;
  /** Platform-specific raw data */
  raw?: unknown;
}

export interface PlatformEvent {
  /** Platform that this event belongs to */
  platform: PlatformId;
  /** Platform-native event identifier */
  eventId: string;
  /** Human-readable event title */
  title: string;
  /** URL to the event page */
  url: string;
  /** Category */
  category?: string;
  /** Close/expiry time (ISO 8601) */
  closeTime?: string;
  /** All markets under this event */
  markets: PlatformMarket[];
}

// ── Link/Pair Types ───────────────────────────────────────────────────

/**
 * A single market link from the coupling UI.
 * The user enters a URL; the system detects which platform it belongs to.
 */
export interface MarketLink {
  /** The URL the user entered */
  url: string;
  /** Detected platform (from registry.detectPlatformFromUrl) */
  platform: PlatformId;
  /** Optional: user-selected platform (overrides auto-detection) */
  platformOverride?: PlatformId;
}

/**
 * A coupling pair — two or more market links that form an arbitrage pair.
 * Supports N platforms, not just 2.
 */
export interface CouplingPair {
  /** Unique pair id (hash of sorted URLs) */
  id: string;
  /** Links that form this pair (minimum 2) */
  links: MarketLink[];
  /** Human-readable title (auto-derived or user-set) */
  title: string;
  /** Category (optional) */
  category?: string;
  /** Created timestamp (ISO 8601) */
  createdAt: string;
  /** Whether this pair is favorited */
  favorite: boolean;
}

// ── Helper Functions ──────────────────────────────────────────────────

/**
 * Create a MarketLink from a URL, auto-detecting the platform.
 */
export function createMarketLink(url: string, platformOverride?: PlatformId): MarketLink {
  // Import here to avoid circular dependency at module load
  const { detectPlatformFromUrl } = require('./registry');
  const platform = platformOverride ?? detectPlatformFromUrl(url);
  if (!platform) {
    throw new Error(`Could not detect platform for URL: ${url}`);
  }
  return { url, platform, platformOverride };
}

/**
 * Check if a set of links forms a valid coupling pair.
 * A valid pair has at least 2 links from at least 2 different platforms.
 */
export function isValidCouplingPair(links: MarketLink[]): boolean {
  if (links.length < 2) return false;
  const platforms = new Set(links.map(l => l.platform));
  return platforms.size >= 2;
}

/**
 * Generate a stable id for a coupling pair from its URLs.
 */
export function pairIdFromUrls(urls: string[]): string {
  const sorted = [...urls].sort();
  return sorted.join('::');
}