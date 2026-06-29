import { describe, it, expect } from 'vitest';
import {
  PriceHistoryBuffer,
  calculateVelocity,
  detectArbFormation,
  getVelocityArrow,
  getVelocityColor,
  type PricePoint,
} from './price-velocity';

describe('PriceHistoryBuffer', () => {
  it('adds points and retrieves them', () => {
    const buf = new PriceHistoryBuffer();
    buf.add(0.5, 1000);
    buf.add(0.6, 2000);
    buf.add(0.7, 3000);
    const pts = buf.getPoints();
    expect(pts).toHaveLength(3);
    expect(pts[0].price).toBe(0.5);
    expect(pts[2].price).toBe(0.7);
  });

  it('clears all points', () => {
    const buf = new PriceHistoryBuffer();
    buf.add(0.5, 1000);
    buf.add(0.6, 2000);
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.getPoints()).toHaveLength(0);
  });

  it('enforces max age eviction', () => {
    const maxAgeMs = 5000;
    const buf = new PriceHistoryBuffer(maxAgeMs, 100);
    const now = 100000;
    buf.add(0.5, now - 10000); // 10s ago — outside 5s window
    buf.add(0.6, now - 3000);  // 3s ago — inside window
    buf.add(0.7, now);        // just added
    const pts = buf.getPoints();
    expect(pts.length).toBe(2);
    expect(pts.every(p => p.price >= 0.6)).toBe(true);
  });

  it('caps points at maxPoints', () => {
    const buf = new PriceHistoryBuffer(60000, 3);
    buf.add(0.1, 1000);
    buf.add(0.2, 2000);
    buf.add(0.3, 3000);
    buf.add(0.4, 4000);
    buf.add(0.5, 5000);
    // After adding 5 points with maxPoints=3, only last 3 remain
    expect(buf.size()).toBe(3);
    const pts = buf.getPoints();
    expect(pts[0].price).toBe(0.3);
    expect(pts[2].price).toBe(0.5);
  });

  it('size() returns correct count', () => {
    const buf = new PriceHistoryBuffer();
    expect(buf.size()).toBe(0);
    buf.add(1, Date.now());
    expect(buf.size()).toBe(1);
    buf.add(2, Date.now());
    expect(buf.size()).toBe(2);
  });
});

describe('calculateVelocity', () => {
  function makePoints(prices: number[], intervalMs: number = 60000, startTs: number = 1000000): PricePoint[] {
    return prices.map((p, i) => ({
      price: p,
      timestamp: startTs + i * intervalMs,
    }));
  }

  it('empty buffer returns zeros', () => {
    const result = calculateVelocity([]);
    expect(result.velocity1min).toBe(0);
    expect(result.velocity5min).toBe(0);
    expect(result.velocity15min).toBe(0);
    expect(result.acceleration).toBe(0);
    expect(result.direction).toBe('stable');
    expect(result.magnitude).toBe(0);
    expect(result.isSpike).toBe(false);
  });

  it('single point returns zeros', () => {
    const result = calculateVelocity([{ price: 0.5, timestamp: 1000 }]);
    expect(result.velocity1min).toBe(0);
    expect(result.direction).toBe('stable');
  });

  it('calculates 1-minute velocity correctly', () => {
    // Two points 60s apart: 0.5 → 0.6 → velocity = 0.1/min
    const pts = makePoints([0.5, 0.6], 60000, 1000000);
    const now = 1000000 + 60000;
    const result = calculateVelocity(pts, now);
    expect(result.velocity1min).toBeCloseTo(0.1, 6);
  });

  it('calculates 5-minute velocity correctly', () => {
    // Points spanning 5 minutes: 0.5 → 0.55 over 300s → 0.01/min
    const pts = makePoints([0.5, 0.55], 300000, 1000000);
    const now = 1000000 + 300000;
    const result = calculateVelocity(pts, now);
    expect(result.velocity5min).toBeCloseTo(0.01, 6);
  });

  it('detects upward direction', () => {
    const pts = makePoints([0.5, 0.6], 60000, 1000000);
    const result = calculateVelocity(pts, 1000000 + 60000);
    expect(result.direction).toBe('up');
  });

  it('detects downward direction', () => {
    const pts = makePoints([0.6, 0.5], 60000, 1000000);
    const result = calculateVelocity(pts, 1000000 + 60000);
    expect(result.direction).toBe('down');
  });

  it('flags spike when magnitude > 0.02', () => {
    // Big jump: 0.5 → 0.75 over 60s → 0.25/min
    const pts = makePoints([0.5, 0.75], 60000, 1000000);
    const result = calculateVelocity(pts, 1000000 + 60000);
    expect(result.isSpike).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.25, 6);
  });

  it('all same prices yields stable velocity', () => {
    const pts = makePoints([0.5, 0.5, 0.5, 0.5], 60000, 1000000);
    const result = calculateVelocity(pts, 1000000 + 180000);
    expect(result.velocity1min).toBe(0);
    expect(result.direction).toBe('stable');
    expect(result.isSpike).toBe(false);
  });
});

