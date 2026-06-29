/**
 * Arb Persistence Score — likelihood-to-last rating (0-100)
 *
 * Scores each detected arb 0-100 based on how long it's likely to last.
 * High score = stable, low score = volatile/vanishing.
 *
 * Factors:
 *   Orderbook depth     25% — Deep book = stable, shallow = volatile
 *   Price velocity      25% — Slow-moving = stable, fast = vanishing
 *   Historical lifespan 20% — How long do arbs typically last for this market
 *   Spread stability    15% — Consistent spread vs oscillating
 *   Time to expiry      10% — Near expiry = volatile, far = stable
 *   Liquidity ratio      5% — Balanced both sides = stable, one-sided = fragile
 */

// ─── Types ────────────────────────────────────────────────────────

export interface PersistenceInput {
  kalshiAskDepth: number;
  polymarketAskDepth: number;
  kalshiPriceVelocity: number;  // |Δ/min| — absolute price change per minute
  polymarketPriceVelocity: number;
  historicalAvgLifespanMin?: number;  // average arb lifespan for this market/category
  spreadVariance?: number;  // variance of spread over last N scans (0-1, 0=stable, 1=chaotic)
  minutesToExpiry?: number;
  kalshiDepth: number;
  polymarketDepth: number;
}

export interface PersistenceScore {
  score: number;           // 0-100
  level: 'stable' | 'moderate' | 'volatile';
  factors: {
    depth: number;         // 0-100
    velocity: number;      // 0-100
    history: number;       // 0-100
    spread: number;        // 0-100
    expiry: number;        // 0-100
    liquidityRatio: number; // 0-100
  };
  interpretation: string;
}

// ─── Scoring Functions ───────────────────────────────────────────

function scoreDepth(kalshiDepth: number, polymarketDepth: number): number {
  const minDepth = Math.min(kalshiDepth, polymarketDepth);
  if (minDepth >= 10000) return 100;
  if (minDepth >= 5000) return 85;
  if (minDepth >= 2000) return 70;
  if (minDepth >= 500) return 50;
  if (minDepth >= 100) return 30;
  if (minDepth > 0) return 15;
  return 0;
}

function scoreVelocity(kVelocity: number, pmVelocity: number): number {
  const maxVelocity = Math.max(kVelocity, pmVelocity);
  // velocity is |Δ/min|, typically 0-0.10 (0-10 cents per minute)
  if (maxVelocity < 0.001) return 100;
  if (maxVelocity < 0.005) return 85;
  if (maxVelocity < 0.01) return 70;
  if (maxVelocity < 0.02) return 50;
  if (maxVelocity < 0.05) return 30;
  return 10;
}

function scoreHistory(avgLifespanMin?: number): number {
  if (avgLifespanMin === undefined || avgLifespanMin <= 0) return 50; // no data — neutral
  if (avgLifespanMin >= 60) return 100;    // 1hr+ lifespan
  if (avgLifespanMin >= 30) return 85;
  if (avgLifespanMin >= 10) return 70;
  if (avgLifespanMin >= 5) return 50;
  if (avgLifespanMin >= 2) return 30;
  return 15;
}

function scoreSpreadStability(variance?: number): number {
  if (variance === undefined) return 50; // no data — neutral
  // variance 0 = perfectly stable, 1 = chaotic
  return Math.round(100 * (1 - Math.min(1, variance)));
}

function scoreTimeToExpiry(minutesToExpiry?: number): number {
  if (minutesToExpiry === undefined) return 70; // no expiry — assume stable
  if (minutesToExpiry <= 0) return 10;
  if (minutesToExpiry < 60) return 20;       // <1hr — very volatile
  if (minutesToExpiry < 360) return 40;      // <6hr
  if (minutesToExpiry < 1440) return 60;     // <24hr
  if (minutesToExpiry < 10080) return 80;    // <7 days
  return 90;                                   // >7 days — stable
}

function scoreLiquidityRatio(kalshiDepth: number, polymarketDepth: number): number {
  if (kalshiDepth === 0 && polymarketDepth === 0) return 0;
  const ratio = Math.min(kalshiDepth, polymarketDepth) / Math.max(kalshiDepth, polymarketDepth, 1);
  // ratio 1.0 = perfectly balanced, 0.0 = one-sided
  return Math.round(ratio * 100);
}

// ─── Public API ──────────────────────────────────────────────────

const WEIGHTS = {
  depth: 0.25,
  velocity: 0.25,
  history: 0.20,
  spread: 0.15,
  expiry: 0.10,
  liquidityRatio: 0.05,
};

export function calculatePersistenceScore(input: PersistenceInput): PersistenceScore {
  const factors = {
    depth: scoreDepth(input.kalshiDepth, input.polymarketDepth),
    velocity: scoreVelocity(input.kalshiPriceVelocity, input.polymarketPriceVelocity),
    history: scoreHistory(input.historicalAvgLifespanMin),
    spread: scoreSpreadStability(input.spreadVariance),
    expiry: scoreTimeToExpiry(input.minutesToExpiry),
    liquidityRatio: scoreLiquidityRatio(input.kalshiDepth, input.polymarketDepth),
  };

  const score = Math.round(
    factors.depth * WEIGHTS.depth +
    factors.velocity * WEIGHTS.velocity +
    factors.history * WEIGHTS.history +
    factors.spread * WEIGHTS.spread +
    factors.expiry * WEIGHTS.expiry +
    factors.liquidityRatio * WEIGHTS.liquidityRatio
  );

  let level: 'stable' | 'moderate' | 'volatile';
  let interpretation: string;

  if (score >= 70) {
    level = 'stable';
    interpretation = 'Likely to last 10+ minutes. Safe to execute manually.';
  } else if (score >= 40) {
    level = 'moderate';
    interpretation = 'May last 2-10 minutes. Act quickly.';
  } else {
    level = 'volatile';
    interpretation = 'Likely to vanish within 1-2 minutes. Need instant action or skip.';
  }

  return { score, level, factors, interpretation };
}

// ─── Color Helper ────────────────────────────────────────────────

export function getPersistenceColor(score: number): string {
  if (score >= 70) return '#5DBE81';  // green
  if (score >= 40) return '#facc15';  // yellow
  return '#ef4444';                    // red
}