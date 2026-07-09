'use client';

import React from 'react';

/**
 * UI-14: Cross-arb leg breakdown — shared helpers + LegBreakdown component.
 *
 * Parses the strategy string from matcher.ts / live-arb-engine.ts into
 * structured leg data so the UI can show exactly what to buy on which platform.
 *
 * Strategy formats:
 *   "Buy YES Kalshi + NO PM"                    → regular, K-YES + PM-NO (same outcome)
 *   "Buy YES PM + NO Kalshi"                    → regular, PM-YES + K-NO (same outcome)
 *   "Buy YES both sides: Kalshi <A> + Polymarket <B>" → cross-outcome, K-YES(A) + PM-YES(B)  (matcher.ts)
 *   "Buy YES both sides: Kalshi <A> + PM <B>"   → cross-outcome, K-YES(A) + PM-YES(B)  (live-arb-engine.ts)
 *   "No arb"                                    → no legs
 */

export interface ArbLeg {
  platform: 'Kalshi' | 'Polymarket';
  side: 'YES' | 'NO';
  outcome: string;
  price: number | null;
  stake: number | null;
}

export interface ArbLegBreakdown {
  isCross: boolean;
  legs: ArbLeg[];
  totalCost: number | null;
  grossProfit: number | null;
  fees: number | null;
  netProfit: number | null;
}

/**
 * Parse a strategy string + outcome price data into structured legs.
 *
 * For regular arbs, the outcome name is the row's artist (same outcome both sides).
 * For cross arbs, the strategy string contains both outcome names.
 */
