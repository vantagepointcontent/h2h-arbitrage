"use client";
// HOOKUP-04 step 2: manual Execute button + confirmation modal.
// POLICY: manual-only. This component is the ONLY UI path to /api/execute.
// Dry-run/kill-switch state is fetched live and displayed prominently.

import { useState, useEffect } from "react";
import { Zap, ShieldAlert, X, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { formatPrice } from "@/app/lib/page-shared";
import type { CalculationEnvelope } from "@/lib/calculation-envelope";
import { CalculationProvenance } from "./CalculationProvenance";

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 5 });

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
  expectedProfitMicros: number;
  grossProfitMicros: number;
  totalFeesMicros: number;
  /** Canonical contract quantity. Calculation-envelope v1 supports exactly one share per leg. */
  shares: number;
  /** The active constraint on this 1:1 hedge; shown before any confirmation. */
  limitingConstraint: string;
  kalshiOrder: ArbLeg;
  polymarketOrder: ArbLeg;
  /** ISO timestamp when the opportunity was last scanned/detected. */
  scanTime?: string;
  /** Whether at least one share was available at the best ask on both legs. */
  bestPriceFound?: boolean;
  calculationEnvelope: CalculationEnvelope;
}

/** Build an executable request from a live arb row, or null when the
 *  strategy isn't a simple two-leg arb (cross-outcome combos excluded). */
interface ExecutionResult {
  success?: boolean;
  dryRun?: boolean;
  result?: {
    rollbackExecuted?: boolean;
    unhedged?: boolean;
    actualProfit?: number;
    netExposure?: number;
    kalshiResult?: { platform?: string; status?: string; filledSize?: number; filledPrice?: number; error?: string };
    polymarketResult?: { platform?: string; status?: string; filledSize?: number; filledPrice?: number; error?: string };
  };
  error?: string;
}

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
  /** Contracts available at the exact displayed effective ask level. */
  kalshiYesAskShares?: number;
  kalshiNoAskShares?: number;
  pmYesAskShares?: number;
  pmNoAskShares?: number;
  /** Missing or stale books are never safe to execute against. */
  stale?: boolean;
  kalshiTicker?: string;
  pmYesTokenId?: string;
  pmNoTokenId?: string;
  category?: string;
  /** ISO timestamp when the opportunity was last scanned/detected. */
  scanTime?: string;
  /** True only when every leg has a verified positive ask depth. */
  depthVerified?: boolean;
  calculationEnvelope?: CalculationEnvelope;
}, marketTitle: string): ExecutableArb | null {
  const envelope = o.calculationEnvelope;
  if (!envelope || envelope.status !== 'executable'
    || envelope.requestedQuantityMicros !== 1_000_000
    || envelope.executableQuantityMicros !== 1_000_000
    || envelope.totals.grossCostMicros == null
    || envelope.totals.grossCostMicros <= 0
    || envelope.totals.grossProfitMicros == null
    || envelope.totals.totalFeesMicros == null
    || envelope.totals.netPnlMicros == null) return null;
  if (!o.kalshiTicker) return null;
  let kOutcome: "yes" | "no";
  let pmOutcome: "yes" | "no";
  let pmToken: string | undefined;

  if (o.strategy === "Buy YES Kalshi + NO PM") {
    kOutcome = "yes";
    pmOutcome = "no"; pmToken = o.pmNoTokenId;
  } else if (o.strategy === "Buy YES PM + NO Kalshi") {
    kOutcome = "no";
    pmOutcome = "yes"; pmToken = o.pmYesTokenId;
  } else {
    return null; // cross-outcome / No arb — not executable from this button
  }
  if (!pmToken || o.stale) return null;
  const kalshiLeg = envelope.legs.find((leg) => leg.venue.toLowerCase() === 'kalshi');
  const pmLeg = envelope.legs.find((leg) => leg.venue.toLowerCase() === 'polymarket');
  if (!kalshiLeg || !pmLeg
    || kalshiLeg.instrumentId.toLowerCase() !== o.kalshiTicker.toLowerCase()
    || pmLeg.instrumentId.toLowerCase() !== pmToken.toLowerCase()
    || kalshiLeg.side !== kOutcome || pmLeg.side !== pmOutcome
    || kalshiLeg.action !== 'buy' || pmLeg.action !== 'buy'
    || kalshiLeg.requestedQuantityMicros !== 1_000_000 || pmLeg.requestedQuantityMicros !== 1_000_000
    || kalshiLeg.executableQuantityMicros !== 1_000_000 || pmLeg.executableQuantityMicros !== 1_000_000
    || kalshiLeg.vwapPriceMicros == null || pmLeg.vwapPriceMicros == null) return null;
  const canonicalKalshiPrice = kalshiLeg.vwapPriceMicros / 1_000_000;
  const canonicalPmPrice = pmLeg.vwapPriceMicros / 1_000_000;
  const expectedProfit = envelope.totals.netPnlMicros / 1_000_000;
  const canonicalRoiPct = (envelope.totals.netPnlMicros / envelope.totals.grossCostMicros) * 100;

  return {
    arbId: `${Date.now().toString(36)}-${o.artist.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`,
    marketTitle,
    outcome: o.artist,
    strategy: o.strategy,
    roiPct: canonicalRoiPct,
    expectedProfit,
    expectedProfitMicros: envelope.totals.netPnlMicros,
    grossProfitMicros: envelope.totals.grossProfitMicros,
    totalFeesMicros: envelope.totals.totalFeesMicros,
    shares: 1,
    limitingConstraint: "canonical one-share envelope",
    kalshiOrder: {
      platform: "kalshi", marketId: o.kalshiTicker, ticker: o.kalshiTicker,
      side: "buy", outcome: kOutcome, size: canonicalKalshiPrice, price: canonicalKalshiPrice, orderType: "limit",
    },
    polymarketOrder: {
      platform: "polymarket", marketId: pmToken, conditionId: pmToken,
      side: "buy", outcome: pmOutcome, size: canonicalPmPrice, price: canonicalPmPrice, orderType: "limit",
    },
    scanTime: o.scanTime,
    bestPriceFound: o.depthVerified === true,
    calculationEnvelope: envelope,
  };
}

