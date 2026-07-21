export type CouplingRequest = {
  action: 'accept' | 'reject';
  kalshiTicker: string;
  pmConditionId: string;
  reason?: string;
};

export function parseCouplingRequest(body: Record<string, unknown>): CouplingRequest | { error: string } {
  const { action, kalshiTicker, pmConditionId, reason } = body;
  if (action !== 'accept' && action !== 'reject') return { error: 'Invalid action' };
  if (typeof kalshiTicker !== 'string' || kalshiTicker.trim().length === 0) {
    return { error: 'Missing or invalid kalshiTicker' };
  }
  if (typeof pmConditionId !== 'string' || pmConditionId.trim().length === 0) {
    return { error: 'Missing or invalid pmConditionId' };
  }
  if (reason !== undefined && typeof reason !== 'string') return { error: 'Invalid reason' };

  return {
    action,
    kalshiTicker: kalshiTicker.trim(),
    pmConditionId: pmConditionId.trim(),
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
  };
}
