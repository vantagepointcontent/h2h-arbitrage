export interface MarketDecisionMetrics { bestNetRoi: number | null; bestNetProfit: number | null; maxExecutableStake: number | null; }

export function selectMarketDecisionMetrics(outcomes: Array<Record<string, any>> = []): MarketDecisionMetrics {
  const arbs = outcomes.map((outcome) => outcome?.arbitrage).filter(Boolean);
  if (!arbs.length) return { bestNetRoi: null, bestNetProfit: null, maxExecutableStake: null };
  const netProfit = (arb: any) => Number(arb?.fees?.worstCaseNetProfit ?? arb?.expectedProfit ?? 0);
  const executable = arbs.filter((arb) => netProfit(arb) > 0 && Number(arb?.roiPct ?? 0) > 0);
  const source = executable.length ? executable : arbs;
  return {
    bestNetRoi: Math.max(...source.map((arb) => Number(arb.roiPct ?? 0))),
    bestNetProfit: Math.max(...source.map(netProfit)),
    maxExecutableStake: Math.max(...source.map((arb) => Number(arb.maxFillableStake ?? arb.maxCapital ?? arb.totalStake ?? ((arb.kalshiStake ?? 0) + (arb.pmStake ?? 0)) ?? 0))),
  };
}
