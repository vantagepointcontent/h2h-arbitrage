import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /api/arb/openapi.json Entry Arb Profit contract', () => {
  it('publishes the immutable fixed-point placement snapshot on BotTrader positions', async () => {
    const response = GET();
    const spec = await response.json() as {
      info: { version: string };
      components: { schemas: Record<string, {
        required?: string[];
        properties: Record<string, unknown>;
      }> };
    };
    expect(spec.info.version).toBe('1.4.0');
    expect(spec.components.schemas.BotPositionSettlementProjection.properties.entryArbProfitSnapshot)
      .toEqual({ $ref: '#/components/schemas/EntryArbProfitSnapshot' });
    expect(spec.components.schemas.EntryArbProfitSnapshot).toMatchObject({
      required: ['version', 'status', 'executionMode', 'capturedAt'],
      properties: {
        profitMicrousd: { type: 'integer' },
        matchedQuantityMicrounits: { type: 'integer', minimum: 1 },
        guaranteedPayoutMicrousd: { type: 'integer', minimum: 1 },
        entryRoi: { $ref: '#/components/schemas/EntryArbProfitRoi' },
      },
    });
    expect(spec.components.schemas.BotPositionSettlementProjection.properties).toMatchObject({
      relationshipValidity: { $ref: '#/components/schemas/RelationshipValidity' },
      exposureIdentityStatus: { $ref: '#/components/schemas/ExposureIdentityStatus' },
      legacyExposureVerdict: { $ref: '#/components/schemas/LegacyExposureVerdict' },
      excludedFromVerifiedTotals: { type: 'boolean' },
    });
    expect(spec.components.schemas.LegacyExposureVerdict.required).toEqual(expect.arrayContaining([
      'relationshipValidity', 'exposureIdentity', 'valuationClass', 'evidence', 'revision',
    ]));
  });
});
