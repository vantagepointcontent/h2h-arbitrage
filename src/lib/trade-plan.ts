export interface TradePlanInput {
  outcome: string;
  strategy: string;
  kalshiPrice: number;
  polymarketPrice: number;
  kalshiStake: number;
  polymarketStake: number;
  kalshiFee?: number;
  polymarketFee?: number;
  netProfit: number;
}

export interface TradePlan extends TradePlanInput {
  kalshiSide: "YES" | "NO";
  polymarketSide: "YES" | "NO";
  totalCapital: number;
  totalFees: number;
  netRoiPct: number;
}

export function buildTradePlan(input: TradePlanInput): TradePlan | null {
  const supported = input.strategy === "Buy YES Kalshi + NO PM" || input.strategy === "Buy YES PM + NO Kalshi";
  const numbers = [input.kalshiPrice, input.polymarketPrice, input.kalshiStake, input.polymarketStake, input.netProfit];
  if (!supported || numbers.some(value => !Number.isFinite(value)) || input.kalshiPrice <= 0 || input.kalshiPrice >= 1 || input.polymarketPrice <= 0 || input.polymarketPrice >= 1 || input.kalshiStake <= 0 || input.polymarketStake <= 0) return null;
  const totalCapital = input.kalshiStake + input.polymarketStake;
  return {
    ...input,
    kalshiSide: input.strategy === "Buy YES Kalshi + NO PM" ? "YES" : "NO",
    polymarketSide: input.strategy === "Buy YES Kalshi + NO PM" ? "NO" : "YES",
    totalCapital,
    totalFees: Math.max(0, input.kalshiFee ?? 0) + Math.max(0, input.polymarketFee ?? 0),
    netRoiPct: (input.netProfit / totalCapital) * 100,
  };
}
