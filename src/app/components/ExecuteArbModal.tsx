"use client";
// HOOKUP-04 step 2: manual Execute button + confirmation modal.
// POLICY: manual-only. This component is the ONLY UI path to /api/execute.
// Dry-run/kill-switch state is fetched live and displayed prominently.

import { useState, useEffect } from "react";
import { Zap, ShieldAlert, X, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { formatPrice } from "@/app/lib/page-shared";

interface ArbLeg {
  platform: "kalshi" | "polymarket";
  marketId: string;
  ticker?: string;
  conditionId?: string;
  side: "buy";
  outcome: "yes" | "no";
  size: number;
  price: number;
  orderType: "limit";
}

export interface ExecutableArb {
  arbId: string;
  marketTitle: string;
  outcome: string;
  strategy: string;
  roiPct: number;
  expectedProfit: number;
  kalshiOrder: ArbLeg;
  polymarketOrder: ArbLeg;
}

/** Build an executable request from a live arb row, or null when the
 *  strategy isn't a simple two-leg arb (cross-outcome combos excluded). */
export function buildExecutableArb(o: {
  artist: string;
  strategy: string;
  roiPct: number;
  expectedProfit: number;
  kalshiStake: number;
  pmStake: number;
  kalshiYesAsk: number | null;
  kalshiNoAsk: number | null;
  pmYesAsk: number | null;
  pmNoAsk: number | null;
  kalshiTicker?: string;
  pmYesTokenId?: string;
  pmNoTokenId?: string;
}, marketTitle: string): ExecutableArb | null {
  if (!o.kalshiTicker) return null;
  let kOutcome: "yes" | "no";
  let kPrice: number | null;
  let pmOutcome: "yes" | "no";
  let pmPrice: number | null;
  let pmToken: string | undefined;

  if (o.strategy === "Buy YES Kalshi + NO PM") {
    kOutcome = "yes"; kPrice = o.kalshiYesAsk;
    pmOutcome = "no"; pmPrice = o.pmNoAsk; pmToken = o.pmNoTokenId;
  } else if (o.strategy === "Buy YES PM + NO Kalshi") {
    kOutcome = "no"; kPrice = o.kalshiNoAsk;
    pmOutcome = "yes"; pmPrice = o.pmYesAsk; pmToken = o.pmYesTokenId;
  } else {
    return null; // cross-outcome / No arb — not executable from this button
  }
  if (kPrice == null || pmPrice == null || !pmToken) return null;
  if (kPrice <= 0 || pmPrice <= 0 || o.kalshiStake <= 0 || o.pmStake <= 0) return null;

  return {
    arbId: `${Date.now().toString(36)}-${o.artist.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`,
    marketTitle,
    outcome: o.artist,
    strategy: o.strategy,
    roiPct: o.roiPct,
    expectedProfit: o.expectedProfit,
    kalshiOrder: {
      platform: "kalshi", marketId: o.kalshiTicker, ticker: o.kalshiTicker,
      side: "buy", outcome: kOutcome, size: o.kalshiStake, price: kPrice, orderType: "limit",
    },
    polymarketOrder: {
      platform: "polymarket", marketId: pmToken, conditionId: pmToken,
      side: "buy", outcome: pmOutcome, size: o.pmStake, price: pmPrice, orderType: "limit",
    },
  };
}

interface GateInfo {
  killSwitch: boolean;
  dryRun: boolean;
  credsReady: boolean;
}

export function ExecuteArbModal({ arb, onClose }: { arb: ExecutableArb; onClose: () => void }) {
  const [gates, setGates] = useState<GateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/execute")
      .then((r) => r.json())
      .then((d) => setGates({
        killSwitch: Boolean(d.killSwitch),
        dryRun: Boolean(d.limits?.dryRunMode),
        credsReady: Boolean(d.credentials?.allReady),
      }))
      .catch(() => setGates(null));
  }, []);

  const run = async () => {
    setBusy(true); setError(""); setResult(null);
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "execute",
          request: {
            arbId: arb.arbId,
            marketTitle: arb.marketTitle,
            kalshiOrder: arb.kalshiOrder,
            polymarketOrder: arb.polymarketOrder,
            estimatedProfit: arb.expectedProfit,
            maxSlippagePct: 1,
            timeoutMs: 10000,
            dryRun: false, // server ORs with settings — settings dryRun still wins
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || `HTTP ${res.status}`);
      else setResult(data);
    } catch (e: any) {
      setError(e.message || "Network error");
    } finally {
      setBusy(false);
    }
  };

  const isReal = gates ? !gates.killSwitch && !gates.dryRun : false;
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const formatShares = (size: number) => `${size.toLocaleString(undefined, { maximumFractionDigits: 2 })} shares`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md mx-4 rounded-xl border border-[#182533] bg-[#17212B] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#182533]">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <Zap className="w-4 h-4 text-[#facc15]" /> Execute Arb — {arb.outcome}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#0E1621]"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-4 py-3 space-y-3 text-sm">
          <div className={`p-2.5 rounded-lg border text-xs flex items-start gap-2 ${isReal ? "border-red-800 bg-red-950/40 text-red-400" : "border-amber-500/40 bg-amber-500/10 text-amber-400"}`}>
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            {gates === null ? "Checking safety gates..." : isReal
              ? "REAL MODE — this will place REAL limit orders on both platforms with REAL money."
              : gates.killSwitch
                ? "Kill switch is ON — execution will be refused. Disable it in Settings to proceed."
                : "DRY RUN — orders will be simulated. Disable dry-run in Settings for real execution."}
          </div>

          <div className="rounded-lg bg-[#0E1621] border border-[#182533] divide-y divide-[#182533] text-xs">
            <div className="px-3 py-2 flex justify-between"><span className="text-[#8A9BA8]">Market</span><span className="font-medium truncate ml-2">{arb.marketTitle}</span></div>
            <div className="px-3 py-2 flex justify-between"><span className="text-[#8A9BA8]">Strategy</span><span className="font-medium">{arb.strategy}</span></div>
            <div className="px-3 py-2 flex justify-between">
              <span className="text-[#8A9BA8]">Kalshi leg</span>
              <span className="font-mono">{arb.kalshiOrder.outcome.toUpperCase()} @ {formatPrice(arb.kalshiOrder.price)} · {formatShares(arb.kalshiOrder.size / arb.kalshiOrder.price)} · {fmt(arb.kalshiOrder.size)}</span>
            </div>
            <div className="px-3 py-2 flex justify-between">
              <span className="text-[#8A9BA8]">Polymarket leg</span>
              <span className="font-mono">{arb.polymarketOrder.outcome.toUpperCase()} @ {formatPrice(arb.polymarketOrder.price)} · {formatShares(arb.polymarketOrder.size / arb.polymarketOrder.price)} · {fmt(arb.polymarketOrder.size)}</span>
            </div>
            <div className="px-3 py-2 flex justify-between">
              <span className="text-[#8A9BA8]">Est. net profit</span>
              <span className="font-mono font-bold text-[#5DBE81]">{fmt(arb.expectedProfit)} ({arb.roiPct.toFixed(2)}%)</span>
            </div>
          </div>

          {gates && isReal && !gates.credsReady && (
            <div className="p-2 rounded-lg border border-red-800 bg-red-950/40 text-red-400 text-xs">
              Credentials incomplete — real execution will be refused. Add them in Settings → Trading Credentials.
            </div>
          )}

          {error && <div className="p-2 rounded-lg border border-red-800 bg-red-950/40 text-red-400 text-xs">{error}</div>}

          {result && (
            <div className="rounded-lg bg-[#0E1621] border border-[#182533] divide-y divide-[#182533] text-xs">
              <div className="px-3 py-2 flex items-center gap-2 font-semibold">
                {result.success ? <CheckCircle2 className="w-4 h-4 text-[#5DBE81]" /> : <XCircle className="w-4 h-4 text-[#ef4444]" />}
                {result.dryRun ? "Simulated" : "Executed"} — {result.success ? "success" : "failed"}
                {result.result?.rollbackExecuted && <span className="text-amber-400">(rollback fired)</span>}
              </div>
              {(["kalshiResult", "polymarketResult"] as const).map((k) => {
                const leg = result.result?.[k];
                if (!leg) return null;
                return (
                  <div key={k} className="px-3 py-2 flex justify-between">
                    <span className="text-[#8A9BA8]">{leg.platform}</span>
                    <span className="font-mono">
                      {leg.status}{leg.filledSize ? ` · ${fmt(leg.filledSize)} @ ${leg.filledPrice?.toFixed(3)}` : ""}{leg.error ? ` · ${leg.error.slice(0, 60)}` : ""}
                    </span>
                  </div>
                );
              })}
              {result.result?.actualProfit != null && (
                <div className="px-3 py-2 flex justify-between">
                  <span className="text-[#8A9BA8]">Actual profit</span>
                  <span className="font-mono font-bold text-[#5DBE81]">{fmt(result.result.actualProfit)}</span>
                </div>
              )}
              {result.result?.netExposure != null && result.result.netExposure > 0 && (
                <div className="px-3 py-2 flex justify-between">
                  <span className="text-[#8A9BA8]">Net exposure</span>
                  <span className="font-mono font-bold text-amber-400">{fmt(result.result.netExposure)}</span>
                </div>
              )}
            </div>
          )}

          {result?.result?.unhedged && (
            <div className="p-2.5 rounded-lg border border-red-800 bg-red-950/40 text-red-400 text-xs flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <b>UNHEDGED EXPOSURE</b> — auto-close failed. You have ${fmt(result.result.netExposure ?? 0)} of unhedged position.
                Check the Trades tab and close manually.
              </div>
            </div>
          )}

          {result?.result?.rollbackExecuted && !result?.result?.unhedged && (
            <div className="p-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              Partial fill detected — auto-close executed to eliminate exposure. Both legs cancelled.
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-[#182533] flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg bg-[#0E1621] border border-[#182533] text-xs hover:border-[#5E6875] transition-colors">
            {result ? "Close" : "Cancel"}
          </button>
          {!result && (
            <button
              onClick={run}
              disabled={busy || gates?.killSwitch}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors disabled:opacity-50 ${isReal ? "bg-[#ef4444] text-white hover:bg-[#dc2626]" : "bg-[#5DBE81] text-black hover:bg-[#4DA66E]"}`}
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {isReal ? "Execute REAL orders" : "Execute (dry run)"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
