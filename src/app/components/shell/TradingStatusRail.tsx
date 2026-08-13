"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CircleDollarSign, Radio, Shield, X } from "lucide-react";
import { buildTradingStatus, type RailItem } from "./trading-status-model";

const ICONS = { feed: Radio, kalshi: Activity, polymarket: Activity, execution: Shield, risk: CircleDollarSign };
const TONES = {
  positive: "bg-[var(--status-positive)]",
  warning: "bg-[var(--status-warning)]",
  critical: "bg-[var(--status-negative)]",
  neutral: "bg-[var(--text-muted)]",
};

async function readJson(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

export function TradingStatusRail() {
  const [payload, setPayload] = useState<Record<string, unknown>>({});
  const [failed, setFailed] = useState<string[]>(["loading"]);
  const [selected, setSelected] = useState<RailItem | null>(null);
  const [clock, setClock] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const requests = [
        ["watcher", "/api/watcher/health"],
        ["execution", "/api/execute"],
        ["positions", "/api/positions"],
        ["executions", "/api/executions?limit=200"],
        ["botAnalytics", "/api/bot-trader/analytics?method=all&mode=paper&range=all"],
      ] as const;
      const settled = await Promise.allSettled(requests.map(([, url]) => readJson(url)));
      if (cancelled) return;
      const next: Record<string, unknown> = {};
      const errors: string[] = [];
      settled.forEach((result, index) => {
        const key = requests[index][0];
        if (result.status === "fulfilled") next[key] = result.value;
        else errors.push(key);
      });
      setPayload(next);
      setFailed(errors);
      setClock(Date.now());
    };
    void poll();
    const pollId = window.setInterval(poll, 30_000);
    const clockId = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => { cancelled = true; clearInterval(pollId); clearInterval(clockId); };
  }, []);

  const items = useMemo(() => buildTradingStatus({
    now: clock,
    watcher: payload.watcher as Parameters<typeof buildTradingStatus>[0]["watcher"],
    execution: payload.execution as Parameters<typeof buildTradingStatus>[0]["execution"],
    positions: payload.positions as Parameters<typeof buildTradingStatus>[0]["positions"],
    executions: payload.executions as Parameters<typeof buildTradingStatus>[0]["executions"],
    botAnalytics: payload.botAnalytics as Parameters<typeof buildTradingStatus>[0]["botAnalytics"],
    failed,
  }), [clock, failed, payload]);

  return (
    <>
      <section aria-label="Trading system status" className="border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-1.5 lg:px-5">
        <div className="mx-auto flex max-w-[1800px] gap-1.5 overflow-x-auto md:grid md:grid-cols-5 md:overflow-visible">
          {items.map((item) => {
            const Icon = ICONS[item.id as keyof typeof ICONS] ?? AlertTriangle;
            return (
              <button key={item.id} type="button" onClick={() => setSelected(item)} aria-label={`${item.label}: ${item.value}. Open status details.`} className="flex min-w-max flex-1 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-left hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] md:min-w-0 md:flex-wrap">
                <span className={`h-2 w-2 shrink-0 rounded-full ${TONES[item.tone]}`} aria-hidden="true" />
                <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                <span className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">{item.label}</span>
                <span className="text-xs font-semibold tabular-nums text-[var(--text-primary)]">{item.value}</span>
              </button>
            );
          })}
        </div>
      </section>

      {selected && (
        <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/55 px-4 pt-24" role="presentation" onMouseDown={() => setSelected(null)}>
          <section role="dialog" aria-modal="true" aria-labelledby="trading-status-title" onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-lg rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface-panel)] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--text-muted)]">Trading status inspector</p>
                <h2 id="trading-status-title" className="mt-1 text-lg font-bold text-[var(--text-primary)]">{selected.label}: {selected.value}</h2>
              </div>
              <button type="button" onClick={() => setSelected(null)} aria-label="Close status inspector" className="rounded-[var(--radius-control)] p-2 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"><X className="h-4 w-4" /></button>
            </div>
            <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">{selected.detail}</p>
            {selected.remediation && <div className="mt-4 rounded-[var(--radius-control)] border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10 p-3 text-sm text-[var(--text-primary)]"><strong>Recommended:</strong> {selected.remediation}</div>}
          </section>
        </div>
      )}
    </>
  );
}
