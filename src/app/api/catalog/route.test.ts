import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { queryMarketCatalog } = vi.hoisted(() => ({ queryMarketCatalog: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ queryMarketCatalog }));

import { GET } from './route';

function request(query = '') {
  return new NextRequest(`http://localhost/api/catalog${query}`);
}

describe('GET /api/catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMarketCatalog.mockResolvedValue({ markets: [], nextCursor: null });
  });

  it('uses bounded defaults', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(queryMarketCatalog).toHaveBeenCalledWith({
      platform: undefined,
      includeStale: false,
      limit: 100,
      cursor: 0,
      sortBy: 'fetched_at',
      sortDir: 'desc',
    });
  });

  it.each([
    ['limit', '0', 1],
    ['limit', '-1', 100],
    ['limit', '1.5', 100],
    ['limit', '1001', 1000],
    ['cursor', '-1', 0],
    ['cursor', '1.5', 0],
    ['cursor', '1000001', 1_000_000],
  ])('bounds %s=%s before querying persistence', async (name, value, expected) => {
    const response = await GET(request(`?${name}=${value}`));

    expect(response.status).toBe(200);
    expect(queryMarketCatalog).toHaveBeenCalledWith(expect.objectContaining({
      [name]: expected,
    }));
  });

  it.each([
    ['platform', 'manifold'],
    ['includeStale', 'yes'],
    ['sortBy', 'drop_table'],
    ['sortDir', 'sideways'],
  ])('rejects invalid %s values', async (name, value) => {
    const response = await GET(request(`?${name}=${value}`));

    expect(response.status).toBe(400);
    expect(queryMarketCatalog).not.toHaveBeenCalled();
  });

  it('passes validated query values through', async () => {
    const response = await GET(request('?platform=kalshi&includeStale=true&limit=25&cursor=50&sortBy=title&sortDir=asc'));

    expect(response.status).toBe(200);
    expect(queryMarketCatalog).toHaveBeenCalledWith({
      platform: 'kalshi',
      includeStale: true,
      limit: 25,
      cursor: 50,
      sortBy: 'title',
      sortDir: 'asc',
    });
  });
});
