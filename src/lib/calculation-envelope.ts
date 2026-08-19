export const CALCULATION_ENVELOPE_VERSION = 1 as const;
export const MONEY_SCALE = 1_000_000 as const;
export const PRICE_SCALE = 1_000_000 as const;
export const QUANTITY_SCALE = 1_000_000 as const;

export type CalculationStatus = 'executable' | 'non_executable' | 'unavailable' | 'legacy_unverifiable';
export type CalculationScope = 'opportunity' | 'execution' | 'position';
export type FeeBasis = 'calculated' | 'charged' | 'unavailable';

export interface CalculationBlocker {
  code: string;
  message: string;
}

export interface FeeScheduleAuthority {
  source: string;
  version: string;
  observedAt: string;
  /** Economic fee coefficient in parts per million. Zero is an explicit fee-free schedule. */
  ratePpm: number;
}

export interface CalculationFee {
  basis: FeeBasis;
  amountMicros: number | null;
  schedule: FeeScheduleAuthority | null;
}

export interface CalculationFillLevel {
  priceMicros: number;
  quantityMicros: number;
}

export interface CalculationLeg {
  venue: string;
  instrumentId: string;
  outcomeId: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  requestedQuantityMicros: number;
  executableQuantityMicros: number | null;
  bookObservedAt: string | null;
  fillLevels: CalculationFillLevel[];
  vwapPriceMicros: number | null;
  fee: CalculationFee;
}

export interface CalculationTotals {
  grossCostMicros: number | null;
  grossPayoutMicros: number | null;
  grossProfitMicros: number | null;
  totalFeesMicros: number | null;
  netPnlMicros: number | null;
}

export interface CalculationEnvelope {
  version: typeof CALCULATION_ENVELOPE_VERSION;
  scope: CalculationScope;
  status: CalculationStatus;
  blocker: CalculationBlocker | null;
  calculatedAt: string | null;
  requestedQuantityMicros: number | null;
  executableQuantityMicros: number | null;
  legs: CalculationLeg[];
  totals: CalculationTotals;
  rounding: {
    moneyScale: typeof MONEY_SCALE;
    priceScale: typeof PRICE_SCALE;
    quantityScale: typeof QUANTITY_SCALE;
    mode: 'venue_rules_then_sum';
  };
}

const EMPTY_TOTALS: CalculationTotals = {
  grossCostMicros: null,
  grossPayoutMicros: null,
  grossProfitMicros: null,
  totalFeesMicros: null,
  netPnlMicros: null,
};

