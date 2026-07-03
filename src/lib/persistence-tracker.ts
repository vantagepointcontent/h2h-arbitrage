/**
 * HOOKUP-02 (FEAT-004): Persistence-score tracker.
 *
 * Bridges the live arb pipeline to calculatePersistenceScore() by maintaining
 * the rolling state the pure scorer needs but the engine doesn't have:
 *   • per-outcome price history (Kalshi + PM) → price velocity
 *   • per-outcome spread (ROI) history        → spread stability/variance
 *   • cached historical avg episode lifespan  → history factor
 *
 * In-memory, per-process. Both consumers (ws-watcher daemon and the
 * live-scan SSE route) run long enough for the buffers to be meaningful.
 * State is keyed by `${marketKey}:${artist}` and evicted after inactivity.
 */
import { PriceHistoryBuffer, calculateVelocity, detectArbFormation } from './price-velocity';
import { calculatePersistenceScore, PersistenceScore } from './persistence-score';
import type { LiveArbResult } from './live-arb-engine';

interface OutcomeTrack {
  kBuf: PriceHistoryBuffer;
  pmBuf: PriceHistoryBuffer;
  roiWindow: number[];      // last N roiPct samples
  lastTouched: number;
}

const ROI_WINDOW = 30;
const EVICT_AFTER_MS = 30 * 60 * 1000;
/** Spread (1 - combined cost) above which an arb is considered formed. */
const ARB_SPREAD_THRESHOLD = 0.01;

const tracks = new Map<string, OutcomeTrack>();
let lastEvictAt = 0;

function getTrack(key: string, now: number): OutcomeTrack {
  let t = tracks.get(key);
  if (!t) {
    t = {
      kBuf: new PriceHistoryBuffer(),
      pmBuf: new PriceHistoryBuffer(),
      roiWindow: [],
      lastTouched: now,
    };
    tracks.set(key, t);
  }
  t.lastTouched = now;
  return t;
}

function evictStale(now: number): void {
  if (now - lastEvictAt < 5 * 60 * 1000) return;
  lastEvictAt = now;
  for (const [k, t] of tracks) {
    if (now - t.lastTouched > EVICT_AFTER_MS) tracks.delete(k);
  }
}

/** Normalized variance of the ROI window → 0 (stable) … 1 (chaotic). */
function roiVariance(window: number[]): number | undefined {
  if (window.length < 5) return undefined; // not enough data — scorer goes neutral
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
  // ROI is in percentage points; std-dev of 2pp ≈ chaotic for an arb spread.
  const std = Math.sqrt(variance);
  return Math.min(1, std / 2);
}

export interface PersistenceContext {
  /** Stable identifier for the market pair (pairId / market id / URL). */
  marketKey: string;
  /** Historical avg arb-episode lifespan for this market, minutes. */
  avgLifespanMin?: number;
  /** Minutes until market expiry, when known. */
  minutesToExpiry?: number;
}

/**
 * Feed the latest compute results into the rolling buffers and attach a
 * persistence score to every non-stale result that has prices on both legs.
 * Mutates and returns the same array (cheap, called on every tick).
 */
export function attachPersistenceScores(
  results: LiveArbResult[],
  ctx: PersistenceContext,
  now: number = Date.now(),
): LiveArbResult[] {
  evictStale(now);
  for (const r of results) {
    if (r.stale) continue;
    const key = `${ctx.marketKey}:${r.artist}`;
    const t = getTrack(key, now);

    if (r.kalshiYesAsk != null) t.kBuf.add(r.kalshiYesAsk, now);
    if (r.pmYesAsk != null) t.pmBuf.add(r.pmYesAsk, now);
    t.roiWindow.push(r.roiPct);
    if (t.roiWindow.length > ROI_WINDOW) t.roiWindow.shift();

    if (r.kalshiYesAsk == null || r.pmYesAsk == null) continue;

    const kVel = calculateVelocity(t.kBuf.getPoints(), now);
    const pmVel = calculateVelocity(t.pmBuf.getPoints(), now);

    r.persistence = calculatePersistenceScore({
      kalshiAskDepth: Math.max(r.kalshiYesDepth, r.kalshiNoDepth),
      polymarketAskDepth: Math.max(r.pmYesDepth, r.pmNoDepth),
      kalshiPriceVelocity: kVel.magnitude,
      polymarketPriceVelocity: pmVel.magnitude,
      historicalAvgLifespanMin: ctx.avgLifespanMin,
      spreadVariance: roiVariance(t.roiWindow),
      minutesToExpiry: ctx.minutesToExpiry,
      kalshiDepth: Math.max(r.kalshiYesDepth, r.kalshiNoDepth),
      polymarketDepth: Math.max(r.pmYesDepth, r.pmNoDepth),
    });

    // HOOKUP-03 (FEAT-005): arb-formation signal. Current spread = best of the
    // two hedge combos (1 - cost of a guaranteed book); positive ≈ arb exists.
    const s1 = r.kalshiYesAsk != null && r.pmNoAsk != null ? 1 - (r.kalshiYesAsk + r.pmNoAsk) : -Infinity;
    const s2 = r.pmYesAsk != null && r.kalshiNoAsk != null ? 1 - (r.pmYesAsk + r.kalshiNoAsk) : -Infinity;
    const currentSpread = Math.max(s1, s2);
    if (Number.isFinite(currentSpread)) {
      // detectArbFormation's sign convention: spread widens when the FIRST
      // history's velocity exceeds the second's (spread ≈ 1 - pmYes - kNo,
      // where rising kYes ≈ falling kNo widens it). That matches combo s2
      // with (kalshi, pm) ordering. For combo s1 (buy K YES + PM NO) a
      // FALLING kYes widens the spread, so the histories must be swapped.
      const combo1 = s1 >= s2;
      const f = detectArbFormation(
        r.artist,
        combo1 ? t.pmBuf.getPoints() : t.kBuf.getPoints(),
        combo1 ? t.kBuf.getPoints() : t.pmBuf.getPoints(),
        currentSpread,
        ARB_SPREAD_THRESHOLD,
        now,
      );
      r.formation = {
        signal: f.signal,
        minutesToArb: f.minutesToArb,
        predictedSpread: f.predictedSpread,
        kalshiVelocity1min: kVel.velocity1min,
        pmVelocity1min: pmVel.velocity1min,
        isSpike: kVel.isSpike || pmVel.isSpike,
      };
    }
  }
  return results;
}

export type { PersistenceScore };
