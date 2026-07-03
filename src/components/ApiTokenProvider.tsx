// ApiTokenProvider.tsx — SEC-001
// Attaches the shared API token (x-h2h-token) to all same-origin mutating
// fetch() calls from the browser UI. The middleware requires this header on
// non-GET /api/* requests from non-localhost hosts when H2H_API_TOKEN is set.
//
// Note: this is a shared-secret gate for a single-user internal tool, not a
// full auth system. Anyone who can load the page gets the token; the goal is
// to stop blind/scripted LAN clients and CSRF-style requests, not a
// determined attacker with page access.
'use client';

import { useEffect } from 'react';

const TOKEN = process.env.NEXT_PUBLIC_H2H_API_TOKEN;

export function ApiTokenProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!TOKEN || (window as any).__h2hFetchPatched) return;
    (window as any).__h2hFetchPatched = true;

    const origFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const isApi = url.startsWith('/api/') || url.includes(`${window.location.host}/api/`);
      const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      if (isApi && isMutating) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set('x-h2h-token', TOKEN);
        return origFetch(input, { ...init, headers });
      }
      return origFetch(input, init);
    };
  }, []);

  return <>{children}</>;
}
