import { describe, it, expect } from 'vitest';
import { attachPersistenceScores } from './persistence-tracker';
import type { LiveArbResult } from './live-arb-engine';

function mkResult(over: Partial<LiveArbResult> = {}): LiveArbResult {
  return {
    artist: 'Outcome A',
    arbType: 'direct',
    kalshiYesAsk: 0.45,
    kalshiNoAsk: 0.57,
    kalshiYesDepth: 5000,
    kalshiNoDepth: 4000,
    pmYesAsk: 0.5,
    pmNoAsk: 0.52,
    pmYesDepth: 6000,
    pmNoDepth: 3000,
    strategy: 'Buy K YES + PM NO',
    roiPct: 2.1,
    expectedProfit: 4.2,
    kalshiStake: 45,
    pmStake: 52,
    fees: { kalshiFee: 0.5, pmFee: 0.2, worstCaseNetProfit: 3.5 },
    stale: false,
    lastUpdate: new Date().toISOString(),
    ...over,
  };
}

describe('attachPersistenceScores', () => {
  it('attaches a score to non-stale results with both legs priced', () => {
    const now = Date.now();
    const results = [mkResult()];
    attachPersistenceScores(results, { marketKey: 'test-1' }, now);
    expect(results[0].persistence).toBeDefined();
    expect(results[0].persistence!.score).toBeGreaterThanOrEqual(0);
    expect(results[0].persistence!.score).toBeLessThanOrEqual(100);
    expect(['stable', 'moderate', 'volatile']).toContain(results[0].persistence!.level);
  });

  it('skips stale results', () => {
    const results = [mkResult({ stale: true })];
    attachPersistenceScores(results, { marketKey: 'test-2' });
    expect(results[0].persistence).toBeUndefined();
  });

  it('skips results missing a leg price', () => {
    const results = [mkResult({ pmYesAsk: null })];
    attachPersistenceScores(results, { marketKey: 'test-3' });
    expect(results[0].persistence).toBeUndefined();
  });

  it('velocity factor drops when prices move fast across ticks', () => {
    const key = { marketKey: 'test-4' };
    const t0 = Date.now();
    // stable feed
    for (let i = 0; i < 10; i++) {
      attachPersistenceScores([mkResult()], { marketKey: 'stable-mk' }, t0 + i * 6000);
    }
    const stable = [mkResult()];
    attachPersistenceScores(stable, { marketKey: 'stable-mk' }, t0 + 60000);

    // fast-moving feed: price shifts 1 cent per tick (~0.1/min)
    for (let i = 0; i < 10; i++) {
      attachPersistenceScores(
        [mkResult({ kalshiYesAsk: 0.45 + i * 0.01 })],
        { marketKey: 'fast-mk' },
        t0 + i * 6000,
      );
    }
    const fast = [mkResult({ kalshiYesAsk: 0.55 })];
    attachPersistenceScores(fast, { marketKey: 'fast-mk' }, t0 + 60000);

    expect(fast[0].persistence!.factors.velocity).toBeLessThan(
      stable[0].persistence!.factors.velocity,
    );
    void key;
  });

  it('historical lifespan feeds the history factor', () => {
    const withHistory = [mkResult()];
    attachPersistenceScores(withHistory, { marketKey: 'hist-mk', avgLifespanMin: 90 });
    const noHistory = [mkResult()];
    attachPersistenceScores(noHistory, { marketKey: 'nohist-mk' });
    expect(withHistory[0].persistence!.factors.history).toBe(100);
    expect(noHistory[0].persistence!.factors.history).toBe(50);
  });

  // HOOKUP-03 (FEAT-005): arb-formation signal
  it('attaches a formation signal alongside the persistence score', () => {
    const results = [mkResult()];
    attachPersistenceScores(results, { marketKey: 'form-1' });
    expect(results[0].formation).toBeDefined();
    expect(['FORMING', 'STABLE', 'DIVERGING']).toContain(results[0].formation!.signal);
  });

  it('reports STABLE when prices are quiet', () => {
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      attachPersistenceScores([mkResult()], { marketKey: 'quiet-mk' }, t0 + i * 6000);
    }
    const r = [mkResult()];
    attachPersistenceScores(r, { marketKey: 'quiet-mk' }, t0 + 60000);
    expect(r[0].formation!.signal).toBe('STABLE');
    expect(r[0].formation!.isSpike).toBe(false);
  });

  it('flags FORMING when a fast Kalshi drop pushes the spread toward arb', () => {
    const t0 = Date.now();
    // Kalshi YES ask falls 3¢/min (spike) while PM NO holds — combined cost
    // drops below 1, spread converges toward the arb threshold.
    for (let i = 0; i <= 10; i++) {
      attachPersistenceScores(
        [mkResult({ kalshiYesAsk: 0.50 - i * 0.003, pmNoAsk: 0.52 })],
        { marketKey: 'forming-mk' },
        t0 + i * 6000,
      );
    }
    const r = [mkResult({ kalshiYesAsk: 0.47, pmNoAsk: 0.52 })];
    attachPersistenceScores(r, { marketKey: 'forming-mk' }, t0 + 66000);
    expect(r[0].formation!.isSpike).toBe(true);
    expect(r[0].formation!.signal).toBe('FORMING');
  });
});
