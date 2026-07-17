/**
 * PlatformIcon — dynamic platform icon component.
 *
 * Replaces hardcoded <img src="/kalshi-icon.png"> and <img src="/polymarket-icon.png">
 * throughout the UI. Loads icon path from the platform config so new platforms
 * get their icon automatically by adding a config entry.
 *
 * Usage:
 *   <PlatformIcon platform="kalshi" />           // by platform id
 *   <PlatformIcon platform="Kalshi" />           // by display name (legacy)
 *   <PlatformIcon platform="polymarket" size="sm" />
 *   <PlatformIcon url="https://polymarket.com/..." />  // auto-detect from URL
 */

'use client';

import { detectPlatformFromUrl, getPlatformIcon, normalizePlatformId, type PlatformId } from './client';

interface PlatformIconProps {
  /** Platform id ('kalshi', 'polymarket') or display name ('Kalshi', 'Polymarket') */
  platform?: string;
  /** URL to auto-detect platform from (used when platform prop is not set) */
  url?: string;
  /** Size: sm=3 (12px), md=4 (16px), lg=5 (20px), or custom px number */
  size?: 'sm' | 'md' | 'lg' | number;
  /** Additional CSS classes */
  className?: string;
  /** Alt text (defaults to platform name) */
  alt?: string;
}

const SIZE_MAP = {
  sm: 'w-3 h-3',
  md: 'w-4 h-4',
  lg: 'w-5 h-5',
};

export function PlatformIcon({
  platform,
  url,
  size = 'sm',
  className = '',
  alt,
}: PlatformIconProps) {
  // Resolve platform id
  let platformId: PlatformId | null = null;
  if (platform) {
    // Handle legacy display names: "Kalshi" → "kalshi", "Polymarket" → "polymarket"
    const lower = platform.toLowerCase();
    platformId = normalizePlatformId(lower);
  } else if (url) {
    platformId = detectPlatformFromUrl(url);
  }

  if (!platformId) {
    // Unknown platform — render a small placeholder circle
    return (
      <span
        className={`inline-block rounded-sm bg-gray-400 ${typeof size === 'number' ? '' : SIZE_MAP[size]} ${className}`}
        style={typeof size === 'number' ? { width: size, height: size } : undefined}
        title={alt ?? 'Unknown platform'}
      />
    );
  }

  const iconPath = getPlatformIcon(platformId);
  const sizeClass = typeof size === 'number' ? '' : SIZE_MAP[size];
  const sizeStyle = typeof size === 'number' ? { width: size, height: size } : undefined;
  const altText = alt ?? platformId.charAt(0).toUpperCase() + platformId.slice(1);

  return (
    <img
      src={iconPath}
      alt={altText}
      className={`rounded-sm inline ${sizeClass} ${className}`}
      style={sizeStyle}
    />
  );
}

export default PlatformIcon;