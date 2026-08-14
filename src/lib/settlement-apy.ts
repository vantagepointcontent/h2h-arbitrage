import type { KalshiMarket } from './kalshi';

export type SettlementTimingSource =
  | 'kalshi.market.expected_expiration_time'
  | 'kalshi.market.expiration_time'
  | 'kalshi.market.latest_expiration_time'
  | 'polymarket.market.endDate'
  | 'polymarket.event.endDate';

export interface SettlementTiming {
  expectedAt: string | null;
  contractualAt: string | null;
  expectedSource: SettlementTimingSource | null;
  contractualSource: SettlementTimingSource | null;
  earlyDetermination: {
    eligible: boolean | null;
    condition: string | null;
    source: 'kalshi.market.early_close_condition' | null;
  };
}

export type SettlementApyUnavailableReason =
  | 'invalid_roi'
  | 'invalid_observed_at'
  | 'missing_settlement_date'
  | 'invalid_expected_settlement'
  | 'invalid_contractual_settlement'
  | 'conflicting_settlement_dates'
  | 'unaligned_resolution_rules';

export interface SettlementApyScenario {
  label: 'scenario_a' | 'scenario_b';
  winner: 'kalshi' | 'polymarket';
  roiPct: number;
  apyPct: number | null;
  settlementAt: string | null;
  daysToSettlement: number | null;
  timingSource: SettlementTimingSource | null;
  unavailableReason: SettlementApyUnavailableReason | null;
}

export interface OutcomeContingentApy {
  observedAt: string;
  apyPct: number | null;
  unavailableReason: SettlementApyUnavailableReason | 'outcome_contingent' | null;
  scenarioA: SettlementApyScenario;
  scenarioB: SettlementApyScenario;
  kalshi: SettlementTiming | null;
  polymarket: SettlementTiming | null;
}

const MS_PER_DAY = 86_400_000;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isoWhenValid(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : raw;
}

export function kalshiSettlementTiming(market: Pick<KalshiMarket,
  'expected_expiration_time' | 'expiration_time' | 'latest_expiration_time' |
  'can_close_early' | 'early_close_condition'>): SettlementTiming {
  const contractual = market.expiration_time ?? market.latest_expiration_time;
  const contractualSource = text(market.expiration_time)
    ? 'kalshi.market.expiration_time' as const
    : text(market.latest_expiration_time) ? 'kalshi.market.latest_expiration_time' as const : null;
  return {
    expectedAt: isoWhenValid(market.expected_expiration_time),
    contractualAt: isoWhenValid(contractual),
    expectedSource: text(market.expected_expiration_time) ? 'kalshi.market.expected_expiration_time' : null,
    contractualSource,
    earlyDetermination: {
      eligible: typeof market.can_close_early === 'boolean' ? market.can_close_early : null,
      condition: text(market.early_close_condition),
      source: text(market.early_close_condition) ? 'kalshi.market.early_close_condition' : null,
    },
  };
}

/** Polymarket exposes an expected event end and may separately expose a market-level contractual end. */
export function polymarketSettlementTiming(
  expectedEventEnd: unknown,
  contractualMarketEnd?: unknown,
): SettlementTiming {
  return {
    expectedAt: isoWhenValid(expectedEventEnd),
    contractualAt: isoWhenValid(contractualMarketEnd),
    expectedSource: text(expectedEventEnd) ? 'polymarket.event.endDate' : null,
    contractualSource: text(contractualMarketEnd) ? 'polymarket.market.endDate' : null,
    earlyDetermination: { eligible: null, condition: null, source: null },
  };
}

function scenario(
  label: SettlementApyScenario['label'],
  winner: SettlementApyScenario['winner'],
  roiPct: number,
  observedAt: string,
  timing: SettlementTiming | null,
  rulesAligned: boolean,
): SettlementApyScenario {
  const unavailable = (reason: SettlementApyUnavailableReason): SettlementApyScenario => ({
    label, winner, roiPct, apyPct: null, settlementAt: null, daysToSettlement: null,
    timingSource: null, unavailableReason: reason,
  });
  if (!Number.isFinite(roiPct)) return unavailable('invalid_roi');
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return unavailable('invalid_observed_at');
  if (!rulesAligned) return unavailable('unaligned_resolution_rules');
  if (!timing || (!timing.expectedAt && !timing.contractualAt)) return unavailable('missing_settlement_date');

  const expectedMs = timing.expectedAt ? Date.parse(timing.expectedAt) : null;
  if (timing.expectedAt && !Number.isFinite(expectedMs)) return unavailable('invalid_expected_settlement');
  const contractualMs = timing.contractualAt ? Date.parse(timing.contractualAt) : null;
  if (timing.contractualAt && !Number.isFinite(contractualMs)) return unavailable('invalid_contractual_settlement');
  if (expectedMs != null && contractualMs != null && expectedMs > contractualMs) {
    return unavailable('conflicting_settlement_dates');
  }
  if (expectedMs != null && contractualMs != null && expectedMs < contractualMs && timing.earlyDetermination.eligible === false) {
    return unavailable('conflicting_settlement_dates');
  }

  const settlementMs = expectedMs ?? contractualMs;
  const settlementAt = settlementMs == null ? null : new Date(settlementMs).toISOString();
  const timingSource = expectedMs != null ? timing.expectedSource : timing.contractualSource;
  if (settlementMs == null || !settlementAt || !timingSource) return unavailable('missing_settlement_date');
  const daysToSettlement = (settlementMs - observedMs) / MS_PER_DAY;
  if (!(daysToSettlement > 0)) return unavailable('conflicting_settlement_dates');

  return {
    label,
    winner,
    roiPct,
    apyPct: roiPct <= 0 ? 0 : roiPct * (365 / daysToSettlement),
    settlementAt,
    daysToSettlement,
    timingSource,
    unavailableReason: null,
  };
}

export function calculateOutcomeContingentApy(input: {
  roiPct: number;
  observedAt: string;
  arbType: 'cross' | 'direct' | 'internal' | null;
  strategy: string;
  kalshi: SettlementTiming | null;
  polymarket: SettlementTiming | null;
  rulesAligned?: boolean;
}): OutcomeContingentApy {
  const internalWinner = input.arbType === 'internal'
    ? input.strategy.includes('Polymarket') ? 'polymarket' as const : 'kalshi' as const
    : null;
  const winnerA = internalWinner ?? 'kalshi';
  const winnerB = internalWinner ?? 'polymarket';
  const rulesAligned = input.rulesAligned === true;
  const timing = (winner: 'kalshi' | 'polymarket') => winner === 'kalshi' ? input.kalshi : input.polymarket;
  const scenarioA = scenario('scenario_a', winnerA, input.roiPct, input.observedAt, timing(winnerA), rulesAligned);
  const scenarioB = scenario('scenario_b', winnerB, input.roiPct, input.observedAt, timing(winnerB), rulesAligned);

  const bothAvailable = scenarioA.apyPct != null && scenarioB.apyPct != null;
  const sameAnnualization = bothAvailable
    && scenarioA.settlementAt != null
    && scenarioA.settlementAt === scenarioB.settlementAt;
  const unavailableReason = sameAnnualization
    ? null
    : scenarioA.unavailableReason ?? scenarioB.unavailableReason ?? 'outcome_contingent';
  return {
    observedAt: input.observedAt,
    apyPct: sameAnnualization ? scenarioA.apyPct : null,
    unavailableReason,
    scenarioA,
    scenarioB,
    kalshi: input.kalshi,
    polymarket: input.polymarket,
  };
}