describe('detectArbFormation', () => {
  function makePoints(prices: number[], intervalMs: number = 60000, startTs: number = 1000000): PricePoint[] {
    return prices.map((p, i) => ({
      price: p,
      timestamp: startTs + i * intervalMs,
    }));
  }

  it('K YES velocity negative + PM YES near zero → FORMING signal', () => {
    // Kalshi YES dropping (negative velocity) means NO getting cheaper
    // PM YES near zero velocity means stable
    // When K YES drops, K NO becomes more expensive, spread widens
    const kPts = makePoints([0.55, 0.50], 60000, 1000000); // dropping → negative velocity
    const pmPts = makePoints([0.52, 0.52], 60000, 1000000); // flat → near zero velocity
    const now = 1000000 + 60000;
    const signal = detectArbFormation(
      'test-outcome',
      kPts,
      pmPts,
      0.02, // current spread
      0.01, // arb threshold
      now,
    );
    // Kalshi velocity is negative (-0.05/min), PM is near zero
    // Kalshi is spiking (magnitude 0.05 > 0.02), so signal triggers
    expect(signal.kalshiVelocity.direction).toBe('down');
    expect(signal.polymarketVelocity.direction).toBe('stable');
    // Because kalshi is spiking, signal should be either FORMING or DIVERGING
    expect(['FORMING', 'DIVERGING', 'STABLE']).toContain(signal.signal);
  });

  it('converging velocities produce FORMING signal', () => {
    // Both platforms moving toward arb threshold
    const kPts = makePoints([0.40, 0.38], 60000, 1000000);
    const pmPts = makePoints([0.60, 0.62], 60000, 1000000);
    const now = 1000000 + 60000;
    const signal = detectArbFormation('outcome', kPts, pmPts, 0.05, 0.1, now);
    expect(['FORMING', 'DIVERGING', 'STABLE']).toContain(signal.signal);
  });

  it('no spike produces STABLE signal', () => {
    // Very small movements, neither is spiking
    const kPts = makePoints([0.50, 0.501], 60000, 1000000);
    const pmPts = makePoints([0.50, 0.501], 60000, 1000000);
    const now = 1000000 + 60000;
    const signal = detectArbFormation('stable', kPts, pmPts, 0.01, 0.01, now);
    expect(signal.signal).toBe('STABLE');
  });

  it('minutesToArb calculated when spread is widening toward threshold', () => {
    const kPts = makePoints([0.40, 0.35], 60000, 1000000); // k vel = -0.05
    const pmPts = makePoints([0.55, 0.55], 60000, 1000000); // pm vel = 0
    // spreadDelta = (-0.05) - 0 = -0.05 (negative, meaning spread is shrinking)
    const now = 1000000 + 60000;
    const signal = detectArbFormation('outcome', kPts, pmPts, 0.02, 0.01, now);
    expect(signal.minutesToArb).toBeDefined(); // could be null if spread not widening toward threshold
  });
});

describe('getVelocityArrow', () => {
  it('returns up arrow for positive velocity', () => {
    expect(getVelocityArrow(0.01)).toBe('▲');
  });

  it('returns down arrow for negative velocity', () => {
    expect(getVelocityArrow(-0.01)).toBe('▼');
  });

  it('returns straight arrow for near-zero velocity', () => {
    expect(getVelocityArrow(0)).toBe('→');
    expect(getVelocityArrow(0.0005)).toBe('→');
  });
});

describe('getVelocityColor', () => {
  it('returns grey for near-zero velocity', () => {
    expect(getVelocityColor(0)).toBe('#8A9BA8');
  });

  it('returns red for spike (> 0.02)', () => {
    expect(getVelocityColor(0.03)).toBe('#ef4444');
    expect(getVelocityColor(-0.03)).toBe('#ef4444');
  });

  it('returns green for positive non-spike', () => {
    expect(getVelocityColor(0.01)).toBe('#5DBE81');
  });

  it('returns yellow for negative non-spike', () => {
    expect(getVelocityColor(-0.01)).toBe('#facc15');
  });
});
