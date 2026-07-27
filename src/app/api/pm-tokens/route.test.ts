import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const conditionId = `0x${'a'.repeat(64)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/pm-tokens', () => {
  it('returns a safe upstream error when CLOB returns a non-array token payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tokens: {} }),
    }));

    const response = await GET(new Request(`http://localhost/api/pm-tokens?conditionId=${conditionId}`) as never);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Invalid CLOB token response',
    });
  });
});
