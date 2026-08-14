export const QUANTITY_SCALE = 1_000_000;
export const MICRO_CENTS_PER_CENT = 1_000_000;
export const MICRO_CENTS_PER_DOLLAR = 100_000_000;

export type ExecutableBookStatus = 'executable' | 'non_executable' | 'unavailable';
export type ExecutableBookReason =
  | 'below_minimum_order'
  | 'empty_book'
  | 'insufficient_depth'
  | 'invalid_tick'
  | 'malformed_level'
  | 'missing_depth_timestamp'
  | 'invalid_request';

export interface ExecutableBookLevel {
  /** Cent price retained for compatibility; may be fractional for sub-cent ticks. */
  priceCents?: number;
  /** Integer millionths of one cent. Preferred venue-exact representation. */
  priceMicroCents?: number;
  /** Integer millionths of a share/contract. */
  quantityMicros: number;
}

export type ExecutableBookFill = ExecutableBookLevel;

export interface ExecutableBookQuote {
  status: ExecutableBookStatus;
  reason: ExecutableBookReason | null;
  requestedQuantityMicros: number;
  filledQuantityMicros: number;
  /** Rounded total cost in millionths of one cent. */
  totalCostMicroCents: number;
  /** VWAP in millionths of one cent; null unless the full request is executable. */
  vwapPriceMicroCents: number | null;
  /** Marketable worst consumed level in millionths of one cent. */
  limitPriceMicroCents: number | null;
  fills: ExecutableBookFill[];
  depthTimestamp: string | null;
  /** Venue constraints bound to the observed ladder and checked at runtime boundaries. */
  tickSizeMicroCents: number;
  minimumOrderQuantityMicros: number;
}

export interface WalkExecutableBookRequest {
  side: 'buy' | 'sell';
  levels: ExecutableBookLevel[];
  requestedQuantityMicros: number;
  tickSizeCents?: number;
  tickSizeMicroCents?: number;
  minimumOrderQuantityMicros: number;
  depthTimestamp: string | null;
}

function levelPriceMicroCents(level: ExecutableBookLevel): number {
  if (Number.isSafeInteger(level.priceMicroCents)) return level.priceMicroCents!;
  const scaled = (level.priceCents ?? Number.NaN) * MICRO_CENTS_PER_CENT;
  const rounded = Math.round(scaled);
  return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) < 1e-6
    ? rounded
    : Number.NaN;
}

function requestTickMicroCents(request: WalkExecutableBookRequest): number {
  if (Number.isSafeInteger(request.tickSizeMicroCents)) return request.tickSizeMicroCents!;
  const scaled = (request.tickSizeCents ?? Number.NaN) * MICRO_CENTS_PER_CENT;
  const rounded = Math.round(scaled);
  return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) < 1e-6
    ? rounded
    : Number.NaN;
}

function quote(
  request: WalkExecutableBookRequest,
  status: ExecutableBookStatus,
  reason: ExecutableBookReason | null,
  fills: ExecutableBookFill[] = [],
): ExecutableBookQuote {
  const filledQuantityMicros = fills.reduce((sum, fill) => sum + fill.quantityMicros, 0);
  const weightedPriceQuantity = fills.reduce(
    (sum, fill) => sum + BigInt(levelPriceMicroCents(fill)) * BigInt(fill.quantityMicros),
    0n,
  );
  const totalCostMicroCents = Number(
    (weightedPriceQuantity + BigInt(QUANTITY_SCALE) / 2n) / BigInt(QUANTITY_SCALE),
  );
  const complete = status === 'executable' && filledQuantityMicros === request.requestedQuantityMicros;
  const vwapPriceMicroCents = complete
    ? Number(
      (weightedPriceQuantity + BigInt(request.requestedQuantityMicros) / 2n)
      / BigInt(request.requestedQuantityMicros),
    )
    : null;
  const limitPriceMicroCents = complete
    ? (request.side === 'buy'
      ? Math.max(...fills.map(levelPriceMicroCents))
      : Math.min(...fills.map(levelPriceMicroCents)))
    : null;

  return {
    status,
    reason,
    requestedQuantityMicros: request.requestedQuantityMicros,
    filledQuantityMicros,
    totalCostMicroCents,
    vwapPriceMicroCents,
    limitPriceMicroCents,
    fills,
    depthTimestamp: request.depthTimestamp || null,
    tickSizeMicroCents: requestTickMicroCents(request),
    minimumOrderQuantityMicros: request.minimumOrderQuantityMicros,
  };
}

/**
 * Produce an executable quote by walking only the requested quantity.
 * Inputs are fixed-point integers so book traversal cannot invent a percentage-
 * adjusted price or accumulate binary floating-point monetary error.
 */
