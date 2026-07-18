/**
 * usePlatforms — client-side hook for fetching the platform registry.
 *
 * Used by UI components that need to show platform selectors, icons,
 * or enable/disable toggles. Caches the result so multiple components
 * don't refetch.
 *
 * Usage:
 *   const { platforms, loading, error } = usePlatforms();
 *   const enabled = platforms.filter(p => p.enabled);
 */

'use client';

import { useState, useEffect } from 'react';

export interface ApiPlatformConfig {
  id: string;
  name: string;
  shortName: string;
  iconPath: string;
  color: string;
  enabled: boolean;
  adapterReady: boolean;
  dataFormat: string;
  feeModel: string;
  supportsWebSocket: boolean;
  sortOrder: number;
}

let _cache: ApiPlatformConfig[] | null = null;
let _promise: Promise<ApiPlatformConfig[]> | null = null;

async function fetchPlatforms(): Promise<ApiPlatformConfig[]> {
  if (_cache) return _cache;
  if (_promise) return _promise;

  _promise = fetch('/api/platforms', { cache: 'no-store' })
    .then(r => r.json())
    .then((data): ApiPlatformConfig[] => {
      const platforms = data.platforms ?? [];
      _cache = platforms;
      return platforms;
    })
    .catch((): ApiPlatformConfig[] => {
      _cache = [];
      return [];
    });

  return _promise;
}

export function usePlatforms() {
  const [platforms, setPlatforms] = useState<ApiPlatformConfig[]>(_cache ?? []);
  const [loading, setLoading] = useState(!_cache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (_cache) {
      setPlatforms(_cache);
      setLoading(false);
      return;
    }

    let mounted = true;
    fetchPlatforms()
      .then(p => {
        if (mounted) {
          setPlatforms(p);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mounted) {
          setError('Failed to load platforms');
          setLoading(false);
        }
      });

    return () => { mounted = false; };
  }, []);

  return { platforms, loading, error };
}

export default usePlatforms;