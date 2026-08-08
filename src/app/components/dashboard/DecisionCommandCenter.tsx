"use client";
import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { buildAttentionQueue, summarizePortfolio, type AttentionItem } from "./decision-dashboard-model";

type Snapshot = { queue: AttentionItem[]; portfolio: ReturnType<typeof summarizePortfolio>; positionCount: number; error?: string };
const usd = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function DecisionCommandCenter() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/positions", { cache: "no-store" }).then(response => response.json()),
      fetch("/api/executions?limit=50", { cache: "no-store" }).then(response => response.json()),
    ]).then(([positionsResponse, executionsResponse]) => {
      if (!active) return;
      const positions = positionsResponse.positions ?? [];
      setSnapshot({ queue: buildAttentionQueue(positions, executionsResponse.executions ?? [], positionsResponse.errors ?? {}), portfolio: summarizePortfolio(positions), positionCount: positions.length });
    }).catch(error => active && setSnapshot({ queue: [], portfolio: summarizePortfolio([]), positionCount: 0, error: String(error) }));
    return () => { active = false; };
  }, []);
  if (!snapshot) return <section aria-label="Attention queue" className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4 text-xs text-[var(--text-secondary)]">Loading financial risk context…</section>;
  return <div className="space-y-4">
    <section aria-label="Attention queue" className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4">
      <div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-semibold"><ShieldAlert className="h-4 w-4 text-[var(--status-warning)]" /> Attention Queue</h3><span className="text-xs text-[var(--text-secondary)]">{snapshot.queue.length} active risks</span></div>
      {snapshot.error ? <p className="text-xs text-[var(--status-negative)]">Risk context unavailable: {snapshot.error}</p> : snapshot.queue.length === 0 ? <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]"><CheckCircle2 className="h-4 w-4 text-[var(--status-positive)]" /> No execution or position risk currently requires action.</div> : <div className="grid gap-2 lg:grid-cols-2">{snapshot.queue.slice(0, 8).map(item => <div key={item.id} className={`rounded-lg border px-3 py-2 ${item.severity === 3 ? "border-[var(--status-negative)]/30 bg-[var(--status-negative)]/5" : "border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5"}`}><div className="flex items-center gap-2 text-xs font-semibold"><AlertTriangle className={`h-3.5 w-3.5 ${item.severity === 3 ? "text-[var(--status-negative)]" : "text-[var(--status-warning)]"}`} />{item.title}</div><p className="mt-1 truncate text-xs text-[var(--text-secondary)]">{item.detail}</p></div>)}</div>}
    </section>
    <section aria-label="Portfolio state" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {[['Net open P&L',usd(snapshot.portfolio.netPnl)],['Capital deployed',usd(snapshot.portfolio.capitalDeployed)],['One-leg exposure',usd(snapshot.portfolio.netExposure)],['Fees paid + exit',usd(snapshot.portfolio.fees)],['Paired positions',`${snapshot.portfolio.paired} / ${snapshot.positionCount}`]].map(([label,value])=><div key={label} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3"><div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</div><div className="mt-1 text-sm font-semibold tabular-nums text-[var(--text-primary)]">{value}</div></div>)}
    </section>
  </div>;
}
