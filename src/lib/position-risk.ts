export type PositionRiskInput = {
  kalshi: { currentValue: number; exitFees: number | null } | null;
  polymarket: { currentValue: number; exitFees: number | null; endDate?: string | null } | null;
  breakdown: { totalNetPnl: number | null };
};

export type PositionRiskSummary = {
  pairedState: "paired" | "unpaired";
  expiry: string | null;
  netExitValue: number | null;
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
  const feeValues = [position.kalshi?.exitFees, position.polymarket?.exitFees]
    .filter((value) => value !== undefined);
  const feesAvailable = feeValues.every((value) => value !== null);
  const exitFees = feesAvailable ? feeValues.reduce<number>((sum, value) => sum + Number(value), 0) : null;
  const values = [position.kalshi?.currentValue ?? 0, position.polymarket?.currentValue ?? 0];
  const attentionReasons: string[] = [];
  if (!paired) attentionReasons.push("One-legged position");
  if (position.breakdown.totalNetPnl != null && position.breakdown.totalNetPnl < 0) attentionReasons.push("Negative net P&L after exit fees");
  if (position.breakdown.totalNetPnl == null) attentionReasons.push("Net P&L unavailable");
  if (expiry) {
    const remaining = new Date(expiry).getTime() - now;
    if (Number.isFinite(remaining) && remaining > 0 && remaining <= 24 * 60 * 60 * 1000) attentionReasons.push("Expires within 24 hours");
  }
  attentionReasons.push("Exit depth unverified");
  return {
    pairedState: paired ? "paired" : "unpaired",
    expiry,
    netExitValue: exitFees == null ? null : grossExitValue - exitFees,
    oneLegExposure: paired ? Math.max(...values) : grossExitValue,
    exitLiquidityRisk: "unverified",
    attentionReasons,
  };
}
