'use server';

export interface SavedMarketPriceRefreshInput {
  marketId: string;
  capital: number;
}

export interface SavedMarketPriceRefreshResponse {
  ok: boolean;
  status: number;
  body: unknown;
  retryAfter: string | null;
  correlationId: string | null;
  deduplicated: boolean;
}

function internalAppUrl(): string {
  const configuredPort = Number(process.env.PORT);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
    ? configuredPort
    : 3000;
  return `http://127.0.0.1:${port}`;
}

/**
 * Same-origin browser bridge for the protected mutation route. The shared API
 * token remains server-only; the browser receives only the route's safe result.
 */
export async function refreshSavedMarketPrices(
  input: SavedMarketPriceRefreshInput,
): Promise<SavedMarketPriceRefreshResponse> {
  const token = process.env.H2H_API_TOKEN;
  const response = await fetch(`${internalAppUrl()}/api/quick-prices`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-h2h-token': token } : {}),
    },
    body: JSON.stringify({ marketId: input.marketId, capital: input.capital }),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  const body: unknown = await response.json();
  return {
    ok: response.ok,
    status: response.status,
    body,
    retryAfter: response.headers.get('retry-after'),
    correlationId: response.headers.get('x-correlation-id'),
    deduplicated: response.headers.get('x-quick-prices-deduplicated') === 'true',
  };
}
