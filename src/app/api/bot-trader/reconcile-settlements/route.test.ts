import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBotSettlementReconciler } from '@/lib/bot-settlement-reconciler';
import { POST } from './route';

vi.mock('@/lib/bot-settlement-reconciler', () => ({ runBotSettlementReconciler: vi.fn() }));

describe('POST /api/bot-trader/reconcile-settlements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('H2H_API_TOKEN', 'internal-token');
    vi.mocked(runBotSettlementReconciler).mockResolvedValue({
      scanned: 2, persisted: 2, settled: 1, unresolved: 1, errors: [],
    });
  });

  it('runs the server-side reconciler without exposing it to unauthenticated callers', async () => {
    const unauthorized = await POST(new Request('http://localhost/api/bot-trader/reconcile-settlements', { method: 'POST' }) as never);
    expect(unauthorized.status).toBe(401);
    expect(runBotSettlementReconciler).not.toHaveBeenCalled();

    const response = await POST(new Request('http://localhost/api/bot-trader/reconcile-settlements', {
      method: 'POST', headers: { 'x-h2h-token': 'internal-token' },
    }) as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(runBotSettlementReconciler).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      success: true, scanned: 2, persisted: 2, settled: 1, unresolved: 1, errors: [],
    });
  });
});
