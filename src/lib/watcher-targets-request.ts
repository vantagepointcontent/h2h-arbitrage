export type WatcherTargetsRequest =
  | { action: 'refresh' }
  | { action: 'promote'; pairId: string };

export function parseWatcherTargetsRequest(body: Record<string, unknown>): WatcherTargetsRequest | { error: string } {
  if (body.action === 'refresh') return { action: 'refresh' };
  if (body.action === 'promote') {
    if (typeof body.pairId !== 'string' || body.pairId.trim().length === 0 || body.pairId.length > 128) {
      return { error: 'Missing or invalid pairId' };
    }
    return { action: 'promote', pairId: body.pairId.trim() };
  }
  return { error: 'Unknown action' };
}
