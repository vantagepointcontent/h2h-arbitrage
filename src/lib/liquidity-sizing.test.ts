import { describe, expect, it } from 'vitest';
import { analyzeLiquidity, LiquidityAnalysis } from './liquidity-sizing';

// Shared fee fixture (~0.8% combined)
const FEES = { kalshiFee: 0.005, pmFee: 0.003 };

describe('analyzeLiquidity', () => {
  /* ------------------------------------------------------------------ */
  /*  1. Deep liquidity on both sides                                    */
  /* ------------------------------------------------------------------ */
  it('deep liquidity → none warning, 0.5% slippage', () => {
    const result = analyzeLiquidity(
      0.40, // kalshiAskPrice
      50_000, // kalshiAskDepth
      0.60, // polymarketAskPrice
      60_000, // polymarketDepth
      0.55, // kalshiNoPrice
      0.50, // polymarketNoPrice
      FEES,
    );

    // Binding depth is min(50K, 60K) = 50K
    expect(result.maxFillableStake).toBe(50_000);
    expect(result.warningLevel).toBe('none');
    expect(result.isLiquid).toBe(true);
    expect(result.slippageEstimate).toBe(0.5);

    // spread = 1 - (0.40 + 0.50) = 0.10
    // totalFees = 0.008
    // theoreticalProfit = 50_000 × (0.10 - 0.008) = 4_600
    expect(result.theoreticalProfit).toBeCloseTo(4_600);
    // realisticProfit = 50_000 × (0.10 - 0.008 - 0.005) = 4_350
    expect(result.realisticProfit).toBeCloseTo(4_350);
    expect(result.realToTheoreticalRatio).toBeCloseTo(4_350 / 4_600, 4);
  });

  /* ------------------------------------------------------------------ */
  /*  2. Shallow Kalshi, infinite PM (typical case)                        */
  /* ------------------------------------------------------------------ */
  it('shallow Kalshi + infinite PM → low warning, 0.5% slippage', () => {
    const result = analyzeLiquidity(
      0.35,
      5_000,
      0.65,
      Infinity,
      0.60,
      0.55,
      FEES,
    );

    expect(result.maxFillableStake).toBe(5_000);
    expect(result.warningLevel).toBe('low');
    expect(result.isLiquid).toBe(true);
    // 5_000 >= 2_000 → 0.5% slippage tier
    expect(result.slippageEstimate).toBe(0.5);

    // spread = 1 - (0.35 + 0.55) = 0.10
    // theoretical = 5_000 × (0.10 - 0.008) = 460
    expect(result.theoreticalProfit).toBeCloseTo(460);
    // realistic = 5_000 × (0.10 - 0.008 - 0.005) = 435
    expect(result.realisticProfit).toBeCloseTo(435);
  });

  /* ------------------------------------------------------------------ */
  /*  3. Very shallow Kalshi (< $100)                                      */
  /* ------------------------------------------------------------------ */
  it('very shallow Kalshi → critical warning, 2% slippage, not liquid', () => {
    const result = analyzeLiquidity(
      0.45,
      50,
      0.55,
      Infinity,
      0.50,
      0.48,
      FEES,
    );

    expect(result.maxFillableStake).toBe(50);
    expect(result.warningLevel).toBe('critical');
    expect(result.isLiquid).toBe(false);
    expect(result.slippageEstimate).toBe(2);

    // spread = 1 - (0.45 + 0.48) = 0.07
    // theoretical = 50 × (0.07 - 0.008) = 3.1
    expect(result.theoreticalProfit).toBeCloseTo(3.1);
    // realistic = 50 × (0.07 - 0.008 - 0.02) = 2.1
    expect(result.realisticProfit).toBeCloseTo(2.1);
  });

  /* ------------------------------------------------------------------ */
  /*  4. Zero depth (edge case)                                           */
  /* ------------------------------------------------------------------ */
  it('zero depth → zero profits, critical', () => {
    const result = analyzeLiquidity(
      0.40,
      0,
      0.60,
      Infinity,
      0.55,
      0.50,
      FEES,
    );

    expect(result.maxFillableStake).toBe(0);
    expect(result.warningLevel).toBe('critical');
    expect(result.isLiquid).toBe(false);
    expect(result.slippageEstimate).toBe(2);
    expect(result.theoreticalProfit).toBe(0);
    expect(result.realisticProfit).toBe(0);
    // Both zero → ratio clamped to 0
    expect(result.realToTheoreticalRatio).toBe(0);
  });

  /* ------------------------------------------------------------------ */
  /*  5. High spread with low depth                                        */
  /* ------------------------------------------------------------------ */
  it('high spread with low depth → profitable despite tight liquidity', () => {
    const result = analyzeLiquidity(
      0.30, // kalshiAskPrice
      1_500, // kalshiAskDepth
      0.70, // polymarketAskPrice
      Infinity,
      0.50, // kalshiNoPrice
      0.55, // polymarketNoPrice
      FEES,
    );

    expect(result.maxFillableStake).toBe(1_500);
    expect(result.warningLevel).toBe('low');
    expect(result.isLiquid).toBe(true);
    // 1_500 < 2_000 → 1% slippage tier
    expect(result.slippageEstimate).toBe(1);

    // spread = 1 - (0.30 + 0.55) = 0.15
    // theoretical = 1_500 × (0.15 - 0.008) = 213
    expect(result.theoreticalProfit).toBeCloseTo(213);
    // realistic = 1_500 × (0.15 - 0.008 - 0.01) = 198
    expect(result.realisticProfit).toBeCloseTo(198);
    expect(result.realToTheoreticalRatio).toBeCloseTo(198 / 213, 4);
  });

  /* ------------------------------------------------------------------ */
  /*  6. Negative realistic profit (slippage exceeds spread)             */
  /* ------------------------------------------------------------------ */
  it('negative realistic profit → ratio clamped to 0', () => {
    // Tiny spread, heavy slippage
    const result = analyzeLiquidity(
      0.49,
      200,
      0.51,
      Infinity,
      0.50,
      0.49,
      { kalshiFee: 0.01, pmFee: 0.005 }, // higher fees
    );

    // spread = 1 - (0.49 + 0.49) = 0.02
    // totalFees = 0.015, slippage = 2% → 0.02
    // realistic = 200 × (0.02 - 0.015 - 0.02) = -3 (approx)
    expect(result.realisticProfit).toBeLessThan(0);
    expect(result.realToTheoreticalRatio).toBe(0);
  });

  /* ------------------------------------------------------------------ */
  /*  7. Polymarket is the binding constraint                            */
  /* ------------------------------------------------------------------ */
  it('PM shallower than Kalshi → PM binds', () => {
    const result = analyzeLiquidity(
      0.40,
      20_000, // Kalshi deeper
      0.60,
      8_000,  // PM shallower
      0.55,
      0.50,
      FEES,
    );

    expect(result.maxFillableStake).toBe(8_000);
    expect(result.polymarketDepth).toBe(8_000);
    expect(result.kalshiDepth).toBe(20_000);
    expect(result.warningLevel).toBe('low');
  });
});
