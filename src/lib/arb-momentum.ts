export type MomentumDirection = 'widening' | 'narrowing' | 'stable';

export interface MomentumPoint {
  seenAt: string;
  roiPct: number;
}

export interface ArbMomentum {
  direction: MomentumDirection;
  deltaPct: number;
  windowSeconds: number;
  sampleCount: number;
}

/**
 * Derives a compact, noise-resistant momentum signal from the most recent
 * scan observations. ROI is the net executable spread proxy used throughout
 * the UI, so this works for every arbitrage strategy without strategy-specific
 * price math.
 */
export function calculateArbMomentum(
  points: MomentumPoint[],
  maxSamples = 5,
  significancePct = 0.1,
): ArbMomentum {
  const window = points.slice(-Math.max(1, maxSamples));
  if (window.length < 2) {
    return { direction: 'stable', deltaPct: 0, windowSeconds: 0, sampleCount: window.length };
  }

  const first = window[0];
  const last = window[window.length - 1];
  const deltaPct = last.roiPct - first.roiPct;
  const elapsed = new Date(last.seenAt).getTime() - new Date(first.seenAt).getTime();

  return {
    direction: deltaPct > significancePct
      ? 'widening'
      : deltaPct < -significancePct
        ? 'narrowing'
        : 'stable',
    deltaPct,
    windowSeconds: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed / 1000)) : 0,
    sampleCount: window.length,
  };
}
