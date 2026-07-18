/**
 * Platform system barrel export.
 *
 * Import from '@/lib/platforms' to access the registry, types, and adapters.
 */

// Registry — platform definitions and lookup utilities
export {
  PLATFORMS,
  getPlatform,
  getPlatformOrNull,
  getAllPlatforms,
  getEnabledPlatforms,
  getAdapterReadyPlatforms,
  detectPlatformFromUrl,
  getPlatformIcon,
  getPlatformShortName,
  getPlatformName,
  isPlatformOperational,
  normalizePlatformId,
  getActivePlatformPair,
  getPrimaryPlatform,
  getSecondaryPlatform,
  type PlatformId,
  type PlatformConfig,
} from './registry';

// Types — platform-agnostic data model
export {
  createMarketLink,
  isValidCouplingPair,
  pairIdFromUrls,
  type PlatformMarket,
  type PlatformOutcome,
  type PlatformEvent,
  type MarketLink,
  type CouplingPair,
} from './types';

// Adapter — interface and adapter registry
export {
  getAdapter,
  getReadyAdapters,
  type PlatformAdapter,
  type OrderParams,
  type OrderResult,
  type Position,
} from './adapter';

// Client-safe utilities (for "use client" components)
export {
  CLIENT_PLATFORMS,
  detectPlatformFromUrl as detectPlatformFromUrlClient,
  getPlatform as getPlatformClient,
  getEnabledPlatforms as getEnabledPlatformsClient,
  getAdapterReadyPlatforms as getAdapterReadyPlatformsClient,
  getPlatformIcon as getPlatformIconClient,
  getPlatformShortName as getPlatformShortNameClient,
  getPlatformName as getPlatformNameClient,
  isPlatformOperational as isPlatformOperationalClient,
  normalizePlatformId as normalizePlatformIdClient,
  type ClientPlatformConfig,
} from './client';

// React component (client-side)
export { PlatformIcon, default as PlatformIconDefault } from './PlatformIcon';