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

const nullableInteger = { type: ['integer', 'null'] } as const;
const nullableString = { type: ['string', 'null'] } as const;

const calculationEnvelopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'scope', 'status', 'blocker', 'calculatedAt', 'requestedQuantityMicros', 'executableQuantityMicros', 'legs', 'totals', 'rounding'],
  properties: {
    version: { type: 'integer', const: 1 },
    scope: { type: 'string', enum: ['opportunity', 'execution', 'position'] },
    status: { type: 'string', enum: ['executable', 'non_executable', 'unavailable', 'legacy_unverifiable'] },
    blocker: { anyOf: [
      { type: 'null' },
      { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } },
    ] },
    calculatedAt: { type: ['string', 'null'], format: 'date-time' },
    requestedQuantityMicros: nullableInteger,
    executableQuantityMicros: nullableInteger,
    legs: { type: 'array', items: { $ref: '#/components/schemas/CalculationLeg' } },
    totals: { $ref: '#/components/schemas/CalculationTotals' },
    rounding: {
      type: 'object', additionalProperties: false,
      required: ['moneyScale', 'priceScale', 'quantityScale', 'mode'],
      properties: {
        moneyScale: { type: 'integer', const: 1_000_000 },
        priceScale: { type: 'integer', const: 1_000_000 },
        quantityScale: { type: 'integer', const: 1_000_000 },
        mode: { type: 'string', const: 'venue_rules_then_sum' },
      },
    },
  },
} as const;

