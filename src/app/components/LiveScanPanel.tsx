"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link2, Play, Square, Activity, RefreshCw, ArrowRight, AlertCircle } from "lucide-react";

interface LiveMarketResult {
  kalshiYesAsk: number | null;
  kalshiNoAsk: number | null;
  kalshiYesDepth: number;
  kalshiNoDepth: number;
  pmYesAsk: number | null;
  pmNoAsk: number | null;
  pmYesDepth: number;
  pmNoDepth: number;
  strategy: string;
  roiPct: number;
  expectedProfit: number;
  kalshiStake: number;
  pmStake: number;
  fees: {
    kalshiFee: number;
    pmFee: number;
    worstCaseNetProfit: number;
  } | null;
  lastUpdate: string;
}

interface Props {
  capital: number;
}

export function LiveScanPanel({ capital }: Props) {
  const [kalshiUrl, setKalshiUrl] = useState("");
  const [pmUrl, setPmUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<LiveMarketResult | null>(null);
  const [status, setStatus] = useState("Idle");
  const eventSourceRef = useRef<EventSource | null>(null);

  const stop = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setRunning(false);
    setStatus("Stopped");
  }, []);

  const start = useCallback(async () => {
    setError("");
    setResult(null);
    stop();

    if (!kalshiUrl.trim() || !pmUrl.trim()) {
      setError("Paste both a Kalshi URL and a Polymarket URL.");
      return;
    }

    setLoading(true);
    setStatus("Connecting...");

    try {
      const params = new URLSearchParams();
      params.set("kalshiUrl", kalshiUrl.trim());
      params.set("pmUrl", pmUrl.trim());
      params.set("capital", String(capital));
      const es = new EventSource(`/api/ws/live-scan?${params.toString()}`);
      eventSourceRef.current = es;

      es.onopen = () => {
        setLoading(false);
        setRunning(true);
        setStatus("Streaming live prices");
      };

      es.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        if (data.error) {
          setError(data.error);
          stop();
          return;
        }
        if (data.type === "status") {
          setStatus(data.message);
          return;
        }
        if (data.type === "result") {
          setResult(data.result);
        }
      };

      es.onerror = () => {
        setError("Stream disconnected.");
        stop();
      };
    } catch (err) {
      setLoading(false);
      setError(String(err));
    }
  }, [kalshiUrl, pmUrl, capital, stop]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  const fmt = (n: number | null) =>
    n === null ? "—" : n.toFixed(4);

  const fmtUsd = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-[#182533] bg-[#17212B] p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-5 h-5 text-[#5DBE81]" />
          <h2 className="text-sm font-bold text-[#FFFFFF]">Live WebSocket Scanner</h2>
          <span className="ml-auto text-xs px-2 py-1 rounded-full bg-[#182533] text-[#5E6875]">
            {running ? "Live" : status}
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs font-medium text-[#8A9BA8]">
              <Link2 className="w-3.5 h-3.5" /> Kalshi URL
            </label>
            <input
              type="text"
              value={kalshiUrl}
              onChange={(e) => setKalshiUrl(e.target.value)}
              disabled={running}
              placeholder="https://kalshi.com/markets/..."
              className="w-full px-3 py-2.5 rounded-lg bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] placeholder-[#5E6875] focus:outline-none focus:border-[#5DBE81] disabled:opacity-60"
            />
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs font-medium text-[#8A9BA8]">
              <Link2 className="w-3.5 h-3.5" /> Polymarket URL
            </label>
            <input
              type="text"
              value={pmUrl}
              onChange={(e) => setPmUrl(e.target.value)}
              disabled={running}
              placeholder="https://polymarket.com/event/..."
              className="w-full px-3 py-2.5 rounded-lg bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] placeholder-[#5E6875] focus:outline-none focus:border-[#5DBE81] disabled:opacity-60"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {!running ? (
            <button
              onClick={start}
              disabled={loading}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#5DBE81] text-black font-semibold text-sm hover:bg-[#4DA66E] transition-all disabled:opacity-50"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {loading ? "Starting..." : "Start Live Scan"}
            </button>
          ) : (
            <button
              onClick={stop}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#ef4444]/20 text-[#ef4444] border border-[#ef4444]/30 font-semibold text-sm hover:bg-[#ef4444]/30 transition-all"
            >
              <Square className="w-4 h-4" /> Stop Live Scan
            </button>
          )}

          {result && (
            <span className="text-xs text-[#5E6875]">
              Last update: {new Date(result.lastUpdate).toLocaleTimeString()}
            </span>
          )}
        </div>

        {error && (
          <div className="mt-3 flex items-center gap-2 text-sm text-[#ef4444]">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
      </div>

      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Kalshi card */}
          <div className="rounded-xl border border-[#182533] bg-[#17212B] p-5">
            <div className="flex items-center gap-2 mb-4">
              <div className="flex items-center justify-center w-5 h-5 rounded-sm bg-[#5DBE81]">
                <span className="text-[10px] font-bold text-[#FFFFFF]">K</span>
              </div>
              <h3 className="text-sm font-bold text-[#FFFFFF]">Kalshi Orderbook</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                <div className="text-[10px] text-[#5E6875] mb-1">YES Ask (buy)</div>
                <div className="text-lg font-bold text-[#5DBE81]">{fmt(result.kalshiYesAsk)}</div>
                <div className="text-[10px] text-[#5E6875]">Depth: ${result.kalshiYesDepth.toFixed(2)}</div>
              </div>
              <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                <div className="text-[10px] text-[#5E6875] mb-1">NO Ask (buy)</div>
                <div className="text-lg font-bold text-[#5DBE81]">{fmt(result.kalshiNoAsk)}</div>
                <div className="text-[10px] text-[#5E6875]">Depth: ${result.kalshiNoDepth.toFixed(2)}</div>
              </div>
            </div>
          </div>

          {/* Polymarket card */}
          <div className="rounded-xl border border-[#182533] bg-[#17212B] p-5">
            <div className="flex items-center gap-2 mb-4">
              <div className="flex items-center justify-center w-5 h-5 rounded-sm bg-[#a855f7]">
                <span className="text-[9px] font-bold text-[#FFFFFF]">PM</span>
              </div>
              <h3 className="text-sm font-bold text-[#FFFFFF]">Polymarket Orderbook</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                <div className="text-[10px] text-[#5E6875] mb-1">YES Ask (buy)</div>
                <div className="text-lg font-bold text-[#a855f7]">{fmt(result.pmYesAsk)}</div>
                <div className="text-[10px] text-[#5E6875]">Depth: ${result.pmYesDepth.toFixed(2)}</div>
              </div>
              <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                <div className="text-[10px] text-[#5E6875] mb-1">NO Ask (buy)</div>
                <div className="text-lg font-bold text-[#a855f7]">{fmt(result.pmNoAsk)}</div>
                <div className="text-[10px] text-[#5E6875]">Depth: ${result.pmNoDepth.toFixed(2)}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div className="rounded-xl border border-[#182533] bg-[#17212B] p-5">
          <h3 className="text-sm font-bold text-[#FFFFFF] mb-4">Arbitrage Signal</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
              <div className="text-[10px] text-[#5E6875]">Strategy</div>
              <div className={`text-sm font-semibold ${result.strategy !== "No arb" ? "text-[#5DBE81]" : "text-[#FFFFFF]"}`}>
                {result.strategy}
              </div>
            </div>
            <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
              <div className="text-[10px] text-[#5E6875]">Net ROI</div>
              <div className={`text-lg font-bold ${result.roiPct > 0 ? "text-[#5DBE81]" : "text-[#FFFFFF]"}`}>
                {result.roiPct.toFixed(2)}%
              </div>
            </div>
            <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
              <div className="text-[10px] text-[#5E6875]">Expected Net Profit</div>
              <div className={`text-lg font-bold ${result.expectedProfit > 0 ? "text-[#5DBE81]" : "text-[#FFFFFF]"}`}>
                {fmtUsd(result.expectedProfit)}
              </div>
            </div>
          </div>

          {result.strategy !== "No arb" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                <div className="text-[10px] text-[#5E6875]">Kalshi Stake</div>
                <div className="text-sm font-semibold text-[#FFFFFF]">{fmtUsd(result.kalshiStake)}</div>
              </div>
              <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                <div className="text-[10px] text-[#5E6875]">Polymarket Stake</div>
                <div className="text-sm font-semibold text-[#FFFFFF]">{fmtUsd(result.pmStake)}</div>
              </div>
            </div>
          )}

          {result.fees && (
            <div className="mt-4 text-xs text-[#5E6875]">
              Fees — Kalshi: {fmtUsd(result.fees.kalshiFee)} · Polymarket: {fmtUsd(result.fees.pmFee)} · Worst-case net: {fmtUsd(result.fees.worstCaseNetProfit)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
