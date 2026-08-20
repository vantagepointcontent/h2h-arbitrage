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
    version: '1.5.1',
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
    '/api/logs': { get: { summary: 'Read immutable scan economics with field-level provenance', responses: { '200': {
      description: 'Scan log rows. Historical economics are scan-time evidence; Current ROI is fetched separately from persisted completed scans only.',
      content: { 'application/json': { schema: { type: 'object', required: ['logs', 'count', 'total'], properties: {
        logs: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['historical_financials'], properties: {
          historical_financials: { $ref: '#/components/schemas/HistoricalScanFinancials' },
        } } },
        count: { type: 'integer' }, total: { type: 'integer' },
      } } } },
    } } } },
    '/api/executions': { get: { summary: 'Read executions with calculation envelopes and canonical Logs lineage', responses: { '200': {
      description: 'Execution records',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ExecutionListResponse' } } },
    } } } },
    '/api/positions': { get: { summary: 'Read positions with calculation provenance', responses: { '200': { description: 'Position records' } } } },
    '/api/bot-trader/positions': { get: { summary: 'Read bot positions joined to execution and settlement ledgers', responses: { '200': {
      description: 'Bot position records with authoritative per-leg settlement state',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/BotPositionPage' } } },
    } } } },
    '/api/bot-trader/analytics': { get: { summary: 'Read bounded BotTrader analytics with immutable entry economics', responses: { '200': {
      description: 'BotTrader analytics and positions; reads persisted data only',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/BotAnalyticsResponse' } } },
    } } } },
  },
  components: {
    schemas: {
      CalculationEnvelope: calculationEnvelopeSchema,
      ExecutionRecord: {
        type: 'object', additionalProperties: true,
        properties: {
          id: { type: 'integer', minimum: 1 },
          source: { type: 'string', enum: ['manual', 'bot'] },
          sourceScanId: { type: ['integer', 'null'], minimum: 1 },
          sourceOpportunityId: { type: ['string', 'null'] },
          calculationEnvelope: { $ref: '#/components/schemas/CalculationEnvelope' },
        },
      },
      ExecutionListResponse: {
        type: 'object', additionalProperties: false,
        required: ['success', 'count', 'executions'],
        properties: {
          success: { type: 'boolean' },
          count: { type: 'integer', minimum: 0 },
          executions: { type: 'array', items: { $ref: '#/components/schemas/ExecutionRecord' } },
        },
      },
      HistoricalFinancialField: {
        type: 'object', additionalProperties: false,
        required: ['status', 'value', 'source', 'sourceRevision'],
        properties: {
          status: { type: 'string', enum: ['available', 'unavailable'] },
          value: { type: ['number', 'null'] },
          source: { type: 'string', enum: ['scan_result_scalar', 'raw_result_snapshot', 'unavailable'] },
          sourceRevision: { type: 'string' },
          reasonCode: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      HistoricalScanFinancials: {
        type: 'object', additionalProperties: false,
        required: ['revision', 'scanId', 'envelope', 'fields'],
        properties: {
          revision: { type: 'integer', const: 1 },
          scanId: nullableInteger,
          envelope: { $ref: '#/components/schemas/CalculationEnvelope' },
          fields: { type: 'object', additionalProperties: false,
            required: ['roiPct', 'profitUsd', 'apyPct', 'stakeUsd'],
            properties: {
              roiPct: { $ref: '#/components/schemas/HistoricalFinancialField' },
              profitUsd: { $ref: '#/components/schemas/HistoricalFinancialField' },
              apyPct: { $ref: '#/components/schemas/HistoricalFinancialField' },
              stakeUsd: { $ref: '#/components/schemas/HistoricalFinancialField' },
            },
          },
        },
      },
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
          entryArbProfitSnapshot: { $ref: '#/components/schemas/EntryArbProfitSnapshot' },
          relationshipValidity: { $ref: '#/components/schemas/RelationshipValidity' },
          exposureIdentityStatus: { $ref: '#/components/schemas/ExposureIdentityStatus' },
          exposureValuationLabel: { type: 'string', enum: ['Verified arbitrage', 'Invalid/unverified exposure', 'Unavailable'] },
          excludedFromVerifiedTotals: { type: 'boolean' },
          legacyExposureRevision: { type: ['string', 'null'] },
          legacyExposureVerdict: { $ref: '#/components/schemas/LegacyExposureVerdict' },
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
      RelationshipValidity: {
        type: 'string', enum: ['verified_complementary', 'confirmed_invalid', 'unresolved_relationship', 'non_exhaustive_conflicting'],
      },
      ExposureIdentityStatus: {
        type: 'string', enum: ['exact_held_legs_proven', 'partially_proven', 'no_fill_rolled_back', 'unrecoverable'],
      },
      LegacyExposureVerdict: {
        type: ['object', 'null'], additionalProperties: true,
        required: ['version', 'relationshipValidity', 'exposureIdentity', 'valuationClass', 'executionMode',
          'simulated', 'exactLegs', 'reason', 'evidence', 'excludedFromVerifiedTotals', 'revision'],
        properties: {
          version: { type: 'integer', const: 1 },
          relationshipValidity: { $ref: '#/components/schemas/RelationshipValidity' },
          exposureIdentity: { $ref: '#/components/schemas/ExposureIdentityStatus' },
          valuationClass: { type: 'string', enum: ['verified_arbitrage', 'invalid_unverified_exposure', 'unavailable'] },
          executionMode: { type: 'string', enum: ['paper', 'live'] },
          simulated: { type: 'boolean' },
          exactLegs: { type: 'object', additionalProperties: true },
          reason: { type: 'string' },
          evidence: { type: 'array', items: { type: 'object', additionalProperties: false,
            required: ['source', 'revision', 'capturedAt', 'confidence'], properties: {
              source: { type: 'string' }, revision: { type: 'string' }, capturedAt: { type: 'string', format: 'date-time' },
              confidence: { type: 'string', enum: ['canonical', 'exact_immutable_execution', 'fingerprinted_audit'] },
            } } },
          excludedFromVerifiedTotals: { type: 'boolean' },
          revision: { type: 'string' },
        },
      },
      EntryArbProfitRoi: {
        type: 'object', additionalProperties: false,
        required: ['numeratorMicrousd', 'denominatorMicrousd'],
        properties: {
          numeratorMicrousd: { type: 'integer' },
          denominatorMicrousd: { type: 'integer', minimum: 1 },
        },
      },
      EntryArbProfitSnapshot: {
        type: 'object', additionalProperties: true,
        required: ['version', 'status', 'executionMode', 'capturedAt'],
        properties: {
          version: { type: 'integer', const: 1 },
          status: { type: 'string', enum: ['available', 'unavailable'] },
          profitMicrousd: { type: 'integer' },
          currency: { type: 'string', const: 'USDC' },
          monetaryUnit: { type: 'string', const: 'microusd' },
          matchedQuantityMicrounits: { type: 'integer', minimum: 1 },
          guaranteedPayoutMicrousd: { type: 'integer', minimum: 1 },
          grossFillsMicrocents: { type: 'object', additionalProperties: false, required: ['kalshi', 'polymarket'], properties: {
            kalshi: { type: 'integer', minimum: 0 }, polymarket: { type: 'integer', minimum: 0 },
          } },
          entryFeesMicrousd: { type: 'object', additionalProperties: false, required: ['kalshi', 'polymarket'], properties: {
            kalshi: { type: 'integer', minimum: 0 }, polymarket: { type: 'integer', minimum: 0 },
          } },
          settlementFeeAssumptionMicrousd: { type: 'integer', minimum: 0 },
          formula: { type: 'string' },
          formulaVersion: { type: 'integer', const: 1 },
          executionMode: { type: 'string', enum: ['paper', 'live'] },
          provenance: { type: 'string', enum: ['simulated_placement_fills', 'authoritative_venue_fills', 'placement_snapshot', 'historical_backfill'] },
          relationshipState: { type: 'string', const: 'verified_complementary' },
          entryRoi: { $ref: '#/components/schemas/EntryArbProfitRoi' },
          legs: { type: 'object', additionalProperties: false, required: ['kalshi', 'polymarket'], properties: {
            kalshi: { type: 'object', additionalProperties: false, required: ['marketId', 'tokenId', 'side', 'outcome'], properties: {
              marketId: { type: 'string' }, tokenId: { type: 'null' }, side: { type: 'string', enum: ['yes', 'no'] }, outcome: { type: 'string' },
            } },
            polymarket: { type: 'object', additionalProperties: false, required: ['marketId', 'tokenId', 'side', 'outcome'], properties: {
              marketId: { type: 'string' }, tokenId: { type: 'string' }, side: { type: 'string', enum: ['yes', 'no'] }, outcome: { type: 'string' },
            } },
          } },
          reasonCode: { type: 'string' },
          reason: { type: 'string' },
          capturedAt: { type: 'string', format: 'date-time' },
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
      BotAnalyticsResponse: {
        type: 'object', additionalProperties: true,
        required: ['success', 'analytics'],
        properties: {
          success: { type: 'boolean', const: true },
          analytics: { type: 'object', additionalProperties: true, properties: {
            positions: { type: 'array', maxItems: 1000, items: { $ref: '#/components/schemas/BotPositionSettlementProjection' } },
          } },
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
