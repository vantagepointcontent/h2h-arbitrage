"use client";
// HOOKUP-04 step 2: manual Execute button + confirmation modal.
// POLICY: manual-only. This component is the ONLY UI path to /api/execute.
// Dry-run/kill-switch state is fetched live and displayed prominently.

import { useState, useEffect } from "react";
import { Zap, ShieldAlert, X, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { formatPrice } from "@/app/lib/page-shared";
import { calcKalshiFee, calcPolymarketFee, getPolymarketTheta } from "@/lib/matcher";
import { isExecutableQuoteConsistent, type ExecutableBookQuote } from "@/lib/executable-book";
import { isPriceAlignedToTick } from "@/lib/venue-constraints";
import type { KalshiFeeAuthority } from "@/lib/kalshi-fee-quote";

interface ArbLeg {
  platform: "kalshi" | "polymarket";
  marketId: string;
  ticker?: string;
  conditionId?: string;
  side: "buy";
  outcome: "yes" | "no";
  size: number;
  contracts: 1;
  minimumOrderSize: number;
  tickSize: number;
  price: number;
  orderType: "limit";
  executableQuote: ExecutableBookQuote;
  kalshiFeeQuote?: import("@/lib/kalshi-fee-quote").KalshiFeeQuote;
}

export interface ExecutableArb {
  arbId: string;
  marketTitle: string;
  pmConditionId: string;
  outcome: string;
  strategy: string;
  roiPct: number;
  expectedProfit: number;
  /** Whole matched contracts, capped to the smaller selected live ask level. */
  shares: number;
  /** The active constraint on this 1:1 hedge; shown before any confirmation. */
  limitingConstraint: string;
  executionStatus: 'executable' | 'non_executable';
  executionBlocker?: string;
  kalshiOrder: ArbLeg;
  polymarketOrder: ArbLeg;
  /** ISO timestamp when the opportunity was last scanned/detected. */
  scanTime?: string;
  /** Whether at least one share was available at the best ask on both legs. */
  bestPriceFound?: boolean;
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
  kalshiYesExecutableQuote?: ExecutableBookQuote;
  kalshiNoExecutableQuote?: ExecutableBookQuote;
  pmYesExecutableQuote?: ExecutableBookQuote;
  pmNoExecutableQuote?: ExecutableBookQuote;
  /** Contracts available at the exact displayed effective ask level. */
  kalshiYesAskShares?: number;
  kalshiNoAskShares?: number;
  pmYesAskShares?: number;
  pmNoAskShares?: number;
  pmYesMinOrderSize?: number | null;
  pmNoMinOrderSize?: number | null;
  pmYesTickSize?: number | null;
  pmNoTickSize?: number | null;
  /** Missing or stale books are never safe to execute against. */
  stale?: boolean;
  kalshiTicker?: string;
  pmConditionId?: string;
  pmYesTokenId?: string;
  pmNoTokenId?: string;
  category?: string;
  kalshiFeeAuthority?: KalshiFeeAuthority;
  /** ISO timestamp when the opportunity was last scanned/detected. */
  scanTime?: string;
  /** True only when every leg has a verified positive ask depth. */
  depthVerified?: boolean;
}, marketTitle: string): ExecutableArb | null {
  if (!o.kalshiTicker || !o.pmConditionId) return null;
  let kOutcome: "yes" | "no";
  let kPrice: number | null;
  let pmOutcome: "yes" | "no";
  let pmPrice: number | null;
  let pmToken: string | undefined;
  let kalshiQuote: ExecutableBookQuote | undefined;
  let pmQuote: ExecutableBookQuote | undefined;
  let pmMinimumOrderSize: number | null | undefined;
  let pmTickSize: number | null | undefined;

  if (o.strategy === "Buy YES Kalshi + NO PM") {
    kOutcome = "yes"; kPrice = o.kalshiYesAsk; kalshiQuote = o.kalshiYesExecutableQuote;
    pmOutcome = "no"; pmPrice = o.pmNoAsk; pmToken = o.pmNoTokenId; pmQuote = o.pmNoExecutableQuote;
    pmMinimumOrderSize = o.pmNoMinOrderSize; pmTickSize = o.pmNoTickSize;
  } else if (o.strategy === "Buy YES PM + NO Kalshi") {
    kOutcome = "no"; kPrice = o.kalshiNoAsk; kalshiQuote = o.kalshiNoExecutableQuote;
    pmOutcome = "yes"; pmPrice = o.pmYesAsk; pmToken = o.pmYesTokenId; pmQuote = o.pmYesExecutableQuote;
    pmMinimumOrderSize = o.pmYesMinOrderSize; pmTickSize = o.pmYesTickSize;
  } else {
    return null; // cross-outcome / No arb — not executable from this button
  }
  if (kPrice == null || pmPrice == null || !pmToken || o.stale) return null;
  if (kPrice <= 0 || pmPrice <= 0 || o.kalshiStake <= 0 || o.pmStake <= 0) return null;
  const oneShareMicros = 1_000_000;
  if (!isExecutableQuoteConsistent(kalshiQuote, 'buy', oneShareMicros)
      || !isExecutableQuoteConsistent(pmQuote, 'buy', oneShareMicros)) return null;

  const kalshiVwap = kalshiQuote.vwapPriceMicroCents! / 100_000_000;
  const pmVwap = pmQuote.vwapPriceMicroCents! / 100_000_000;
  const kalshiLimit = kalshiQuote.limitPriceMicroCents! / 100_000_000;
  const pmLimit = pmQuote.limitPriceMicroCents! / 100_000_000;

  const kAvailable = kOutcome === 'yes' ? o.kalshiYesAskShares : o.kalshiNoAskShares;
  const pmAvailable = pmOutcome === 'yes' ? o.pmYesAskShares : o.pmNoAskShares;

  // Current execution policy is exactly one matched share. The quote itself
  // proves that the full share is available across the walked ladder.
  const constraints = [
    { label: "Kalshi allocation", value: o.kalshiStake / kPrice },
    { label: "Polymarket allocation", value: o.pmStake / pmPrice },
    { label: "Kalshi live depth", value: kAvailable! },
    { label: "Polymarket live depth", value: pmAvailable! },
  ];
  const limitingConstraint = constraints.reduce((lowest, constraint) =>
    constraint.value < lowest.value ? constraint : lowest,
  ).label;
  const shares = 1;
  const executionBlocker = !Number.isFinite(kAvailable) || kAvailable! < shares
    ? `Kalshi ${kOutcome.toUpperCase()} top-of-book depth cannot fill requested 1 contract`
    : !Number.isFinite(pmAvailable) || pmAvailable! < shares
      ? `Polymarket ${pmOutcome.toUpperCase()} top-of-book depth cannot fill requested 1 share`
      : !Number.isFinite(pmMinimumOrderSize) || pmMinimumOrderSize! <= 0
    ? `Polymarket ${pmOutcome.toUpperCase()} minimum order is unavailable`
    : pmMinimumOrderSize! > shares
      ? `Polymarket ${pmOutcome.toUpperCase()} minimum order is ${pmMinimumOrderSize} shares; requested 1 share`
      : !Number.isFinite(pmTickSize) || pmTickSize! <= 0
        ? `Polymarket ${pmOutcome.toUpperCase()} tick size is unavailable`
      : !isPriceAlignedToTick(pmLimit, pmTickSize!)
        ? `Polymarket ${pmOutcome.toUpperCase()} limit ${pmLimit} is not aligned to tick size ${pmTickSize}`
        : undefined;
  const resolvedLimitingConstraint = executionBlocker ?? limitingConstraint;

  // The scanner's full-book profit is no longer valid after a top-level depth
  // cap. Reprice the exact whole-share order shown in this modal, net of venue
  // fees, so the confirmation and submitted request describe the same trade.
  const kalshiCost = kalshiVwap;
  const pmCost = pmVwap;
  const totalCost = kalshiCost + pmCost;
  const fees = calcKalshiFee(shares, kalshiVwap, o.kalshiFeeAuthority)
    + calcPolymarketFee(shares, pmVwap, getPolymarketTheta(o.category));
  const expectedProfit = shares - totalCost - fees;
  const roiPct = totalCost > 0 ? (expectedProfit / totalCost) * 100 : 0;

  return {
    arbId: `${Date.now().toString(36)}-${o.artist.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`,
    marketTitle,
    pmConditionId: o.pmConditionId,
    outcome: o.artist,
    strategy: o.strategy,
    roiPct,
    expectedProfit,
    shares,
    limitingConstraint: resolvedLimitingConstraint,
    executionStatus: executionBlocker ? 'non_executable' : 'executable',
    ...(executionBlocker ? { executionBlocker } : {}),
    kalshiOrder: {
      platform: "kalshi", marketId: o.kalshiTicker, ticker: o.kalshiTicker,
      side: "buy", outcome: kOutcome, size: kalshiCost, contracts: 1,
      minimumOrderSize: 1, tickSize: 0.01,
      price: kalshiLimit, orderType: "limit", executableQuote: kalshiQuote,
    },
    polymarketOrder: {
      platform: "polymarket", marketId: pmToken, conditionId: pmToken,
      side: "buy", outcome: pmOutcome, size: pmCost, contracts: 1,
      minimumOrderSize: pmMinimumOrderSize ?? 0, tickSize: pmTickSize ?? 0,
      price: pmLimit, orderType: "limit", executableQuote: pmQuote,
    },
    scanTime: o.scanTime,
    bestPriceFound: o.depthVerified === true,
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

interface LedgerSummary {
  grossSpreadCents: number | null;
  totalEntryFeesCents: number;
  totalExitFeesCents: number;
  netPnlCents: number | null;
  estimatedNetPnlCents?: number | null;
  feesEstimated: boolean;
  status: 'reconciled' | 'reconciliation-required';
  fees?: Array<{ stage: 'entry' | 'exit'; source: 'charged' | 'estimated' }>;
}

interface ExecutionApiResponse {
  success: boolean;
  dryRun: boolean;
  result?: {
    kalshiResult?: { platform: string; status: string; filledSize?: number; filledPrice?: number; error?: string };
    polymarketResult?: { platform: string; status: string; filledSize?: number; filledPrice?: number; error?: string };
    cashLedger?: LedgerSummary;
    actualProfit?: number;
    netExposure?: number;
    rollbackExecuted?: boolean;
    unhedged?: boolean;
  };
}

/** Stable manual-modal projection of the persisted integer-cent ledger. */
export function getExecutionLedgerRows(ledger: LedgerSummary): Array<{ label: string; value: string }> {
  const money = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
  const feeSource = (stage: 'entry' | 'exit') => {
    const stageFees = ledger.fees?.filter((fee) => fee.stage === stage) ?? [];
    if (stageFees.length === 0) return ledger.feesEstimated ? 'estimated' : 'charged';
    return stageFees.some((fee) => fee.source === 'estimated') ? 'estimated' : 'charged';
  };
  return [
    { label: 'Actual gross spread', value: ledger.grossSpreadCents == null ? 'Unknown' : money(ledger.grossSpreadCents) },
    { label: `Entry fees (${feeSource('entry')})`, value: money(-ledger.totalEntryFeesCents) },
    { label: `Exit fees (${feeSource('exit')})`, value: money(-ledger.totalExitFeesCents) },
    ...(ledger.status !== 'reconciled' && ledger.estimatedNetPnlCents != null ? [{
      label: 'Estimated net P&L (not actual)',
      value: money(ledger.estimatedNetPnlCents),
    }] : []),
    {
      label: 'Actual net P&L',
      value: ledger.status === 'reconciled' && ledger.netPnlCents != null
        ? money(ledger.netPnlCents)
        : 'Reconciliation required',
    },
  ];
}

export function ExecuteArbModal({ arb, onClose }: { arb: ExecutableArb; onClose: () => void }) {
  const [gates, setGates] = useState<GateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExecutionApiResponse | null>(null);
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
            pmConditionId: arb.pmConditionId,
            kalshiOrder: arb.kalshiOrder,
            polymarketOrder: arb.polymarketOrder,
            estimatedProfit: arb.expectedProfit,
            maxSlippagePct: 1,
            timeoutMs: 10000,
            dryRun: false, // server ORs with settings — settings dryRun still wins
            scanTime: arb.scanTime,
            bestPriceFound: arb.bestPriceFound,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || `HTTP ${res.status}`);
      else setResult(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  const isReal = gates ? !gates.killSwitch && !gates.dryRun : false;
  const fmt = (n: number) => `$${n.toFixed(2)}`;
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
              <span className="font-mono font-bold text-[#5DBE81]">{fmt(arb.expectedProfit)} ({arb.roiPct.toFixed(2)}%)</span>
            </div>
          </div>

          {gates && isReal && !gates.credsReady && (
            <div className="p-2 rounded-lg border border-red-800 bg-red-950/40 text-red-400 text-xs">
              Credentials incomplete — real execution will be refused. Add them in Settings → Trading Credentials.
            </div>
          )}

          {error && <div className="p-2 rounded-lg border border-red-800 bg-red-950/40 text-red-400 text-xs">{error}</div>}
          {arb.executionBlocker && <div className="p-2 rounded-lg border border-red-800 bg-red-950/40 text-red-400 text-xs">{arb.executionBlocker}</div>}

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
              {result.result?.cashLedger
                ? getExecutionLedgerRows(result.result.cashLedger).map((row) => (
                  <div key={row.label} className="px-3 py-2 flex justify-between">
                    <span className="text-[#8A9BA8]">{row.label}</span>
                    <span className="font-mono font-bold text-[#5DBE81]">{row.value}</span>
                  </div>
                ))
                : result.result?.actualProfit != null && (
                  <div className="px-3 py-2 flex justify-between">
                    <span className="text-[#8A9BA8]">Actual net P&amp;L (legacy)</span>
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
              disabled={busy || arb.executionStatus !== 'executable' || !gates || (!gates.dryRun && gates.killSwitch)}
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