export function parseArbLegs(
  strategy: string,
  artist: string,
  kalshiYesAsk: number | null | undefined,
  kalshiNoAsk: number | null | undefined,
  pmYesPrice: number | null | undefined,
  pmNoPrice: number | null | undefined,
  kalshiStake: number | null | undefined,
  pmStake: number | null | undefined,
  fees?: { kalshiFee: number; pmFee: number; worstCaseNetProfit: number } | null,
  expectedProfit?: number | null,
): ArbLegBreakdown {
  if (!strategy || strategy === 'No arb') {
    return { isCross: false, legs: [], totalCost: null, grossProfit: null, fees: null, netProfit: null };
  }

  // Cross-outcome: "Buy YES both sides: Kalshi <A> + Polymarket <B>" (matcher.ts)
  //             or: "Buy YES both sides: Kalshi <A> + PM <B>" (live-arb-engine.ts)
  const crossMatch = strategy.match(/^Buy YES both sides: Kalshi (.+?) \+ (?:Polymarket|PM) (.+)$/);
  if (crossMatch) {
    const [, kalshiOutcome, pmOutcome] = crossMatch;
    const kPrice = kalshiYesAsk ?? null;
    const pPrice = pmYesPrice ?? null;
    const legs: ArbLeg[] = [
      { platform: 'Kalshi', side: 'YES', outcome: kalshiOutcome, price: kPrice, stake: kalshiStake ?? null },
      { platform: 'Polymarket', side: 'YES', outcome: pmOutcome, price: pPrice, stake: pmStake ?? null },
    ];
    const totalCost = (kPrice != null && pPrice != null) ? kPrice + pPrice : null;
    const grossProfit = totalCost != null ? 1 - totalCost : null;
    const totalFees = fees ? fees.kalshiFee + fees.pmFee : null;
    const netProfit = expectedProfit ?? fees?.worstCaseNetProfit ?? null;
    return { isCross: true, legs, totalCost, grossProfit, fees: totalFees, netProfit };
  }

  // Regular: "Buy YES Kalshi + NO PM"
  if (strategy === 'Buy YES Kalshi + NO PM') {
    const kPrice = kalshiYesAsk ?? null;
    const pPrice = pmNoPrice ?? null;
    const legs: ArbLeg[] = [
      { platform: 'Kalshi', side: 'YES', outcome: artist, price: kPrice, stake: kalshiStake ?? null },
      { platform: 'Polymarket', side: 'NO', outcome: artist, price: pPrice, stake: pmStake ?? null },
    ];
    const totalCost = (kPrice != null && pPrice != null) ? kPrice + pPrice : null;
    const grossProfit = totalCost != null ? 1 - totalCost : null;
    const totalFees = fees ? fees.kalshiFee + fees.pmFee : null;
    const netProfit = expectedProfit ?? fees?.worstCaseNetProfit ?? null;
    return { isCross: false, legs, totalCost, grossProfit, fees: totalFees, netProfit };
  }

  // Regular: "Buy YES PM + NO Kalshi"
  if (strategy === 'Buy YES PM + NO Kalshi') {
    const pPrice = pmYesPrice ?? null;
    const kPrice = kalshiNoAsk ?? null;
    const legs: ArbLeg[] = [
      { platform: 'Polymarket', side: 'YES', outcome: artist, price: pPrice, stake: pmStake ?? null },
      { platform: 'Kalshi', side: 'NO', outcome: artist, price: kPrice, stake: kalshiStake ?? null },
    ];
    const totalCost = (kPrice != null && pPrice != null) ? kPrice + pPrice : null;
    const grossProfit = totalCost != null ? 1 - totalCost : null;
    const totalFees = fees ? fees.kalshiFee + fees.pmFee : null;
    const netProfit = expectedProfit ?? fees?.worstCaseNetProfit ?? null;
    return { isCross: false, legs, totalCost, grossProfit, fees: totalFees, netProfit };
  }

  // Same-platform YES+YES: "Same-platform YES+YES Kalshi: <A> + <B>"
  //                         "Same-platform YES+YES Polymarket: <A> + <B>"
  const samePlatformMatch = strategy.match(/^Same-platform YES\+YES (Kalshi|Polymarket): (.+?) \+ (.+)$/);
  if (samePlatformMatch) {
    const [, platform, outcomeA, outcomeB] = samePlatformMatch;
    const plat = platform as 'Kalshi' | 'Polymarket';
    const priceA = plat === 'Kalshi' ? kalshiYesAsk : pmYesPrice;
    const priceB = plat === 'Kalshi' ? kalshiYesAsk : pmYesPrice; // complement price — not available from current row
    const stakeA = plat === 'Kalshi' ? kalshiStake : pmStake;
    const stakeB = null; // complement stake not available from single outcome
    const legs: ArbLeg[] = [
      { platform: plat, side: 'YES', outcome: outcomeA, price: priceA ?? null, stake: stakeA ?? null },
      { platform: plat, side: 'YES', outcome: outcomeB, price: priceB ?? null, stake: stakeB },
    ];
    const totalCost = (priceA != null && priceB != null) ? priceA + priceB : null;
    const grossProfit = totalCost != null ? 1 - totalCost : null;
    const totalFees = fees ? fees.kalshiFee + fees.pmFee : null;
    const netProfit = expectedProfit ?? fees?.worstCaseNetProfit ?? null;
    return { isCross: false, legs, totalCost, grossProfit, fees: totalFees, netProfit };
  }

  // Unknown strategy format
  return { isCross: false, legs: [], totalCost: null, grossProfit: null, fees: null, netProfit: null };
}

/**
 * Format the strategy string into a concise, unambiguous label.
 *
 * "Buy YES Kalshi + NO PM"                  → "K-YES · PM-NO"
 * "Buy YES PM + NO Kalshi"                  → "PM-YES · K-NO"
 * "Buy YES both sides: Kalshi Dem + PM Rep" → "Cross: K-YES(Dem) + PM-YES(Rep)"
 * "Buy YES both sides: Kalshi Dem + Polymarket Rep" → same (matcher.ts variant)
 * "No arb"                                  → "No arb"
 */
export function formatConciseStrategy(strategy: string): { text: string; isCross: boolean } {
  if (!strategy || strategy === 'No arb') return { text: 'No arb', isCross: false };

  const crossMatch = strategy.match(/^Buy YES both sides: Kalshi (.+?) \+ (?:Polymarket|PM) (.+)$/);
  if (crossMatch) {
    return {
      text: `Cross: K-YES(${crossMatch[1]}) + PM-YES(${crossMatch[2]})`,
      isCross: true,
    };
  }

  if (strategy === 'Buy YES Kalshi + NO PM') return { text: 'K-YES · PM-NO', isCross: false };
  if (strategy === 'Buy YES PM + NO Kalshi') return { text: 'PM-YES · K-NO', isCross: false };

  const samePlatformMatch = strategy.match(/^Same-platform YES\+YES (Kalshi|Polymarket): (.+?) \+ (.+)$/);
  if (samePlatformMatch) {
    const [, platform, a, b] = samePlatformMatch;
    const prefix = platform === 'Kalshi' ? 'K' : 'PM';
    return { text: `Same: ${prefix}-YES(${a}) + ${prefix}-YES(${b})`, isCross: false };
  }

  return { text: strategy, isCross: false };
}