export function walkExecutableBook(request: WalkExecutableBookRequest): ExecutableBookQuote {
  const tickSizeMicroCents = requestTickMicroCents(request);
  const validRequest = Number.isSafeInteger(request.requestedQuantityMicros)
    && request.requestedQuantityMicros > 0
    && request.requestedQuantityMicros <= Math.floor(Number.MAX_SAFE_INTEGER / MICRO_CENTS_PER_DOLLAR)
    && Number.isSafeInteger(tickSizeMicroCents)
    && tickSizeMicroCents > 0
    && Number.isSafeInteger(request.minimumOrderQuantityMicros)
    && request.minimumOrderQuantityMicros > 0;
  if (!validRequest) return quote(request, 'unavailable', 'invalid_request');
  if (!request.depthTimestamp || !Number.isFinite(Date.parse(request.depthTimestamp))) {
    return quote(request, 'unavailable', 'missing_depth_timestamp');
  }
  if (!Array.isArray(request.levels) || request.levels.length === 0) {
    return quote(request, 'unavailable', 'empty_book');
  }
  if (request.levels.some((level) =>
    !Number.isSafeInteger(levelPriceMicroCents(level))
    || levelPriceMicroCents(level) <= 0
    || levelPriceMicroCents(level) >= MICRO_CENTS_PER_DOLLAR
    || !Number.isSafeInteger(level.quantityMicros)
    || level.quantityMicros <= 0
  )) {
    return quote(request, 'unavailable', 'malformed_level');
  }
  if (request.requestedQuantityMicros < request.minimumOrderQuantityMicros) {
    return quote(request, 'non_executable', 'below_minimum_order');
  }

  const ordered = [...request.levels].sort((a, b) =>
    request.side === 'buy'
      ? levelPriceMicroCents(a) - levelPriceMicroCents(b)
      : levelPriceMicroCents(b) - levelPriceMicroCents(a),
  );
  const fills: ExecutableBookFill[] = [];
  let remaining = request.requestedQuantityMicros;

  for (const level of ordered) {
    if (remaining === 0) break;
    const priceMicroCents = levelPriceMicroCents(level);
    if (priceMicroCents % tickSizeMicroCents !== 0) {
      return quote(request, 'non_executable', 'invalid_tick', fills);
    }
    const quantityMicros = Math.min(remaining, level.quantityMicros);
    fills.push({
      priceCents: priceMicroCents / MICRO_CENTS_PER_CENT,
      priceMicroCents,
      quantityMicros,
    });
    remaining -= quantityMicros;
  }

  if (remaining > 0) return quote(request, 'non_executable', 'insufficient_depth', fills);
  return quote(request, 'executable', null, fills);
}

/** Validate an executable quote crossing an untrusted API/runtime boundary. */
export function isExecutableQuoteConsistent(
  candidate: ExecutableBookQuote | undefined,
  side: 'buy' | 'sell',
  expectedQuantityMicros: number,
): candidate is ExecutableBookQuote {
  if (!candidate || candidate.status !== 'executable' || candidate.reason !== null
      || !Number.isSafeInteger(expectedQuantityMicros) || expectedQuantityMicros <= 0
      || candidate.requestedQuantityMicros !== expectedQuantityMicros
      || candidate.filledQuantityMicros !== expectedQuantityMicros
      || !Number.isSafeInteger(candidate.tickSizeMicroCents) || candidate.tickSizeMicroCents <= 0
      || !Number.isSafeInteger(candidate.minimumOrderQuantityMicros) || candidate.minimumOrderQuantityMicros <= 0
      || expectedQuantityMicros < candidate.minimumOrderQuantityMicros
      || !candidate.depthTimestamp || !Number.isFinite(Date.parse(candidate.depthTimestamp))
      || !Array.isArray(candidate.fills) || candidate.fills.length === 0) return false;

  const normalized = candidate.fills.map((fill) => ({
    priceMicroCents: levelPriceMicroCents(fill),
    quantityMicros: fill.quantityMicros,
  }));
  if (normalized.some((fill) => !Number.isSafeInteger(fill.priceMicroCents)
      || fill.priceMicroCents <= 0 || fill.priceMicroCents >= MICRO_CENTS_PER_DOLLAR
      || fill.priceMicroCents % candidate.tickSizeMicroCents !== 0
      || !Number.isSafeInteger(fill.quantityMicros) || fill.quantityMicros <= 0)) return false;
  if (normalized.reduce((sum, fill) => sum + fill.quantityMicros, 0) !== expectedQuantityMicros) return false;

  const weighted = normalized.reduce(
    (sum, fill) => sum + BigInt(fill.priceMicroCents) * BigInt(fill.quantityMicros),
    0n,
  );
  const recomputedCost = Number((weighted + BigInt(QUANTITY_SCALE) / 2n) / BigInt(QUANTITY_SCALE));
  const recomputedVwap = Number(
    (weighted + BigInt(expectedQuantityMicros) / 2n) / BigInt(expectedQuantityMicros),
  );
  const recomputedLimit = side === 'buy'
    ? Math.max(...normalized.map((fill) => fill.priceMicroCents))
    : Math.min(...normalized.map((fill) => fill.priceMicroCents));
  return candidate.totalCostMicroCents === recomputedCost
    && candidate.vwapPriceMicroCents === recomputedVwap
    && candidate.limitPriceMicroCents === recomputedLimit;
}
