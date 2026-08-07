const ACTIONS = ['run', 'refresh_catalog'] as const;
type Action = typeof ACTIONS[number];

export function parseMarketCatalogAction(body: Record<string, unknown>): { action: Action } | { error: string } {
  if (typeof body.action !== 'string' || !ACTIONS.includes(body.action as Action)) {
    return { error: 'Invalid action. Use "run" or "refresh_catalog".' };
  }
  return { action: body.action as Action };
}

export function parseMarketCatalogQuery(params: URLSearchParams): {
  platform?: 'kalshi' | 'polymarket';
  limit: number;
  cursor: number;
  sortBy?: 'fetched_at' | 'expiry_date' | 'title';
  sortDir?: 'asc' | 'desc';
  includeStale: boolean;
} {
  const platform = params.get('platform') as 'kalshi' | 'polymarket' | null;
  const limit = parseInt(params.get('limit') || '100', 10);
  const cursor = parseInt(params.get('cursor') || '0', 10);
  const sortBy = params.get('sortBy') as 'fetched_at' | 'expiry_date' | 'title' | null;
  const sortDir = params.get('sortDir') as 'asc' | 'desc' | null;
  const includeStale = params.get('includeStale') === '1';

  return {
    platform: platform === 'kalshi' || platform === 'polymarket' ? platform : undefined,
    limit,
    cursor,
    sortBy: sortBy ?? undefined,
    sortDir: sortDir ?? undefined,
    includeStale,
  };
}
