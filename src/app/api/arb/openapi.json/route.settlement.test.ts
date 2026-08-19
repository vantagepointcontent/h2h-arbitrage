import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('arb OpenAPI BotTrader settlement contract', () => {
  it('publishes the authoritative per-leg settlement ledger projection', async () => {
    const response = GET();
    const document = await response.json();
    const [, minor] = String(document.info.version).split('.').map(Number);
    expect(minor).toBeGreaterThanOrEqual(3);
    expect(document.paths['/api/bot-trader/positions'].get.responses['200'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/BotPositionPage' });
    expect(document.components.schemas.BotSettlementLeg.required).toEqual(expect.arrayContaining([
      'venue', 'marketId', 'outcomeId', 'side', 'requestedQuantity', 'filledQuantity',
      'remainingQuantity', 'lifecycleState', 'creditState', 'payoutEntitlementCents',
    ]));
  });
});
