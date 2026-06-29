/**
 * Price Velocity Indicator — leading indicator for arb formation prediction
 *
 * Tracks price change rate (Δ/min) for each outcome on both platforms.
 * When velocity spikes on one side, an arb is likely forming.
 */

// ─── Types ────────────────────────────────────────────────────────

export interface PricePoint {
  price: number;
  timestamp: number;  // ms epoch
}

export interface VelocityResult {
  velocity1min: number;    // Δ/min over last 1 minute
  velocity5min: number;    // Δ/min over last 5 minutes
  velocity15min: number;   // Δ/min over last 15 minutes
  acceleration: number;    // change in velocity (velocity now vs 5 min ago)
  direction: 'up' | 'down' | 'stable';
  magnitude: number;       // absolute velocity (always positive)
  isSpike: boolean;        // true if velocity > 0.02/min (significant)
}

export interface ArbFormationSignal {
  outcome: string;
  kalshiVelocity: VelocityResult;
  polymarketVelocity: VelocityResult;
  predictedSpread: number;   // estimated spread in N minutes
  currentSpread: number;
  minutesToArb: number | null;  // estimated minutes until arb threshold crossed, null if not converging
  signal: 'FORMING' | 'STABLE' | 'DIVERGING';
}

// ─── Ring Buffer for Price History ────────────────────────────────

export class PriceHistoryBuffer {
  private points: PricePoint[] = [];
  private readonly maxAgeMs: number;
  private readonly maxPoints: number;

  constructor(maxAgeMs: number = 15 * 60 * 1000, maxPoints: number = 500) {
    this.maxAgeMs = maxAgeMs;
    this.maxPoints = maxPoints;
  }

  add(price: number, timestamp: number = Date.now()): void {
    this.points.push({ price, timestamp });
    this.evict(timestamp);
  }

  private evict(now: number): void {
    const cutoff = now - this.maxAgeMs;
    while (this.points.length > 0 && this.points[0].timestamp < cutoff) {
      this.points.shift();
    }
    if (this.points.length > this.maxPoints) {
      this.points = this.points.slice(-this.maxPoints);
    }
  }

  getPoints(): PricePoint[] {
    return [...this.points];
  }

  clear(): void {
    this.points = [];
  }

  size(): number {
    return this.points.length;
  }
}

// ─── Velocity Calculation ────────────────────────────────────────

export function calculateVelocity(history: PricePoint[], now: number = Date.now()): VelocityResult {
  if (history.length < 2) {
    return {
      velocity1min: 0,
      velocity5min: 0,
      velocity15min: 0,
      acceleration: 0,
      direction: 'stable',
      magnitude: 0,
      isSpike: false,
    };
  }

  const calcRate = (windowMs: number): number => {
    const cutoff = now - windowMs;
    const inWindow = history.filter(p => p.timestamp >= cutoff);
    if (inWindow.length < 2) return 0;
    const first = inWindow[0];
    const last = inWindow[inWindow.length - 1];
    const elapsedMin = (last.timestamp - first.timestamp) / 60000;
    if (elapsedMin <= 0) return 0;
    return (last.price - first.price) / elapsedMin;
  };

  const velocity1min = calcRate(60 * 1000);
  const velocity5min = calcRate(5 * 60 * 1000);
  const velocity15min = calcRate(15 * 60 * 1000);

  // Acceleration: how much velocity has changed
  // Compare recent velocity (1min) to older velocity (5min window excluding last 1min)
  const recentCutoff = now - 60 * 1000;
  const olderPoints = history.filter(p => p.timestamp < recentCutoff && p.timestamp >= now - 6 * 60 * 1000);
  let olderVelocity = 0;
  if (olderPoints.length >= 2) {
    const elapsedMin = (olderPoints[olderPoints.length - 1].timestamp - olderPoints[0].timestamp) / 60000;
    if (elapsedMin > 0) {
      olderVelocity = (olderPoints[olderPoints.length - 1].price - olderPoints[0].price) / elapsedMin;
    }
  }
  const acceleration = velocity1min - olderVelocity;

  const direction = velocity1min > 0.001 ? 'up' : velocity1min < -0.001 ? 'down' : 'stable';
  const magnitude = Math.abs(velocity1min);
  const isSpike = magnitude > 0.02;

  return {
    velocity1min,
    velocity5min,
    velocity15min,
    acceleration,
    direction,
    magnitude,
    isSpike,
  };
}

// ─── Arb Formation Prediction ────────────────────────────────────

export function detectArbFormation(
  outcome: string,
  kalshiHistory: PricePoint[],
  polymarketHistory: PricePoint[],
  currentSpread: number,
  arbThreshold: number = 0.01,
  now: number = Date.now(),
): ArbFormationSignal {
  const kalshiVelocity = calculateVelocity(kalshiHistory, now);
  const polymarketVelocity = calculateVelocity(polymarketHistory, now);

  // Predict spread in 1 minute: current spread + (kVel - pmVel) * 1 min
  const spreadDelta = (kalshiVelocity.velocity1min - polymarketVelocity.velocity1min);
  const predictedSpread = currentSpread + spreadDelta;

  // Estimate time to arb threshold
  let minutesToArb: number | null = null;
  if (Math.abs(spreadDelta) > 0.0001) {
    const remaining = arbThreshold - currentSpread;
    if (remaining > 0 && spreadDelta > 0) {
      // Spread is widening towards threshold (arb forming)
      minutesToArb = Math.round(remaining / spreadDelta);
    } else if (remaining > 0 && spreadDelta < 0) {
      // Spread is narrowing away from threshold — no arb forming
      minutesToArb = null;
    }
  }

  let signal: 'FORMING' | 'STABLE' | 'DIVERGING';
  if (kalshiVelocity.isSpike || polymarketVelocity.isSpike) {
    signal = predictedSpread >= arbThreshold ? 'FORMING' : 'DIVERGING';
  } else {
    signal = 'STABLE';
  }

  return {
    outcome,
    kalshiVelocity,
    polymarketVelocity,
    predictedSpread,
    currentSpread,
    minutesToArb,
    signal,
  };
}

// ─── Velocity Display Helpers ────────────────────────────────────

export function getVelocityArrow(velocity: number): string {
  if (velocity > 0.001) return '▲';
  if (velocity < -0.001) return '▼';
  return '→';
}

export function getVelocityColor(velocity: number): string {
  if (Math.abs(velocity) < 0.001) return '#8A9BA8';  // grey — stable
  if (Math.abs(velocity) > 0.02) return '#ef4444';    // red — spike
  if (velocity > 0) return '#5DBE81';                 // green — rising
  return '#facc15';                                   // yellow — falling
}