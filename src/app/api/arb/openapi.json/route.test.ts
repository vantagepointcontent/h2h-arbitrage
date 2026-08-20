import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /api/arb/openapi.json Entry Arb Profit contract', () => {
  it('publishes the immutable fixed-point placement snapshot on BotTrader positions', async () => {
    const response = GET();
    const spec = await response.json() as {
      info: { version: string };
      paths: Record<string, { get: { responses: Record<string, { content: Record<string, { schema: unknown }> }> } }>;
      components: { schemas: Record<string, {
        required?: string[];
        properties: Record<string, unknown>;
      }> };
    };
    expect(spec.info.version).toBe('1.5.2');
    expect(spec.paths['/api/executions'].get.responses['200'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/ExecutionListResponse' });
    expect(spec.components.schemas.ExecutionRecord.properties).toMatchObject({
      sourceScanId: { type: ['integer', 'null'], minimum: 1 },
      sourceOpportunityId: { type: ['string', 'null'] },
    });
    expect(spec.components.schemas.HistoricalScanFinancials).toMatchObject({
      required: ['revision', 'scanId', 'envelope', 'fields'],
      properties: {
        revision: { type: 'integer', const: 1 },
        fields: expect.objectContaining({
          required: ['roiPct', 'profitUsd', 'apyPct', 'stakeUsd'],
        }),
      },
    });
    expect(spec.components.schemas.BotScanEvaluation).toMatchObject({
      required: expect.arrayContaining([
        'scanId', 'status', 'botTraderEvaluationCompleted', 'candidateCount', 'evaluatedCount',
        'eligibleCount', 'placementAttemptCount', 'placedCount', 'skippedCount', 'failureCount',
      ]),
      properties: {
        status: { type: 'string', enum: [
          'pending', 'completed', 'partial', 'failed', 'not_run_disabled', 'not_applicable_no_positive_arb',
        ] },
        botTraderEvaluationCompleted: { type: 'boolean' },
        missingCandidateIndexes: { type: 'array', items: { type: 'integer', minimum: 0 } },
        failingCandidateIndexes: { type: 'array', items: { type: 'integer', minimum: 0 } },
      },
    });
    const logsSchema = spec.paths['/api/logs'].get.responses['200'].content['application/json'].schema as {
      properties: { logs: { items: { required: string[]; properties: Record<string, unknown> } } };
    };
    expect(logsSchema.properties.logs.items.required).toEqual(expect.arrayContaining([
      'arb_type', 'arb_valid', 'arb_invalidation_reason', 'positive_arb_count',
      'botTraderEvaluationCompleted', 'botTraderEvaluationStatus', 'botTraderEvaluation',
    ]));
    expect(logsSchema.properties.logs.items.properties).toMatchObject({
      arb_type: { type: ['string', 'null'], enum: ['direct', 'cross', 'internal', null] },
      arb_valid: { type: 'integer', enum: [0, 1] },
      arb_invalidation_reason: { type: ['string', 'null'] },
      positive_arb_count: { type: 'integer', minimum: 0 },
    });
    expect(logsSchema.properties.logs.items.properties.botTraderEvaluation)
      .toEqual({ anyOf: [{ $ref: '#/components/schemas/BotScanEvaluation' }, { type: 'null' }] });
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
