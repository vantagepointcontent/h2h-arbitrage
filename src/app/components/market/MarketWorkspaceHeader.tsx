"use client";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ExternalLink, Heart, Link2, Loader2, MoreHorizontal, Pencil, RefreshCw, Scan, Trash2 } from "lucide-react";
import { selectMarketDecisionMetrics } from "./market-decision-metrics";

export type MarketWorkspaceTab = "opportunities" | "prices" | "depth" | "history" | "matching" | "couplings" | "live";
interface Props {
  market: { id: string; eventTitle?: string; title?: string; category?: string; expiryDate?: string; kalshiUrl: string; polymarketUrl: string };
  outcomes: Array<Record<string, any>>;
  scannedAt?: string | null;
  loading: boolean;
  refreshing: boolean;
  favorite: boolean;
  copied: boolean;
  activeTab: MarketWorkspaceTab;
  onTabChange: (tab: MarketWorkspaceTab) => void;
  onFavorite: () => void;
  onRefresh: () => void;
  onInspect: () => void;
  onRescan: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onCouplings: () => void;
  onDelete: () => void;
}
const tabs: Array<[MarketWorkspaceTab, string]> = [["opportunities","Opportunities"],["prices","Market prices"],["depth","Depth"],["history","History"],["matching","Matching"],["couplings","Couplings"],["live","Live WS"]];
const metricTooltips: Record<string, string> = {
  'Best net ROI': 'Highest net ROI % across all matched outcomes, after deducting trading fees from both platforms',
  'Best net profit': 'Highest expected dollar profit across all matched outcomes, net of fees',
  'Max executable': 'Maximum dollar stake that can be filled given current orderbook depth on both platforms',
  'Data age': 'Seconds since the last price refresh for this market',
};
const usd = (n: number | null) => n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);

export function MarketWorkspaceHeader(props: Props) {
  const [menu, setMenu] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const menuRef = useRef<HTMLDivElement>(null);
  const metrics = selectMarketDecisionMetrics(props.outcomes);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(id); }, []);
  useEffect(() => { const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); }; document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close); }, []);
  const scanMs = props.scannedAt ? Date.parse(props.scannedAt) : NaN;
  const age = Number.isFinite(scanMs) ? `${Math.max(0, Math.round((now - scanMs) / 1000))}s` : "—";
  const title = props.market.eventTitle || props.market.title || "Selected market";
  return <section aria-label="Active market workspace" className="rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
    <div className="flex flex-col gap-3 p-3 lg:flex-row lg:items-center lg:p-4">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <button onClick={props.onFavorite} aria-label={props.favorite ? "Remove market from favorites" : "Add market to favorites"} className="mt-0.5 rounded p-1 text-[var(--text-muted)] hover:text-[var(--status-warning)]"><Heart className={`h-4 w-4 ${props.favorite ? "fill-[var(--status-warning)] text-[var(--status-warning)]" : ""}`} /></button>
        <div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate text-sm font-bold text-[var(--text-primary)]">{title}</h2>{props.market.category && <span className="rounded-full bg-[var(--surface-raised)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]">{props.market.category}</span>}</div>
          <div className="mt-1 flex items-center gap-3 text-[10px] text-[var(--text-muted)]"><span>Expires {props.market.expiryDate ? new Date(props.market.expiryDate).toLocaleDateString() : "—"}</span><a href={props.market.kalshiUrl} target="_blank" rel="noreferrer" className="hover:text-[var(--text-primary)]">Kalshi <ExternalLink className="inline h-3 w-3" /></a><a href={props.market.polymarketUrl} target="_blank" rel="noreferrer" className="hover:text-[var(--text-primary)]">Polymarket <ExternalLink className="inline h-3 w-3" /></a></div>
        </div>
        <button onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-label="Toggle market summary" className="ml-auto rounded p-1 text-[var(--text-muted)] lg:hidden"><ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} /></button>
      </div>
      <div className={`${expanded ? "grid" : "hidden"} grid-cols-2 gap-1.5 lg:grid lg:grid-cols-4`}>
        {[['Best net ROI', metrics.bestNetRoi == null ? '—' : `${metrics.bestNetRoi.toFixed(2)}%`],['Best net profit',usd(metrics.bestNetProfit)],['Max executable',usd(metrics.maxExecutableStake)],['Data age',age]].map(([label,value]) => <div key={label} title={metricTooltips[label]} className="min-w-[112px] rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2.5 py-1.5"><div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div><div className="mt-0.5 text-xs font-bold tabular-nums text-[var(--text-primary)]">{value}</div></div>)}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={props.onRefresh} disabled={props.loading} className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--status-positive)] px-3 text-xs font-bold text-black disabled:opacity-50 lg:flex-none">{props.loading || props.refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin"/>:<RefreshCw className="h-3.5 w-3.5"/>} Refresh prices</button>
        <button onClick={props.onInspect} className="min-h-10 flex-1 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-hover)] lg:flex-none">Inspect opportunities</button>
        <div className="relative" ref={menuRef}><button onClick={() => setMenu(v=>!v)} aria-haspopup="menu" aria-expanded={menu} aria-label="More market actions" className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"><MoreHorizontal className="h-4 w-4"/></button>{menu && <div role="menu" className="absolute right-0 top-11 z-40 w-52 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-panel)] p-1.5 shadow-xl">{[[Scan,'Full rescan',props.onRescan],[Pencil,'Edit metadata',props.onEdit],[props.copied?Check:Link2,props.copied?'URLs copied':'Copy URLs',props.onCopy]].map(([Icon,label,action]:any)=><button key={label} role="menuitem" onClick={()=>{action();setMenu(false)}} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"><Icon className="h-3.5 w-3.5"/>{label}</button>)}<div className="my-1 border-t border-[var(--border-subtle)]"/><button role="menuitem" onClick={()=>{props.onDelete();setMenu(false)}} className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-xs text-[var(--status-negative)] hover:bg-[var(--status-negative)]/10"><Trash2 className="h-3.5 w-3.5"/>Delete market</button></div>}</div>
      </div>
    </div>
    <nav aria-label="Market workspace sections" role="tablist" className="flex overflow-x-auto border-t border-[var(--border-subtle)] px-3">{tabs.map(([id,label])=><button key={id} role="tab" aria-selected={props.activeTab===id} onClick={()=>id === "couplings" ? props.onCouplings() : props.onTabChange(id)} className={`min-h-10 shrink-0 border-b-2 px-3 text-xs font-semibold ${props.activeTab===id?'border-[var(--status-positive)] text-[var(--text-primary)]':'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>{label}</button>)}</nav>
  </section>;
}
