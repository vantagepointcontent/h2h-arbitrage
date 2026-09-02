import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ queryExecutions: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ queryExecutions: mocks.queryExecutions }));

import { GET } from './route';

describe('GET /api/executions canonical source filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryExecutions.mockResolvedValue({
      executions: [{ id: 7, source: 'manual' }],
      total: 12,
      sourceCounts: { all: 30, manual: 12, bot: 17, unknown: 1 },
      summary: { realCount: 4, pendingCount: 2, totalNetPnlMicros: 1250000, unhedgedCount: 1, unhedgedExposure: 7.5 },
      nextOffset: 10,
    });
  });

  it('filters the complete result set by canonical source before pagination', async () => {
    const response = await GET(new NextRequest(
      'http://localhost/api/executions?source=manual&view=pending&limit=10&offset=0&method=roi&sortMethod=asc',
    ));

    expect(mocks.queryExecutions).toHaveBeenCalledWith({
      source: 'manual', view: 'pending', limit: 10, offset: 0, selectionMethod: 'roi', sortMethod: 'asc',
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      count: 1,
      total: 12,
      sourceCounts: { all: 30, manual: 12, bot: 17, unknown: 1 },
      summary: { realCount: 4, pendingCount: 2, totalNetPnlMicros: 1250000, unhedgedCount: 1, unhedgedExposure: 7.5 },
      nextOffset: 10,
      executions: [{ id: 7, source: 'manual' }],
    });
  });

  it.each(['external', '', 'BOT'])('rejects non-canonical source %j', async (source) => {
    const response = await GET(new NextRequest(`http://localhost/api/executions?source=${source}`));
    expect(response.status).toBe(400);
    expect(mocks.queryExecutions).not.toHaveBeenCalled();
  });

  it('accepts unknown provenance explicitly', async () => {
    await GET(new NextRequest('http://localhost/api/executions?source=unknown'));
    expect(mocks.queryExecutions).toHaveBeenCalledWith(expect.objectContaining({ source: 'unknown' }));
  });

  it.each(['-1', '1.5', 'nope'])('rejects malformed offsets %j', async (offset) => {
    const response = await GET(new NextRequest(`http://localhost/api/executions?offset=${offset}`));
    expect(response.status).toBe(400);
  });

  it.each(['paper', 'filled', 'REAL'])('rejects unsupported trade view %j', async (view) => {
    const response = await GET(new NextRequest(`http://localhost/api/executions?view=${view}`));
    expect(response.status).toBe(400);
    expect(mocks.queryExecutions).not.toHaveBeenCalled();
  });
});