const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'H2H Arbitrage API',
    version: '1.3.0',
    description: 'Scanner, saved-market, and BotTrader settlement contracts. Canonical APY is a persisted percentage compounded from net ROI and the same event-time expiry/TTE snapshot shown by clients; venue timing APYs remain additional provenance.',
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
    '/api/logs': { get: { summary: 'Read scans with calculation envelopes', responses: { '200': { description: 'Scan log rows' } } } },
    '/api/executions': { get: { summary: 'Read executions with calculation envelopes', responses: { '200': { description: 'Execution records' } } } },
    '/api/positions': { get: { summary: 'Read positions with calculation provenance', responses: { '200': { description: 'Position records' } } } },
    '/api/bot-trader/positions': { get: { summary: 'Read bot positions joined to execution and settlement ledgers', responses: { '200': {
      description: 'Bot position records with authoritative per-leg settlement state',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/BotPositionPage' } } },
    } } } },

  },
  components: {
    schemas: {
      CalculationEnvelope: calculationEnvelopeSchema,
      CalculationTotals: {
        type: 'object', additionalProperties: false,
        required: ['grossCostMicros', 'grossPayoutMicros', 'grossProfitMicros', 'totalFeesMicros', 'netPnlMicros'],
        properties: {
          grossCostMicros: nullableInteger, grossPayoutMicros: nullableInteger,
          grossProfitMicros: nullableInteger, totalFeesMicros: nullableInteger, netPnlMicros: nullableInteger,
        },
      },
      CalculationLeg: {
        type: 'object', additionalProperties: false,
        required: ['venue', 'instrumentId', 'outcomeId', 'side', 'action', 'requestedQuantityMicros', 'executableQuantityMicros', 'bookObservedAt', 'fillLevels', 'vwapPriceMicros', 'fee'],
        properties: {
          venue: { type: 'string' }, instrumentId: { type: 'string' }, outcomeId: { type: 'string' },
          side: { type: 'string', enum: ['yes', 'no'] }, action: { type: 'string', enum: ['buy', 'sell'] },
          requestedQuantityMicros: nullableInteger, executableQuantityMicros: nullableInteger,
          bookObservedAt: { type: ['string', 'null'], format: 'date-time' },
          fillLevels: { type: 'array', items: { type: 'object', required: ['priceMicros', 'quantityMicros'], properties: { priceMicros: { type: 'integer' }, quantityMicros: { type: 'integer' } } } },
          vwapPriceMicros: nullableInteger,
          fee: {
            type: 'object', required: ['amountMicros', 'basis', 'schedule'],
            properties: {
              amountMicros: nullableInteger,
              basis: { type: 'string', enum: ['calculated', 'charged', 'unavailable'] },
              schedule: { anyOf: [
                { type: 'null' },
                { type: 'object', required: ['source', 'version', 'observedAt', 'ratePpm'], properties: { source: { type: 'string' }, version: { type: 'string' }, observedAt: { type: 'string', format: 'date-time' }, ratePpm: { type: 'integer', minimum: 0 } } },
              ] },
            },
          },
        },
      },
      CalculationEnvelopeCarrier: { type: 'object', required: ['calculationEnvelope'], properties: { calculationEnvelope: { $ref: '#/components/schemas/CalculationEnvelope' } } },
      LegacyCalculationBlocker: { type: 'object', required: ['code', 'message'], properties: { code: { const: 'legacy_missing_calculation_authority' }, message: nullableString } },
      BotSettlementLeg: {
        type: 'object', additionalProperties: false,
        required: [
          'venue', 'marketId', 'outcomeId', 'side', 'requestedQuantity', 'filledQuantity',
          'remainingQuantity', 'orderId', 'fillIds', 'exposureState', 'mode', 'lifecycleState',
          'resolutionWinningSide', 'resolutionDetectedAt', 'resolutionSource',
          'resolutionSourceVersion', 'payoutEntitlementCents', 'settlementFeeCents',
          'netSettlementProceedsCents', 'creditState', 'cashAvailableAt', 'failureReason', 'reconciledAt',
        ],
        properties: {
          venue: { type: 'string', enum: ['kalshi', 'polymarket'] },
          marketId: nullableString,
          outcomeId: nullableString,
          side: { type: 'string', enum: ['yes', 'no'] },
          requestedQuantity: { type: 'integer', minimum: 0 },
          filledQuantity: nullableInteger,
          remainingQuantity: nullableInteger,
          orderId: nullableString,
          fillIds: { type: 'array', items: { type: 'string' } },
          exposureState: { type: 'string', enum: ['filled', 'partial_fill', 'zero_fill', 'failed', 'rolled_back', 'closed', 'unknown'] },
          mode: { type: 'string', enum: ['paper', 'live'] },
          lifecycleState: { type: 'string', enum: ['open', 'resolution_detected', 'settlement_pending', 'redeemable', 'settled', 'redeemed', 'reconciled', 'failed', 'unresolved'] },
          resolutionWinningSide: { type: ['string', 'null'], enum: ['yes', 'no', null] },
          resolutionDetectedAt: { type: ['string', 'null'], format: 'date-time' },
          resolutionSource: nullableString,
          resolutionSourceVersion: nullableString,
          payoutEntitlementCents: nullableInteger,
          settlementFeeCents: nullableInteger,
          netSettlementProceedsCents: nullableInteger,
          creditState: { type: 'string', enum: ['pending', 'redeemable', 'redeemed', 'credited', 'simulated_credited', 'not_applicable'] },
          cashAvailableAt: { type: ['string', 'null'], format: 'date-time' },
          failureReason: nullableString,
          reconciledAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      BotPositionSettlementProjection: {
        type: 'object', additionalProperties: true,
        properties: {

          settlementState: { type: 'string', enum: ['open', 'partially_settled', 'settlement_pending', 'settlement_unresolved', 'settled'] },
          settlementLegs: { type: 'array', items: { $ref: '#/components/schemas/BotSettlementLeg' } },
          settlementGrossProceedsCents: nullableInteger,
          settlementNetProceedsCents: nullableInteger,
          settlementFailureReason: nullableString,
          settlementCashAvailableAt: { type: ['string', 'null'], format: 'date-time' },
          settlementReconciledAt: { type: ['string', 'null'], format: 'date-time' },
          realizedPnlCents: nullableInteger,
          realizedRoiBps: nullableInteger,
        },
      },

      BotPositionPage: {
        type: 'object', additionalProperties: true,
        required: ['success', 'count', 'marketCount', 'markets', 'nextCursor', 'positions'],
        properties: {
          success: { type: 'boolean', const: true },
          count: { type: 'integer', minimum: 0 },
          marketCount: { type: 'integer', minimum: 0 },
          markets: { type: 'array', items: { type: 'object', additionalProperties: true } },
          nextCursor: nullableString,
          positions: { type: 'array', items: { $ref: '#/components/schemas/BotPositionSettlementProjection' } },
        },
      },

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
            enum: ['invalid_roi', 'invalid_observed_at', 'missing_settlement_date', 'invalid_expected_settlement', 'invalid_contractual_settlement', 'conflicting_settlement_dates', null],
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
            enum: ['invalid_roi', 'invalid_observed_at', 'missing_settlement_date', 'invalid_expected_settlement', 'invalid_contractual_settlement', 'conflicting_settlement_dates', 'outcome_contingent', null],
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
          apyPct: { type: ['number', 'null'], description: 'Canonical APY percentage: ((1 + ROI% / 100)^(365 / daysToExpiry) - 1) × 100.' },
          daysToExpiry: { type: ['number', 'null'], description: 'Persisted event-time fractional TTE used for apyPct.' },
          expiryAt: { type: ['string', 'null'], format: 'date-time', description: 'Canonical persisted expiry used for daysToExpiry and the visible Days to expiry value.' },
          apyUnavailableReason: { type: ['string', 'null'], enum: ['invalid_roi', 'invalid_scan_timestamp', 'missing_expiry', 'invalid_expiry', 'non_positive_tte', null] },
          outcomeApy: { $ref: '#/components/schemas/OutcomeContingentApy' },
          calculationEnvelope: { $ref: '#/components/schemas/CalculationEnvelope' },
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
        properties: {
          canonicalApyPct: { type: ['number', 'null'], description: 'Canonical compact APY percentage from the newest persisted successful full scan.' },
          canonicalApyUnavailableReason: { type: ['string', 'null'] },
          canonicalApyOutcome: { type: ['string', 'null'] },
          canonicalApyObservedAt: { type: ['string', 'null'], format: 'date-time' },
          canonicalApySource: { type: ['string', 'null'], enum: ['full_scan', null] },
          canonicalApyRevision: { type: ['integer', 'null'] },
          lastScanResult: { anyOf: [{ $ref: '#/components/schemas/ScanResult' }, { type: 'null' }] },
          liveResult: { anyOf: [{ $ref: '#/components/schemas/ScanResult' }, { type: 'null' }] },
        },
      },
    },
  },
} as const;

export function GET() {
  return Response.json(openapi, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
