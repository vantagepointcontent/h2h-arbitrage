export type AttentionItem = { id: string; severity: 1 | 2 | 3; title: string; detail: string; category: "execution" | "position" | "platform" };

type Position = { id: string; marketTitle: string; pairedState?: string; attentionReasons?: string[]; breakdown?: { totalNetPnl?: number; totalFees?: number }; totalCost?: number; oneLegExposure?: number };
type Execution = { id?: number; arbId?: string; marketTitle?: string; timestamp?: string; success?: boolean; result?: { unhedged?: boolean; rollbackExecuted?: boolean; netExposure?: number; kalshiResult?: unknown; polymarketResult?: unknown } | null };

export function buildAttentionQueue(positions: Position[], executions: Execution[], errors: Record<string, string | null | undefined>): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const [venue, detail] of Object.entries(errors)) if (detail) items.push({ id: `platform-${venue}`, severity: 2, category: "platform", title: `${venue} position feed unavailable`, detail });
  for (const execution of executions) {
    const result = execution.result ?? {};
    if (result.unhedged) items.push({ id: `execution-${execution.id ?? execution.arbId}-unhedged`, severity: 3, category: "execution", title: "Unhedged execution", detail: execution.marketTitle ?? "Unknown market" });
    else if (execution.success === false) items.push({ id: `execution-${execution.id ?? execution.arbId}-failed`, severity: 3, category: "execution", title: result.rollbackExecuted ? "Execution failed; rollback attempted" : "Execution failed without confirmed rollback", detail: execution.marketTitle ?? "Unknown market" });
    else if (Boolean(result.kalshiResult) !== Boolean(result.polymarketResult)) items.push({ id: `execution-${execution.id ?? execution.arbId}-partial`, severity: 3, category: "execution", title: "Partial fill risk", detail: execution.marketTitle ?? "Unknown market" });
  }
  for (const position of positions) {
    for (const reason of position.attentionReasons ?? []) {
      if (reason === "Exit depth unverified") continue;
      items.push({ id: `position-${position.id}-${reason}`, severity: reason.includes("One-legged") ? 3 : 2, category: "position", title: reason, detail: position.marketTitle });
    }
  }
  return items.sort((a, b) => b.severity - a.severity || a.title.localeCompare(b.title));
}

export function summarizePortfolio(positions: Position[]) {
  return positions.reduce((summary, position) => ({
    netPnl: summary.netPnl + (position.breakdown?.totalNetPnl ?? 0),
    fees: summary.fees + (position.breakdown?.totalFees ?? 0),
    capitalDeployed: summary.capitalDeployed + (position.totalCost ?? 0),
    netExposure: summary.netExposure + (position.oneLegExposure ?? 0),
    paired: summary.paired + (position.pairedState === "paired" ? 1 : 0),
  }), { netPnl: 0, fees: 0, capitalDeployed: 0, netExposure: 0, paired: 0 });
}