interface GateInfo {
  killSwitch: boolean;
  dryRun: boolean;
  credsReady: boolean;
}

/** Stable, actionable status text for the manual-execution safety gates. */
export function getExecutionGateMessage(gates: GateInfo | null): string {
  if (!gates) return 'Checking execution safety gates — execution remains locked until this completes.';
  if (gates.dryRun) return 'TEST MODE — this creates a simulated two-leg bet in Trades. The kill switch remains ON and no venue is contacted.';
  if (gates.killSwitch) return 'Real execution is locked by the kill switch. Keep it ON unless you deliberately intend to trade live.';
  if (!gates.credsReady) return 'Credentials are incomplete. Add all Kalshi and Polymarket credentials in Settings → Trading Credentials.';
  return 'REAL MODE — this will place REAL limit orders on both platforms with REAL money.';
}

export function ExecuteArbModal({ arb, onClose }: { arb: ExecutableArb; onClose: () => void }) {
  const [gates, setGates] = useState<GateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/execute")
      .then((r) => r.json())
      .then((d) => setGates({
        killSwitch: Boolean(d.killSwitch),
        dryRun: Boolean(d.dryRun),
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
            scanTime: arb.scanTime,
            bestPriceFound: arb.bestPriceFound,
            calculationEnvelope: arb.calculationEnvelope,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || `HTTP ${res.status}`);
      else setResult(data as ExecutionResult);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  const isReal = gates ? !gates.killSwitch && !gates.dryRun : false;
  const fmt = (n: number) => USD.format(n);
  const formatShares = (shares: number) => `${shares.toLocaleString()} shares`;

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
            {getExecutionGateMessage(gates)}
          </div>

          <div className="rounded-lg bg-[#0E1621] border border-[#182533] divide-y divide-[#182533] text-xs">
            <div className="px-3 py-2 flex justify-between"><span className="text-[#8A9BA8]">Market</span><span className="font-medium truncate ml-2">{arb.marketTitle}</span></div>
            <div className="px-3 py-2 flex justify-between"><span className="text-[#8A9BA8]">Strategy</span><span className="font-medium">{arb.strategy}</span></div>
            <div className="px-3 py-2 flex justify-between">
              <span className="text-[#8A9BA8]">Kalshi leg</span>
              <span className="font-mono">{arb.kalshiOrder.outcome.toUpperCase()} @ {formatPrice(arb.kalshiOrder.price)} · {formatShares(arb.shares)} · {fmt(arb.kalshiOrder.size)}</span>
            </div>
            <div className="px-3 py-2 flex justify-between">
              <span className="text-[#8A9BA8]">Polymarket leg</span>
              <span className="font-mono">{arb.polymarketOrder.outcome.toUpperCase()} @ {formatPrice(arb.polymarketOrder.price)} · {formatShares(arb.shares)} · {fmt(arb.polymarketOrder.size)}</span>
            </div>
            <div className="px-3 py-2 flex justify-between">
              <span className="text-[#8A9BA8]">Hedge</span>
              <span className="font-mono font-medium">1:1 matched · limited by {arb.limitingConstraint}</span>
            </div>
            <div className="px-3 py-2 flex justify-between">
              <span className="text-[#8A9BA8]">Est. net profit</span>
              <span className={`font-mono font-bold ${arb.expectedProfit >= 0 ? 'text-[var(--status-positive)]' : 'text-[var(--status-negative)]'}`}>{fmt(arb.expectedProfit)} ({arb.roiPct.toFixed(2)}%)</span>
            </div>
          </div>

          <CalculationProvenance envelope={arb.calculationEnvelope} />

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
              disabled={busy || !gates || (!gates.dryRun && gates.killSwitch)}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors disabled:opacity-50 ${isReal ? "bg-[#ef4444] text-white hover:bg-[#dc2626]" : "bg-[#5DBE81] text-black hover:bg-[#4DA66E]"}`}
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {gates?.dryRun ? "Place test bet" : gates?.killSwitch ? "Real execution locked" : isReal ? "Execute REAL orders" : "Execute"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
