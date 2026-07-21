export function parseTelegramAlertsRequest(body: Record<string, unknown>): { action: 'test' } | { error: string } {
  if (body.action === 'test') return { action: 'test' };
  return { error: 'Unknown action. Use "test".' };
}
