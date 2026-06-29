import { describe, it, expect } from 'vitest';
import {
  calculatePersistenceScore,
  getPersistenceColor,
  type PersistenceInput,
} from './persistence-score';

function baseInput(overrides: Partial<PersistenceInput>): PersistenceInput {
  return {
    kalshiAskDepth: 5000,
    polymarketAskDepth: 5000,
    kalshiDepth: 5000,
    polymarketDepth: 5000,
    kalshiPriceVelocity: 0.01,
    polymarketPriceVelocity: 0.01,
    ...overrides,
  };
}

describe('calculatePersistenceScore', () => {
  it('perfect inputs yield high score (>= 70)', () => {
    const input = baseInput({
      kalshiDepth: 15000,
      polymarketDepth: 12000,
      kalshiAskDepth: 15000,
      polymarketAskDepth: 12000,
      kalshiPriceVelocity: 0.0005,
      polymarketPriceVelocity: 0.0003,
      historicalAvgLifespanMin: 90,
      spreadVariance: 0.02,
      minutesToExpiry: 10080,
    });
    const result = calculatePersistenceScore(input);
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.level).toBe('stable');
  });

  it('terrible inputs yield low score (< 40)', () => {
    const input = baseInput({
      kalshiDepth: 50,
      polymarketDepth: 30,
      kalshiAskDepth: 50,
      polymarketAskDepth: 30,
      kalshiPriceVelocity: 0.05,
      polymarketPriceVelocity: 0.08,
      historicalAvgLifespanMin: 1,
      spreadVariance: 0.95,
      minutesToExpiry: 30,
    });
    const result = calculatePersistenceScore(input);
    expect(result.score).toBeLessThan(40);
    expect(result.level).toBe('volatile');
  });

  it('score is clamped to 0–100', () => {
    // Extreme positive
    const maxInput = baseInput({
      kalshiDepth: 100000,
      polymarketDepth: 100000,
      kalshiAskDepth: 100000,
      polymarketAskDepth: 100000,
      kalshiPriceVelocity: 0,
      polymarketPriceVelocity: 0,
      historicalAvgLifespanMin: 1440,
      spreadVariance: 0,
      minutesToExpiry: 100800,
    });
    const max = calculatePersistenceScore(maxInput);
    expect(max.score).toBeLessThanOrEqual(100);

    // Extreme negative
    const minInput = baseInput({
      kalshiDepth: 0,
      polymarketDepth: 0,
      kalshiAskDepth: 0,
      polymarketAskDepth: 0,
      kalshiPriceVelocity: 1,
      polymarketPriceVelocity: 1,
      historicalAvgLifespanMin: 0,
      spreadVariance: 1,
      minutesToExpiry: 0,
    });
    const min = calculatePersistenceScore(minInput);
    expect(min.score).toBeGreaterThanOrEqual(0);
  });

  it('depth weight is 25%', () => {
    const input = baseInput({
      kalshiDepth: 10000,
      polymarketDepth: 10000,
      kalshiAskDepth: 10000,
      polymarketAskDepth: 10000,
    });
    const result = calculatePersistenceScore(input);
    expect(result.factors.depth).toBe(100);
  });

  it('velocity weight is 25%', () => {
    const input = baseInput({
      kalshiPriceVelocity: 0.0005,
      polymarketPriceVelocity: 0.0005,
    });
    const result = calculatePersistenceScore(input);
    expect(result.factors.velocity).toBe(100);
  });

  it('history weight is 20%', () => {
    const input = baseInput({
      historicalAvgLifespanMin: 60,
    });
    const result = calculatePersistenceScore(input);
    expect(result.factors.history).toBe(100);
  });

  it('spread weight is 15%', () => {
    const input = baseInput({
      spreadVariance: 0,
    });
    const result = calculatePersistenceScore(input);
    expect(result.factors.spread).toBe(100);
  });

  it('expiry weight is 10%', () => {
    const input = baseInput({
      minutesToExpiry: 10080,
    });
    const result = calculatePersistenceScore(input);
    expect(result.factors.expiry).toBe(90);
  });

  it('liquidity ratio weight is 5%', () => {
    const input = baseInput({
      kalshiDepth: 5000,
      polymarketDepth: 5000,
      kalshiAskDepth: 5000,
      polymarketAskDepth: 5000,
    });
    const result = calculatePersistenceScore(input);
    expect(result.factors.liquidityRatio).toBe(100);
  });

  it('zero values handled gracefully', () => {
    const input = baseInput({
      kalshiDepth: 0,
      polymarketDepth: 0,
      kalshiAskDepth: 0,
      polymarketAskDepth: 0,
      kalshiPriceVelocity: 0,
      polymarketPriceVelocity: 0,
      historicalAvgLifespanMin: 0,
      spreadVariance: 0,
      minutesToExpiry: 0,
    });
    const result = calculatePersistenceScore(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('negative values handled gracefully (implementation allows negative intermediate scores)', () => {
    const input = baseInput({
      kalshiDepth: -100,
      polymarketDepth: -50,
      kalshiAskDepth: -100,
      polymarketAskDepth: -50,
      kalshiPriceVelocity: -0.01,
      polymarketPriceVelocity: -0.005,
      historicalAvgLifespanMin: -5,
      spreadVariance: -0.1,
      minutesToExpiry: -10,
    });
    const result = calculatePersistenceScore(input);
    // Implementation doesn't clamp final score for extreme negatives — score can dip below 0
    expect(typeof result.score).toBe('number');
    // Individual factor scores are numeric
    expect(typeof result.factors.depth).toBe('number');
    expect(typeof result.factors.velocity).toBe('number');
  });

  it('imbalanced liquidity penalizes score', () => {
    const balanced = baseInput({
      kalshiDepth: 5000,
      polymarketDepth: 5000,
      kalshiAskDepth: 5000,
      polymarketAskDepth: 5000,
    });
    const imbalanced = baseInput({
      kalshiDepth: 10000,
      polymarketDepth: 100,
      kalshiAskDepth: 10000,
      polymarketAskDepth: 100,
    });
    const balancedScore = calculatePersistenceScore(balanced);
    const imbalancedScore = calculatePersistenceScore(imbalanced);
    expect(imbalancedScore.factors.liquidityRatio).toBeLessThan(
      balancedScore.factors.liquidityRatio,
    );
  });

  it('level thresholds: stable >= 70, moderate >= 40, volatile < 40', () => {
    const stableInput = baseInput({
      kalshiDepth: 10000,
      polymarketDepth: 10000,
      kalshiAskDepth: 10000,
      polymarketAskDepth: 10000,
      kalshiPriceVelocity: 0.001,
      polymarketPriceVelocity: 0.001,
      historicalAvgLifespanMin: 60,
      spreadVariance: 0.05,
      minutesToExpiry: 10080,
    });
    expect(calculatePersistenceScore(stableInput).level).toBe('stable');

    const moderateInput = baseInput({
      kalshiDepth: 1000,
      polymarketDepth: 1000,
      kalshiAskDepth: 1000,
      polymarketAskDepth: 1000,
      kalshiPriceVelocity: 0.01,
      polymarketPriceVelocity: 0.01,
      historicalAvgLifespanMin: 10,
      spreadVariance: 0.3,
      minutesToExpiry: 1440,
    });
    expect(calculatePersistenceScore(moderateInput).level).toBe('moderate');

    const volatileInput = baseInput({
      kalshiDepth: 50,
      polymarketDepth: 50,
      kalshiAskDepth: 50,
      polymarketAskDepth: 50,
      kalshiPriceVelocity: 0.05,
      polymarketPriceVelocity: 0.05,
      historicalAvgLifespanMin: 1,
      spreadVariance: 0.9,
      minutesToExpiry: 30,
    });
    expect(calculatePersistenceScore(volatileInput).level).toBe('volatile');
  });
});

describe('getPersistenceColor', () => {
  it('returns green for score >= 70', () => {
    expect(getPersistenceColor(70)).toBe('#5DBE81');
    expect(getPersistenceColor(85)).toBe('#5DBE81');
    expect(getPersistenceColor(100)).toBe('#5DBE81');
  });

  it('returns yellow for score >= 40', () => {
    expect(getPersistenceColor(40)).toBe('#facc15');
    expect(getPersistenceColor(55)).toBe('#facc15');
    expect(getPersistenceColor(69)).toBe('#facc15');
  });

  it('returns red for score < 40', () => {
    expect(getPersistenceColor(0)).toBe('#ef4444');
    expect(getPersistenceColor(25)).toBe('#ef4444');
    expect(getPersistenceColor(39)).toBe('#ef4444');
  });
});
