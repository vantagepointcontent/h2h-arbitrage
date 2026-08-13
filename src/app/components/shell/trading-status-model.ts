export type RailTone = "positive" | "warning" | "critical" | "neutral";
export interface RailItem { id: string; label: string; value: string; tone: RailTone; detail: string; remediation?: string; }

export interface TradingStatusInput {
  now?: number;
  watcher?: { status?: string; lastTickAt?: string; kalshiConnected?: boolean; pmConnections?: string; error?: string } | null;
  execution?: { mode?: string; policy?: string; credentials?: { kalshi?: { ready?: boolean }; polymarket?: { ready?: boolean } } } | null;
  positions?: { positions?: unknown[]; errors?: Record<string, string | undefined> } | null;
  executions?: { executions?: Array<{ result?: { unhedged?: boolean; netExposure?: number; kalshiResult?: { status?: string }; polymarketResult?: { status?: string } } }> } | null;
  botAnalytics?: { analytics?: { openPositions?: { count?: number }; performance?: { capital?: { excludedOpenCostCents?: number }; valuation?: { stale?: number; unavailable?: number } } } } | null;
  failed?: string[];
}

export const FEED_LIVE_MS = 15_000;
export const FEED_STALE_MS = 60_000;

export function buildTradingStatus(input: TradingStatusInput): RailItem[] {
  const now = input.now ?? Date.now();
  const tick = input.watcher?.lastTickAt ? Date.parse(input.watcher.lastTickAt) : NaN;
  const ageMs = Number.isFinite(tick) ? Math.max(0, now - tick) : null;
  const watcherDown = !input.watcher || input.watcher.status === "down";
  const feed = watcherDown
    ? { value: "Disconnected", tone: "critical" as const }
    : ageMs == null || ageMs > FEED_STALE_MS
      ? { value: "Stale", tone: "critical" as const }
      : ageMs > FEED_LIVE_MS
        ? { value: "Polling", tone: "warning" as const }
        : { value: "Live", tone: "positive" as const };
  const age = ageMs == null ? "age unknown" : ageMs < 1_000 ? `${ageMs}ms old` : `${Math.round(ageMs / 1_000)}s old`;

  const pmParts = input.watcher?.pmConnections?.split("/").map(Number) ?? [];
  const pmConnected = pmParts.length === 2 && pmParts[1] > 0 && pmParts[0] === pmParts[1];
  const mode = input.execution?.mode ?? "unknown";
  const unhedged = (input.executions?.executions ?? []).filter((item) => item.result?.unhedged);
  const exposure = unhedged.reduce((sum, item) => sum + (item.result?.netExposure ?? 0), 0);
  const partial = (input.executions?.executions ?? []).filter((item) => [item.result?.kalshiResult?.status, item.result?.polymarketResult?.status].includes("partial")).length;
  const positions = input.positions?.positions?.length ?? 0;
  const positionErrors = Object.values(input.positions?.errors ?? {}).filter(Boolean);
  const botOpen = input.botAnalytics?.analytics?.openPositions?.count ?? 0;
  const unvalued = (input.botAnalytics?.analytics?.performance?.valuation?.stale ?? 0)
    + (input.botAnalytics?.analytics?.performance?.valuation?.unavailable ?? 0);
  const excludedCents = input.botAnalytics?.analytics?.performance?.capital?.excludedOpenCostCents ?? 0;
  const riskValue = unhedged.length
    ? `${unhedged.length} unhedged · $${exposure.toFixed(2)}`
    : partial
      ? `${partial} partial fill${partial === 1 ? "" : "s"}`
      : unvalued
        ? `${unvalued} unvalued · $${(excludedCents / 100).toFixed(2)}`
        : `${botOpen || positions} open · Hedged`;

  return [
    { id: "feed", label: "Price feed", value: `${feed.value} · ${age}`, tone: feed.tone, detail: `Freshness thresholds: Live ≤15s, Polling 16–60s, Stale >60s. Watcher: ${input.watcher?.status ?? "unavailable"}.`, remediation: feed.tone === "positive" ? undefined : "Check h2h-watcher and venue connections." },
    { id: "kalshi", label: "Kalshi", value: input.watcher?.kalshiConnected ? "Connected" : input.execution?.credentials?.kalshi?.ready ? "Delayed" : "Credentials unavailable", tone: input.watcher?.kalshiConnected ? "positive" : "critical", detail: input.watcher?.kalshiConnected ? "Watcher reports an active Kalshi feed." : "No verified live Kalshi feed.", remediation: "Check watcher logs and Kalshi credentials." },
    { id: "polymarket", label: "Polymarket", value: pmConnected ? "Connected" : input.execution?.credentials?.polymarket?.ready ? "Delayed" : "Credentials unavailable", tone: pmConnected ? "positive" : "critical", detail: `Watcher connections: ${input.watcher?.pmConnections ?? "unknown"}.`, remediation: "Check CLOB connectivity and Polymarket credentials." },
    { id: "execution", label: "Execution", value: mode === "paper" ? "Manual only · Dry run" : mode === "live-gated" ? "Manual only · Kill switch on" : mode === "live" ? "Manual only · Live gated action" : "Blocked", tone: mode === "paper" ? "neutral" : mode === "live-gated" ? "warning" : mode === "live" ? "warning" : "critical", detail: `Policy: ${input.execution?.policy ?? "manual-only"}. Automated execution is not enabled.`, remediation: mode === "unknown" ? "Execution status endpoint is unavailable; execution must remain blocked." : undefined },
    { id: "risk", label: "Portfolio risk", value: riskValue, tone: unhedged.length ? "critical" : partial || positionErrors.length || unvalued ? "warning" : "neutral", detail: `${botOpen || positions} open positions. ${unhedged.length} unhedged executions. ${partial} partial fills.${unvalued ? ` ${unvalued} lack fresh executable valuation; $${(excludedCents / 100).toFixed(2)} buy cost is excluded from valued totals.` : ""}${positionErrors.length ? ` Position sources degraded: ${positionErrors.join("; ")}` : ""}`, remediation: unhedged.length || partial ? "Inspect Trades and close or hedge affected legs manually." : unvalued ? "Open BotTrader Positions for each venue-specific valuation blocker." : positionErrors.length ? "Restore authenticated position feeds." : undefined },
  ];
}
