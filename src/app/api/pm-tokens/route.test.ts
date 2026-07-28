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

  it('rejects a CLOB token payload with non-string token IDs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tokens: [
          { outcome: 'Yes', token_id: 123 },
          { outcome: 'No', token_id: 'no-token' },
        ],
      }),
    }));

    const response = await GET(new Request(`http://localhost/api/pm-tokens?conditionId=${conditionId}`) as never);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Could not resolve Yes/No tokens',
    });
  });

  it('normalizes valid token IDs before returning them to execution consumers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tokens: [
          { outcome: 'Yes', token_id: '  yes-token  ' },
          { outcome: 'No', token_id: '\tno-token\n' },
        ],
      }),
    }));

    const response = await GET(new Request(`http://localhost/api/pm-tokens?conditionId=${conditionId}`) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      yesTokenId: 'yes-token',
      noTokenId: 'no-token',
    });
  });

  it('rejects a malformed payload that assigns the same token to Yes and No', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tokens: [
          { outcome: 'Yes', token_id: 'shared-token' },
          { outcome: 'No', token_id: 'shared-token' },
        ],
      }),
    }));

    const response = await GET(new Request(`http://localhost/api/pm-tokens?conditionId=${conditionId}`) as never);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Invalid CLOB token response',
    });
  });
});