// ─── Component ───────────────────────────────────────────────────────────

interface LegBreakdownProps {
  breakdown: ArbLegBreakdown;
  formatCurrency: (n: number) => string;
}

function PlatformIcon({ platform }: { platform: 'Kalshi' | 'Polymarket' }) {
  return (
    <img
      src={platform === 'Kalshi' ? '/kalshi-icon.png' : '/polymarket-icon.png'}
      alt={platform}
      className="w-3.5 h-3.5 rounded-sm inline-block"
    />
  );
}

/**
 * Renders a structured leg breakdown for a single arb.
 * Shows each leg (platform, side, outcome, price, stake) + total cost / profit summary.
 */
export function LegBreakdown({ breakdown, formatCurrency }: LegBreakdownProps) {
  if (breakdown.legs.length === 0) return null;

  const { isCross, legs, totalCost, grossProfit, fees, netProfit } = breakdown;

  return (
    <div className={`mt-3 rounded-lg border p-3 ${isCross ? 'border-[#ef4444]/30 bg-[#ef4444]/5' : 'border-[#facc15]/20 bg-[#facc15]/5'}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-[10px] font-bold uppercase tracking-wider ${isCross ? 'text-[#ef4444]' : 'text-[#facc15]'}`}>
          {isCross ? 'Cross-Outcome Arb' : 'Arb Legs'}
        </span>
        {isCross && (
          <span className="text-[9px] text-[#8A9BA8]">Buy YES on both platforms — one must resolve YES</span>
        )}
      </div>

      {/* Legs */}
      <div className="space-y-1.5">
        {legs.map((leg, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="text-[#8A9BA8] font-medium w-10">Leg {i + 1}</span>
            <PlatformIcon platform={leg.platform} />
            <span className="text-[#FFFFFF] font-medium">Buy {leg.side}</span>
            <span className="text-[#8A9BA8]">on {leg.platform}</span>
            <span className="text-[#FFFFFF]">— &ldquo;{leg.outcome}&rdquo;</span>
            <span className="text-[#8A9BA8]">@</span>
            <span className="text-[#FFFFFF] font-mono font-bold">${leg.price != null ? leg.price.toFixed(2) : '—'}</span>
            {leg.stake != null && leg.stake > 0 && (
              <span className="text-[#8A9BA8] text-[10px] ml-auto">stake: {formatCurrency(leg.stake)}</span>
            )}
          </div>
        ))}
      </div>

      {/* Summary */}
      <div className="mt-3 pt-2 border-t border-[#232E3C] flex items-center gap-4 text-[11px]">
        {totalCost != null && (
          <div className="flex items-center gap-1.5">
            <span className="text-[#8A9BA8]">Total Cost:</span>
            <span className="text-[#FFFFFF] font-mono font-bold">${totalCost.toFixed(2)}</span>
          </div>
        )}
        {grossProfit != null && (
          <div className="flex items-center gap-1.5">
            <span className="text-[#8A9BA8]">Gross:</span>
            <span className="text-[#FFFFFF] font-mono">${(1 - totalCost!).toFixed(2)}</span>
          </div>
        )}
        {fees != null && (
          <div className="flex items-center gap-1.5">
            <span className="text-[#8A9BA8]">Fees:</span>
            <span className="text-[#ef4444] font-mono">-${fees.toFixed(2)}</span>
          </div>
        )}
        {netProfit != null && (
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-[#8A9BA8]">Net Profit:</span>
            <span className={`font-mono font-bold ${netProfit > 0 ? 'text-[#5DBE81]' : 'text-[#ef4444]'}`}>
              {formatCurrency(netProfit)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}