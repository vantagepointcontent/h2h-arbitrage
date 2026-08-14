import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('arb OpenAPI contract', () => {
  it('publishes outcome-contingent APY and per-leg settlement provenance', async () => {
    const response = GET();
    const document = await response.json();
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/api/scan']).toBeTruthy();
    expect(document.paths['/api/saved-markets']).toBeTruthy();
    expect(document.components.schemas.OutcomeContingentApy.required).toEqual(expect.arrayContaining([
      'scenarioA', 'scenarioB', 'kalshi', 'polymarket',
    ]));
    expect(document.components.schemas.SettlementTimingSource.enum).toContain('kalshi.market.expected_expiration_time');
    expect(document.components.schemas.SettlementTimingSource.enum).toContain('polymarket.event.endDate');
  });
});
