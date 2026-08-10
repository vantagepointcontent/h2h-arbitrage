import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getUncoupledEvents } = vi.hoisted(() => ({ getUncoupledEvents: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ getUncoupledEvents }));

import { GET } from './route';

function request(query = '') {
  return new NextRequest(`http://localhost/api/uncoupled-markets${query}`);
}

describe('GET /api/uncoupled-markets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUncoupledEvents.mockResolvedValue({ events: [], total: 0 });
  });

  it('uses safe defaults', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(getUncoupledEvents).toHaveBeenCalledWith({
      search: undefined,
      sortBy: 'title',
      platform: 'both',
      minConfidence: undefined,
    });
  });

  it('normalizes and forwards valid filters', async () => {
    const response = await GET(request('?search=%20Election%20&sortBy=confidence&platform=kalshi&minConfidence=0.75'));
    expect(response.status).toBe(200);
    expect(getUncoupledEvents).toHaveBeenCalledWith({
      search: 'Election',
      sortBy: 'confidence',
      platform: 'kalshi',
      minConfidence: 0.75,
    });
  });

  it.each([
    ['sortBy', 'newest'],
    ['platform', 'manifold'],
    ['minConfidence', ''],
    ['minConfidence', 'NaN'],
    ['minConfidence', 'Infinity'],
    ['minConfidence', '-0.1'],
    ['minConfidence', '1.1'],
  ])('rejects invalid %s=%s', async (name, value) => {
    const response = await GET(request(`?${name}=${encodeURIComponent(value)}`));
    expect(response.status).toBe(400);
    expect(getUncoupledEvents).not.toHaveBeenCalled();
  });

  it('rejects search text above 200 characters', async () => {
    const response = await GET(request(`?search=${'x'.repeat(201)}`));
    expect(response.status).toBe(400);
    expect(getUncoupledEvents).not.toHaveBeenCalled();
  });
});
