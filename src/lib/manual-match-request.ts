export interface ManualMatchInput {
  kalshiTicker: string;
  pmConditionId: string;
  kalshiTitle: string;
  pmTitle: string;
  kalshiUrl?: string;
  polymarketUrl?: string;
  marketId?: string;
  orientation: 'same' | 'inverted';
}

function requiredString(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value.trim();
}

export function parseManualMatchInput(body: Record<string, unknown>): ManualMatchInput | { error: string } {
  const kalshiTicker = requiredString(body.kalshiTicker);
  const pmConditionId = requiredString(body.pmConditionId);
  if (!kalshiTicker || !pmConditionId) return { error: 'kalshiTicker and pmConditionId must be non-empty strings' };
  if (body.orientation !== undefined && body.orientation !== 'same' && body.orientation !== 'inverted') {
    return { error: 'orientation must be same or inverted' };
  }
  try {
    return {
      kalshiTicker,
      pmConditionId,
      kalshiTitle: typeof body.kalshiTitle === 'string' ? body.kalshiTitle.trim() : '',
      pmTitle: typeof body.pmTitle === 'string' ? body.pmTitle.trim() : '',
      orientation: body.orientation === 'inverted' ? 'inverted' : 'same',
      kalshiUrl: optionalString(body.kalshiUrl, 'kalshiUrl'),
      polymarketUrl: optionalString(body.polymarketUrl, 'polymarketUrl'),
      marketId: optionalString(body.marketId, 'marketId'),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid manual match input' };
  }
}
