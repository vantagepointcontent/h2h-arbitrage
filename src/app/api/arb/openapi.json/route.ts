export const dynamic = 'force-static';

const timingSource = {
  type: 'string',
  enum: [
    'kalshi.market.expected_expiration_time',
    'kalshi.market.expiration_time',
    'kalshi.market.latest_expiration_time',
    'polymarket.market.endDate',
    'polymarket.event.endDate',
  ],
} as const;

const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'H2H Arbitrage API',
    version: '1.1.0',
    description: 'Scanner and saved-market contracts. Prices and stakes are represented in their existing endpoint units; settlement APY is outcome-contingent.',
  },
  paths: {
    '/api/scan': {
      post: {
        operationId: 'scanMarket',
        responses: {
          '200': {
            description: 'Live scan result',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ScanResult' } } },
          },
        },
      },
    },
    '/api/saved-markets': {
      get: {
        operationId: 'listSavedMarkets',
        responses: {
          '200': {
            description: 'Saved markets read from persistence',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/SavedMarket' } } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      SettlementTimingSource: timingSource,
      EarlyDetermination: {
        type: 'object', required: ['eligible', 'condition', 'source'], additionalProperties: false,
        properties: {
          eligible: { type: ['boolean', 'null'] },
          condition: { type: ['string', 'null'] },
          source: { anyOf: [{ const: 'kalshi.market.early_close_condition' }, { type: 'null' }] },
        },
      },
      SettlementTiming: {
        type: 'object', required: ['expectedAt', 'contractualAt', 'expectedSource', 'contractualSource', 'earlyDetermination'], additionalProperties: false,
        properties: {
          expectedAt: { type: ['string', 'null'], description: 'Venue value; malformed values are retained so APY can fail closed with provenance.' },
          contractualAt: { type: ['string', 'null'], description: 'Venue value; malformed values are retained so APY can fail closed with provenance.' },
          expectedSource: { anyOf: [{ $ref: '#/components/schemas/SettlementTimingSource' }, { type: 'null' }] },
          contractualSource: { anyOf: [{ $ref: '#/components/schemas/SettlementTimingSource' }, { type: 'null' }] },
          earlyDetermination: { $ref: '#/components/schemas/EarlyDetermination' },
        },
      },
      SettlementApyScenario: {
        type: 'object',
        required: ['label', 'winner', 'roiPct', 'apyPct', 'settlementAt', 'daysToSettlement', 'timingSource', 'unavailableReason'],
        additionalProperties: false,
        properties: {
          label: { type: 'string', enum: ['scenario_a', 'scenario_b'] },
          winner: { type: 'string', enum: ['kalshi', 'polymarket'] },
          roiPct: { type: 'number' },
          apyPct: { type: ['number', 'null'] },
          settlementAt: { type: ['string', 'null'], format: 'date-time' },
          daysToSettlement: { type: ['number', 'null'] },
          timingSource: { anyOf: [{ $ref: '#/components/schemas/SettlementTimingSource' }, { type: 'null' }] },
          unavailableReason: {
            type: ['string', 'null'],
            enum: ['invalid_roi', 'invalid_observed_at', 'missing_settlement_date', 'invalid_expected_settlement', 'invalid_contractual_settlement', 'conflicting_settlement_dates', 'unaligned_resolution_rules', null],
          },
        },
      },
      OutcomeContingentApy: {
        type: 'object', required: ['observedAt', 'apyPct', 'unavailableReason', 'scenarioA', 'scenarioB', 'kalshi', 'polymarket'], additionalProperties: false,
        properties: {
          observedAt: { type: 'string', format: 'date-time' },
          apyPct: { type: ['number', 'null'], description: 'Populated only when both scenarios have the same APY.' },
          unavailableReason: {
            type: ['string', 'null'],
            enum: ['invalid_roi', 'invalid_observed_at', 'missing_settlement_date', 'invalid_expected_settlement', 'invalid_contractual_settlement', 'conflicting_settlement_dates', 'unaligned_resolution_rules', 'outcome_contingent', null],
          },
          scenarioA: { $ref: '#/components/schemas/SettlementApyScenario' },
          scenarioB: { $ref: '#/components/schemas/SettlementApyScenario' },
          kalshi: { anyOf: [{ $ref: '#/components/schemas/SettlementTiming' }, { type: 'null' }] },
          polymarket: { anyOf: [{ $ref: '#/components/schemas/SettlementTiming' }, { type: 'null' }] },
        },
      },
      Arbitrage: {
        type: 'object', additionalProperties: true,
        properties: {
          roiPct: { type: 'number' },
          apyPct: { type: ['number', 'null'] },
          outcomeApy: { $ref: '#/components/schemas/OutcomeContingentApy' },
        },
      },
      Outcome: {
        type: 'object', additionalProperties: true,
        properties: { arbitrage: { $ref: '#/components/schemas/Arbitrage' } },
      },
      ScanResult: {
        type: 'object', additionalProperties: true,
        properties: {
          scannedAt: { type: 'string', format: 'date-time' },
          outcomes: { type: 'array', items: { $ref: '#/components/schemas/Outcome' } },
          allArbs: { type: 'array', items: { $ref: '#/components/schemas/Arbitrage' } },
        },
      },
      SavedMarket: {
        type: 'object', additionalProperties: true,
        properties: { lastScanResult: { anyOf: [{ $ref: '#/components/schemas/ScanResult' }, { type: 'null' }] } },
      },
    },
  },
} as const;

export function GET() {
  return Response.json(openapi, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
