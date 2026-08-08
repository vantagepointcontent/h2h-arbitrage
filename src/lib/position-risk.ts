export type PositionRiskInput = {
  kalshi: { currentValue: number; exitFees: number } | null;
  polymarket: { currentValue: number; exitFees: number; endDate?: string | null } | null;
  breakdown: { totalNetPnl: number };
};

export type PositionRiskSummary = {
  pairedState: "paired" | "unpaired";
  expiry: string | null;
  netExitValue: number;
  oneLegExposure: number;
  exitLiquidityRisk: "unverified";
  attentionReasons: string[];
};

/** Conservative decision fields. Depth is not available from account-position feeds,
 * so exit liquidity is explicitly unverified rather than implied safe. */
export function derivePositionRisk(position: PositionRiskInput, now = Date.now()): PositionRiskSummary {
  const paired = Boolean(position.kalshi && position.polymarket);
  const expiry = position.polymarket?.endDate || null;
  const grossExitValue = (position.kalshi?.currentValue ?? 0) + (position.polymarket?.currentValue ?? 0);
  const exitFees = (position.kalshi?.exitFees ?? 0) + (position.polymarket?.exitFees ?? 0);
  const values = [position.kalshi?.currentValue ?? 0, position.polymarket?.currentValue ?? 0];
  const attentionReasons: string[] = [];
  if (!paired) attentionReasons.push("One-legged position");
  if (position.breakdown.totalNetPnl < 0) attentionReasons.push("Negative net P&L after exit fees");
  if (expiry) {
    const remaining = new Date(expiry).getTime() - now;
    if (Number.isFinite(remaining) && remaining > 0 && remaining <= 24 * 60 * 60 * 1000) attentionReasons.push("Expires within 24 hours");
  }
  attentionReasons.push("Exit depth unverified");
  return {
    pairedState: paired ? "paired" : "unpaired",
    expiry,
    netExitValue: grossExitValue - exitFees,
    oneLegExposure: paired ? Math.max(...values) : grossExitValue,
    exitLiquidityRisk: "unverified",
    attentionReasons,
  };
}
