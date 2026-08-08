import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

function makeRequest(body: unknown, token?: string): NextRequest {
  return new NextRequest('http://localhost/api/bot-trader/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-h2h-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('/api/bot-trader/run token guard', () => {
  beforeEach(() => {
    vi.stubEnv('H2H_API_TOKEN', 'secret-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns 401 when token is configured but missing', async () => {
    const res = await POST(makeRequest({ pairId: 'pair-1' }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toContain('Unauthorized');
  });

  it('returns 401 when token is wrong', async () => {
    const res = await POST(makeRequest({ pairId: 'pair-1' }, 'wrong'));
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing pairId without side effects when token is valid', async () => {
    const res = await POST(makeRequest({}, 'secret-token'));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('pairId');
  });
});