function calculatedFeeFromFillLevels(leg: CalculationLeg): number {
  if (!leg.fee.schedule) throw new Error('calculated fee requires schedule authority');
  const scale = BigInt(MONEY_SCALE);
  const denominator = scale * scale * scale;
  const ratePpm = BigInt(leg.fee.schedule.ratePpm);
  const venue = leg.venue.toLowerCase();
  const amount = leg.fillLevels.reduce((sum, level) => {
    const price = BigInt(level.priceMicros);
    const numerator = ratePpm * BigInt(level.quantityMicros) * price * (scale - price);
    if (venue === 'kalshi') {
      const centMicros = 10_000n;
      return sum + ((numerator + denominator * centMicros - 1n) / (denominator * centMicros)) * centMicros;
    }
    if (venue === 'polymarket') {
      const fiveDecimalMicros = 10n;
      return sum + ((numerator + denominator * (fiveDecimalMicros / 2n))
        / (denominator * fiveDecimalMicros)) * fiveDecimalMicros;
    }
    throw new Error(`calculated fee venue ${leg.venue} is unsupported`);
  }, 0n);
  const result = Number(amount);
  if (!Number.isSafeInteger(result)) throw new Error('calculated fee exceeds safe integer range');
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeInteger(name: string, value: unknown, options: { nullable?: boolean; positive?: boolean; nonNegative?: boolean } = {}): asserts value is number | null {
  if (options.nullable && value === null) return;
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  const numeric = value as number;
  if (options.positive && numeric <= 0) throw new Error(`${name} must be positive`);
  if (options.nonNegative && numeric < 0) throw new Error(`${name} must be non-negative`);
}

function assertIsoTimestamp(name: string, value: unknown, nullable = false): asserts value is string | null {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
}

function assertNonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be non-empty`);
}

export function legacyUnverifiableEnvelope(
  context = 'legacy row',
  scope: CalculationScope = 'opportunity',
): CalculationEnvelope {
  return {
    version: CALCULATION_ENVELOPE_VERSION,
    scope,
    status: 'legacy_unverifiable',
    blocker: {
      code: 'legacy_missing_calculation_authority',
      message: `${context} predates the versioned fee and executable-book calculation envelope`,
    },
    calculatedAt: null,
    requestedQuantityMicros: null,
    executableQuantityMicros: null,
    legs: [],
    totals: { ...EMPTY_TOTALS },
    rounding: {
      moneyScale: MONEY_SCALE,
      priceScale: PRICE_SCALE,
      quantityScale: QUANTITY_SCALE,
      mode: 'venue_rules_then_sum',
    },
  };
}

export function validateCalculationEnvelope(value: unknown): CalculationEnvelope {
  if (!isRecord(value)) throw new Error('calculation envelope must be an object');
  if (value.version !== CALCULATION_ENVELOPE_VERSION) throw new Error('unsupported calculation envelope version');
  if (!['opportunity', 'execution', 'position'].includes(String(value.scope))) throw new Error('invalid calculation envelope scope');
  if (!['executable', 'non_executable', 'unavailable', 'legacy_unverifiable'].includes(String(value.status))) {
    throw new Error('invalid calculation envelope status');
  }
  if (value.blocker !== null) {
    if (!isRecord(value.blocker)) throw new Error('calculation envelope blocker must be an object or null');
    assertNonEmpty('blocker.code', value.blocker.code);
    assertNonEmpty('blocker.message', value.blocker.message);
  }
  if (value.status !== 'executable' && value.blocker === null) throw new Error('non-executable calculation envelope requires a blocker');
  assertIsoTimestamp('calculatedAt', value.calculatedAt, true);
  assertSafeInteger('requestedQuantityMicros', value.requestedQuantityMicros, { nullable: true, positive: true });
  assertSafeInteger('executableQuantityMicros', value.executableQuantityMicros, { nullable: true, nonNegative: true });

  if (!Array.isArray(value.legs)) throw new Error('calculation envelope legs must be an array');
  for (const [index, rawLeg] of value.legs.entries()) {
    if (!isRecord(rawLeg)) throw new Error(`legs[${index}] must be an object`);
    assertNonEmpty(`legs[${index}].venue`, rawLeg.venue);
    assertNonEmpty(`legs[${index}].instrumentId`, rawLeg.instrumentId);
    assertNonEmpty(`legs[${index}].outcomeId`, rawLeg.outcomeId);
    if (!['yes', 'no'].includes(String(rawLeg.side))) throw new Error(`legs[${index}].side is invalid`);
    if (!['buy', 'sell'].includes(String(rawLeg.action))) throw new Error(`legs[${index}].action is invalid`);
    assertSafeInteger(`legs[${index}].requestedQuantityMicros`, rawLeg.requestedQuantityMicros, { positive: true });
    assertSafeInteger(`legs[${index}].executableQuantityMicros`, rawLeg.executableQuantityMicros, { nullable: true, nonNegative: true });
    assertIsoTimestamp(`legs[${index}].bookObservedAt`, rawLeg.bookObservedAt, true);
    if (!Array.isArray(rawLeg.fillLevels)) throw new Error(`legs[${index}].fillLevels must be an array`);
    for (const [levelIndex, rawLevel] of rawLeg.fillLevels.entries()) {
      if (!isRecord(rawLevel)) throw new Error(`legs[${index}].fillLevels[${levelIndex}] must be an object`);
      assertSafeInteger(`legs[${index}].fillLevels[${levelIndex}].priceMicros`, rawLevel.priceMicros, { nonNegative: true });
      if ((rawLevel.priceMicros as number) > PRICE_SCALE) throw new Error(`legs[${index}].fillLevels[${levelIndex}].priceMicros exceeds par`);
      assertSafeInteger(`legs[${index}].fillLevels[${levelIndex}].quantityMicros`, rawLevel.quantityMicros, { positive: true });
    }
    assertSafeInteger(`legs[${index}].vwapPriceMicros`, rawLeg.vwapPriceMicros, { nullable: true, nonNegative: true });
    if (rawLeg.vwapPriceMicros !== null && (rawLeg.vwapPriceMicros as number) > PRICE_SCALE) throw new Error(`legs[${index}].vwapPriceMicros exceeds par`);
    if (!isRecord(rawLeg.fee)) throw new Error(`legs[${index}].fee must be an object`);
    if (!['calculated', 'charged', 'unavailable'].includes(String(rawLeg.fee.basis))) throw new Error(`legs[${index}].fee.basis is invalid`);
    assertSafeInteger(`legs[${index}].fee.amountMicros`, rawLeg.fee.amountMicros, { nullable: true, nonNegative: true });
    if (rawLeg.fee.schedule !== null) {
      if (!isRecord(rawLeg.fee.schedule)) throw new Error(`legs[${index}].fee.schedule must be an object or null`);
      assertNonEmpty(`legs[${index}].fee.schedule.source`, rawLeg.fee.schedule.source);
      assertNonEmpty(`legs[${index}].fee.schedule.version`, rawLeg.fee.schedule.version);
      assertIsoTimestamp(`legs[${index}].fee.schedule.observedAt`, rawLeg.fee.schedule.observedAt);
      assertSafeInteger(`legs[${index}].fee.schedule.ratePpm`, rawLeg.fee.schedule.ratePpm, { nonNegative: true });
    }
    if (rawLeg.fee.basis === 'unavailable') {
      if (rawLeg.fee.amountMicros !== null || rawLeg.fee.schedule !== null) throw new Error(`legs[${index}] unavailable fee authority must remain null`);
    } else if (rawLeg.fee.amountMicros === null || rawLeg.fee.schedule === null) {
      throw new Error(`legs[${index}] calculated or charged fee requires amount and schedule authority`);
    }
  }

  if (!isRecord(value.totals)) throw new Error('calculation envelope totals must be an object');
  for (const key of ['grossCostMicros', 'grossPayoutMicros', 'grossProfitMicros', 'totalFeesMicros', 'netPnlMicros'] as const) {
    assertSafeInteger(`totals.${key}`, value.totals[key], { nullable: true, nonNegative: key === 'grossCostMicros' || key === 'grossPayoutMicros' || key === 'totalFeesMicros' });
  }
  if (!isRecord(value.rounding)
    || value.rounding.moneyScale !== MONEY_SCALE
    || value.rounding.priceScale !== PRICE_SCALE
    || value.rounding.quantityScale !== QUANTITY_SCALE
    || value.rounding.mode !== 'venue_rules_then_sum') {
    throw new Error('calculation envelope rounding contract is invalid');
  }

  if (value.status === 'executable') {
    if (value.blocker !== null || value.calculatedAt === null || value.requestedQuantityMicros === null
      || value.executableQuantityMicros === null || value.legs.length === 0) {
      throw new Error('executable calculation envelope is incomplete');
    }
    for (const [index, leg] of (value.legs as unknown as CalculationLeg[]).entries()) {
      if (leg.bookObservedAt === null || leg.executableQuantityMicros === null || leg.fillLevels.length === 0
        || leg.vwapPriceMicros === null || leg.fee.basis === 'unavailable') {
        throw new Error(`executable legs[${index}] is missing book, fill, or fee authority`);
      }
      if (leg.requestedQuantityMicros !== value.requestedQuantityMicros
        || leg.executableQuantityMicros !== value.executableQuantityMicros
        || leg.executableQuantityMicros <= 0
        || leg.executableQuantityMicros > leg.requestedQuantityMicros) {
        throw new Error(`executable legs[${index}] quantity does not reconcile to the envelope`);
      }
      const fillQuantity = leg.fillLevels.reduce((sum, level) => sum + BigInt(level.quantityMicros), 0n);
      if (fillQuantity !== BigInt(leg.executableQuantityMicros)) {
        throw new Error(`executable legs[${index}] fill quantity does not reconcile`);
      }
      const weightedPrice = leg.fillLevels.reduce(
        (sum, level) => sum + BigInt(level.priceMicros) * BigInt(level.quantityMicros),
        0n,
      );
      const roundedVwap = Number((weightedPrice + fillQuantity / 2n) / fillQuantity);
      if (leg.vwapPriceMicros !== roundedVwap) {
        throw new Error(`executable legs[${index}] VWAP does not reconcile to fill levels`);
      }
      if (leg.fee.basis === 'calculated' && leg.fee.amountMicros !== calculatedFeeFromFillLevels(leg)) {
        throw new Error(`executable legs[${index}] calculated fee does not reconcile to fill levels and schedule`);
      }
    }
    const totals = value.totals as unknown as CalculationTotals;
    if (Object.values(totals).some((entry) => entry === null)) throw new Error('executable calculation envelope totals are incomplete');
    const legs = value.legs as unknown as CalculationLeg[];
    const actions = new Set(legs.map((leg) => leg.action));
    if (actions.size !== 1) throw new Error('executable calculation envelope cannot mix buy and sell legs');
    const fillValueMicros = (leg: CalculationLeg) => leg.fillLevels.reduce((sum, level) => (
      sum + Number(
        (BigInt(level.priceMicros) * BigInt(level.quantityMicros) + BigInt(QUANTITY_SCALE) / 2n)
        / BigInt(QUANTITY_SCALE),
      )
    ), 0);
    if (actions.has('buy')) {
      if (legs.length !== 2 || new Set(legs.map((leg) => leg.side)).size !== 2) {
        throw new Error('executable buy envelope requires one complementary yes/no pair');
      }
      const reconciledGrossCost = legs.reduce((sum, leg) => sum + fillValueMicros(leg), 0);
      if (!Number.isSafeInteger(reconciledGrossCost) || totals.grossCostMicros !== reconciledGrossCost) {
        throw new Error('totals.grossCostMicros does not reconcile to buy fill levels');
      }
      if (totals.grossPayoutMicros !== value.executableQuantityMicros) {
        throw new Error('totals.grossPayoutMicros does not reconcile to matched quantity');
      }
    } else {
      const reconciledGrossPayout = legs.reduce((sum, leg) => sum + fillValueMicros(leg), 0);
      if (!Number.isSafeInteger(reconciledGrossPayout) || totals.grossPayoutMicros !== reconciledGrossPayout) {
        throw new Error('totals.grossPayoutMicros does not reconcile to sell fill levels');
      }
    }
    const reconciledGrossProfit = totals.grossPayoutMicros! - totals.grossCostMicros!;
    if (!Number.isSafeInteger(reconciledGrossProfit) || totals.grossProfitMicros !== reconciledGrossProfit) {
      throw new Error('totals.grossProfitMicros does not reconcile');
    }
    const feeSum = (value.legs as unknown as CalculationLeg[]).reduce((sum, leg) => sum + (leg.fee.amountMicros ?? 0), 0);
    if (!Number.isSafeInteger(feeSum) || totals.totalFeesMicros !== feeSum) throw new Error('totals.totalFeesMicros does not reconcile to per-leg fees');
    const reconciledNetPnl = totals.grossProfitMicros! - totals.totalFeesMicros!;
    if (!Number.isSafeInteger(reconciledNetPnl) || totals.netPnlMicros !== reconciledNetPnl) {
      throw new Error('totals.netPnlMicros does not reconcile');
    }
  }

  return value as unknown as CalculationEnvelope;
}

export function parseCalculationEnvelope(value: unknown, legacyContext = 'legacy row'): CalculationEnvelope {
  if (value == null || value === '') return legacyUnverifiableEnvelope(legacyContext);
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {
        ...legacyUnverifiableEnvelope(legacyContext),
        status: 'unavailable',
        blocker: { code: 'malformed_calculation_envelope', message: `${legacyContext} has malformed calculation envelope JSON` },
      };
    }
  }
  try {
    return validateCalculationEnvelope(parsed);
  } catch (error) {
    return {
      ...legacyUnverifiableEnvelope(legacyContext),
      status: 'unavailable',
      blocker: {
        code: 'invalid_calculation_envelope',
        message: error instanceof Error ? error.message : `${legacyContext} has an invalid calculation envelope`,
      },
    };
  }
}

/** Format an integer micro-dollar amount without floating-point coercion. */
export function formatScaledMoney(value: number | null): string {
  if (value === null) return '';
  if (!Number.isSafeInteger(value)) throw new Error('money value must be a safe integer');
  const negative = value < 0;
  const absolute = BigInt(negative ? -value : value);
  const whole = absolute / BigInt(MONEY_SCALE);
  const fraction = (absolute % BigInt(MONEY_SCALE)).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
