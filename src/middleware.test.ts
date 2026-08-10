import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

function request(method: string, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/settings', { method, headers });
}

describe('API mutation middleware', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('does not trust a client-controlled localhost Host header', async () => {
    vi.stubEnv('H2H_API_TOKEN', 'test-secret');

    const response = middleware(request('POST', { host: 'localhost:3000' }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('allows a mutating API request with the configured token', () => {
    vi.stubEnv('H2H_API_TOKEN', 'test-secret');

    const response = middleware(request('POST', {
      host: 'attacker.example',
      'x-h2h-token': 'test-secret',
    }));

    expect(response.status).toBe(200);
  });

  it('does not require the mutation token for GET requests', () => {
    vi.stubEnv('H2H_API_TOKEN', 'test-secret');

    expect(middleware(request('GET')).status).toBe(200);
  });
});
