"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronRight, Clock3, ShieldCheck, X } from "lucide-react";
import { EmptyState, SegmentedControl, StatusBadge } from "@/components/ui";
import {
  filterOpportunities,
  type OpportunityFilter,
  type OpportunityViewModel,
} from "./opportunity-view-model";

const FILTERS: { value: OpportunityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "executable", label: "Executable" },
  { value: "durable", label: "Durable" },
  { value: "new", label: "New" },
  { value: "fading", label: "Fading" },
  { value: "thin", label: "Thin" },
  { value: "stale", label: "Stale" },
  { value: "needs-matching", label: "Needs matching" },
];

function ageLabel(ageMs: number | null): string {
  if (ageMs == null) return "Age unknown";
  if (ageMs < 60_000) return `${Math.max(0, Math.round(ageMs / 1000))}s old`;
  return `${Math.round(ageMs / 60_000)}m old`;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

interface Props {
  opportunities: OpportunityViewModel[];
  onPrepare?: (opportunity: OpportunityViewModel) => void;
}

export function OpportunityQueue({ opportunities, onPrepare }: Props) {
  const [filter, setFilter] = useState<OpportunityFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(opportunities[0]?.id ?? null);
  const filtered = useMemo(() => filterOpportunities(opportunities, filter), [filter, opportunities]);
  const selected = opportunities.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && opportunities.some((item) => item.id === selectedId)) return;
    setSelectedId(opportunities[0]?.id ?? null);
  }, [opportunities, selectedId]);

  return (
    <section className="border-b border-[var(--border)] bg-[var(--surface-panel)]" aria-label="Opportunity queue">
      <div className="border-b border-[var(--border)] px-3 py-3 sm:px-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Opportunity Queue</h3>
            <p className="text-[10px] text-[var(--text-secondary)]">Ranked by executable net value with stale, thin and blocked penalties.</p>
          </div>
          <StatusBadge tone="info">{filtered.length} visible</StatusBadge>
        </div>
        <div className="overflow-x-auto pb-1">
          <SegmentedControl
            value={filter}
            onChange={(value) => setFilter(value as OpportunityFilter)}
            options={FILTERS}
            ariaLabel="Opportunity view"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="p-4"><EmptyState title="No opportunities in this view" description="Choose another view or wait for the next live scan." /></div>
      ) : (
        <div className="grid min-h-[280px] lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="overflow-x-auto lg:border-r lg:border-[var(--border)]">
            <table className="w-full min-w-[860px] text-left text-[10px] tabular-nums">
              <thead className="sticky top-0 bg-[var(--surface-raised)] text-[var(--text-secondary)]">
                <tr>
                  {['Market / outcome', 'Strategy', 'Net profit', 'Net ROI', 'Capital', 'Max fill', 'Age', 'Persistence', 'Risk', ''].map((label) => (
                    <th key={label} title={({ 'Market / outcome':'The market event name and the specific outcome being compared', Strategy:'Which legs to buy across Kalshi and Polymarket', 'Net profit':'Expected profit after deducting trading fees from both platforms', 'Net ROI':'Return on investment as a percentage, net of fees', Capital:'Total dollar amount allocated across both legs', 'Max fill':'Maximum stake fillable at current orderbook depth', Age:'Time since this opportunity was first detected', Persistence:'How long this arb has been continuously observed', Risk:'Execution state: executable, blocked, stale, or thin', '':'Opportunity actions' } as Record<string,string>)[label]} className="px-3 py-2 font-medium">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--divider)]">
                {filtered.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={`cursor-pointer transition-colors hover:bg-[var(--surface-hover)] ${selectedId === item.id ? "bg-[var(--surface-selected)]" : ""}`}
                  >
                    <td className="max-w-52 px-3 py-2.5"><div className="truncate font-semibold text-[var(--text-primary)]">{item.outcome}</div><div className="truncate text-[var(--text-muted)]">{item.marketTitle}</div></td>
                    <td className="max-w-48 truncate px-3 py-2.5 text-[var(--text-secondary)]">{item.strategy}</td>
                    <td className="px-3 py-2.5 font-semibold text-[var(--status-positive)]">{money(item.netProfit)}</td>
                    <td className="px-3 py-2.5 font-semibold text-[var(--status-positive)]">{item.netRoiPct.toFixed(2)}%</td>
                    <td className="px-3 py-2.5 text-[var(--text-primary)]">{money(item.requiredCapital)}</td>
                    <td className="px-3 py-2.5 text-[var(--text-primary)]">{money(item.maxFillableStake)}</td>
                    <td className="px-3 py-2.5 text-[var(--text-secondary)]">{ageLabel(item.dataAgeMs)}</td>
                    <td className="px-3 py-2.5 capitalize text-[var(--text-secondary)]">{item.persistence}</td>
                    <td className="px-3 py-2.5"><StatusBadge tone={item.riskState === "executable" ? "positive" : item.riskState === "blocked" ? "blocked" : item.riskState === "stale" ? "stale" : "warning"}>{item.riskState}</StatusBadge></td>
                    <td className="px-3 py-2.5"><ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <aside className="border-t border-[var(--border)] bg-[var(--surface-raised)] p-4 lg:border-t-0" aria-label="Opportunity inspector">
            {selected ? (
              <>
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div><div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Inspector</div><h4 className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{selected.outcome}</h4></div>
                  <button onClick={() => setSelectedId(null)} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]" aria-label="Close inspector"><X className="h-4 w-4" /></button>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[10px] tabular-nums">
                  <div><dt className="text-[var(--text-muted)]">Net profit</dt><dd className="mt-0.5 font-semibold text-[var(--status-positive)]">{money(selected.netProfit)}</dd></div>
                  <div><dt className="text-[var(--text-muted)]">Net ROI</dt><dd className="mt-0.5 font-semibold text-[var(--status-positive)]">{selected.netRoiPct.toFixed(2)}%</dd></div>
                  <div><dt className="text-[var(--text-muted)]">Kalshi fee</dt><dd className="mt-0.5 text-[var(--text-primary)]">{money(selected.source.arbitrage.fees?.kalshiFee ?? 0)}</dd></div>
                  <div><dt className="text-[var(--text-muted)]">Polymarket fee</dt><dd className="mt-0.5 text-[var(--text-primary)]">{money(selected.source.arbitrage.fees?.pmFee ?? 0)}</dd></div>
                  <div><dt className="text-[var(--text-muted)]">Required capital</dt><dd className="mt-0.5 text-[var(--text-primary)]">{money(selected.requiredCapital)}</dd></div>
                  <div><dt className="text-[var(--text-muted)]">Max fillable</dt><dd className="mt-0.5 text-[var(--text-primary)]">{money(selected.maxFillableStake)}</dd></div>
                </dl>
                <div className="mt-4 border-t border-[var(--divider)] pt-3 text-[10px]">
                  <div className="mb-2 flex items-center gap-2 text-[var(--text-secondary)]"><Clock3 className="h-3.5 w-3.5" /> {ageLabel(selected.dataAgeMs)} · {selected.persistence} persistence</div>
                  <div className="flex items-start gap-2 text-[var(--text-secondary)]"><ShieldCheck className="mt-0.5 h-3.5 w-3.5" /><span>{selected.strategy}</span></div>
                  {selected.blockers.length > 0 && <div className="mt-3 space-y-1 text-[var(--status-warning)]">{selected.blockers.map((blocker) => <div key={blocker} className="flex items-center gap-2"><AlertTriangle className="h-3 w-3" />{blocker}</div>)}</div>}
                </div>
                <button
                  type="button"
                  disabled={selected.riskState === "blocked" || !onPrepare}
                  onClick={() => onPrepare?.(selected)}
                  className="mt-4 min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--status-warning)] transition-colors hover:bg-[var(--status-warning)]/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Prepare manual execution
                </button>
                <p className="mt-2 text-center text-[10px] text-[var(--text-muted)]">Preparation only. Execution still requires confirmation.</p>
              </>
            ) : <EmptyState title="Select an opportunity" description="Choose a queue row to inspect execution quality and fees." />}
          </aside>
        </div>
      )}
    </section>
  );
}
