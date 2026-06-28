"use client";

import React, { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Play, Square, Activity, RefreshCw, AlertCircle, ChevronDown } from "lucide-react";
import { SavedMarket } from "@/lib/persistence";

interface LiveArbOutcome {
  artist: string;
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

interface LiveScanResult {
  outcomes: LiveArbOutcome[];
  lastUpdate: string;
}

interface Props {
  capital: number;
  savedMarkets: SavedMarket[];
}

/* ── Flash animation helpers ────────────────────────────────────── */

interface PrevCellValues {
  kalshiYesAsk: number | null;
  kalshiNoAsk: number | null;
  pmYesAsk: number | null;
  pmNoAsk: number | null;
  spread: number | null;
  roiPct: number;
  expectedProfit: number;
}

type FlashColor = "green" | "red";

interface FlashEntry {
  color: FlashColor;
  nonce: number;
}

/** Compute the spread value for comparison (mirrors the render logic). */
function computeSpread(o: LiveArbOutcome): number | null {
  if (o.kalshiYesAsk != null && o.pmNoAsk != null) {
    return (1 - (o.kalshiYesAsk + o.pmNoAsk)) * 100;
  }
  if (o.pmYesAsk != null && o.kalshiNoAsk != null) {
    return (1 - (o.pmYesAsk + o.kalshiNoAsk)) * 100;
  }
  return null;
}

/**
 * A <td> that flashes green/red when its `flash.nonce` changes.
 * Uses the Web Animations API so rapid successive changes restart
 * the animation cleanly without DOM manipulation hacks.
 */
function FlashCell({
  flash,
  className,
  children,
}: {
  flash: FlashEntry | undefined;
  className: string;
  children: React.ReactNode;
}) {
  const cellRef = useRef<HTMLTableCellElement>(null);
  const lastNonceRef = useRef(0);

  useEffect(() => {
    if (flash && flash.nonce !== lastNonceRef.current && cellRef.current) {
      lastNonceRef.current = flash.nonce;
      const color =
        flash.color === "green" ? "rgba(93, 190, 129, 0.30)" : "rgba(239, 68, 68, 0.30)";
      cellRef.current.animate(
        [{ backgroundColor: color }, { backgroundColor: "transparent" }],
        { duration: 1500, easing: "ease-out", fill: "forwards" }
      );
    }
  }, [flash?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <td ref={cellRef} className={className}>
      {children}
    </td>
  );
}

/* ── Main component ─────────────────────────────────────────────── */

export function LiveScanPanel({ capital, savedMarkets }: Props) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<LiveScanResult | null>(null);
  const [status, setStatus] = useState("Idle");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Flash state
  const [flashes, setFlashes] = useState<Record<string, FlashEntry>>({});
  const flashesRef = useRef<Record<string, FlashEntry>>({});
  const prevValuesRef = useRef<Map<string, PrevCellValues>>(new Map());
  const flashTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const selectedMarket = useMemo(
    () => savedMarkets.find((m) => m.id === selectedId) || null,
    [savedMarkets, selectedId]
  );

  const marketOptions = useMemo(() => {
    return [...savedMarkets]
      .map((m) => ({
        ...m,
        roiPct: m.lastScanResult?.bestRoiPct ?? 0,
      }))
      .sort((a, b) => b.roiPct - a.roiPct);
  }, [savedMarkets]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  // Cleanup flash timers on unmount
  useEffect(() => {
    return () => {
      flashTimersRef.current.forEach((t) => clearTimeout(t));
      flashTimersRef.current.clear();
    };
  }, []);

  const stop = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setRunning(false);
    setStatus("Stopped");
  }, []);

  /**
   * Compute flash diffs between previous and new outcome values.
   * Updates prevValuesRef, flashesRef, and schedules flash cleanup.
   */
  const computeFlashDiffs = useCallback((newOutcomes: LiveArbOutcome[]) => {
    const prevMap = prevValuesRef.current;
    const newFlashes: Record<string, FlashEntry> = {};
    const flashRef = flashesRef.current;

    newOutcomes.forEach((o, idx) => {
      const prev = prevMap.get(String(idx));

      if (prev) {
        // Fields where lower = better (buying cheaper)
        const priceFields: Array<{
          name: string;
          newVal: number | null;
          prevVal: number | null;
        }> = [
          { name: "kYes", newVal: o.kalshiYesAsk, prevVal: prev.kalshiYesAsk },
          { name: "kNo", newVal: o.kalshiNoAsk, prevVal: prev.kalshiNoAsk },
          { name: "pmYes", newVal: o.pmYesAsk, prevVal: prev.pmYesAsk },
          { name: "pmNo", newVal: o.pmNoAsk, prevVal: prev.pmNoAsk },
        ];

        priceFields.forEach((f) => {
          if (f.prevVal != null && f.newVal != null && f.prevVal !== f.newVal) {
            const improved = f.newVal < f.prevVal; // lower price = better
            const cellKey = `${idx}-${f.name}`;
            const currentNonce = flashRef[cellKey]?.nonce ?? 0;
            newFlashes[cellKey] = {
              color: improved ? "green" : "red",
              nonce: currentNonce + 1,
            };
          }
        });

        // Fields where higher = better (more arb potential)
        const derivedFields: Array<{
          name: string;
          newVal: number | null;
          prevVal: number | null;
        }> = [
          { name: "spread", newVal: computeSpread(o), prevVal: prev.spread },
          { name: "roi", newVal: o.roiPct, prevVal: prev.roiPct },
          { name: "profit", newVal: o.expectedProfit, prevVal: prev.expectedProfit },
        ];

        derivedFields.forEach((f) => {
          if (f.prevVal != null && f.newVal != null && f.prevVal !== f.newVal) {
            const improved = f.newVal > f.prevVal; // higher = better
            const cellKey = `${idx}-${f.name}`;
            const currentNonce = flashRef[cellKey]?.nonce ?? 0;
            newFlashes[cellKey] = {
              color: improved ? "green" : "red",
              nonce: currentNonce + 1,
            };
          }
        });
      }

      // Store current values for next comparison
      prevMap.set(String(idx), {
        kalshiYesAsk: o.kalshiYesAsk,
        kalshiNoAsk: o.kalshiNoAsk,
        pmYesAsk: o.pmYesAsk,
        pmNoAsk: o.pmNoAsk,
        spread: computeSpread(o),
        roiPct: o.roiPct,
        expectedProfit: o.expectedProfit,
      });
    });

    if (Object.keys(newFlashes).length > 0) {
      // Update ref
      flashesRef.current = { ...flashRef, ...newFlashes };
      setFlashes(flashesRef.current);

      // Schedule cleanup for each flashed cell
      Object.keys(newFlashes).forEach((cellKey) => {
        const existing = flashTimersRef.current.get(cellKey);
        if (existing) clearTimeout(existing);
        flashTimersRef.current.set(
          cellKey,
          setTimeout(() => {
            setFlashes((prev) => {
              const next = { ...prev };
              delete next[cellKey];
              flashesRef.current = next;
              return next;
            });
            flashTimersRef.current.delete(cellKey);
          }, 1500)
        );
      });
    }
  }, []);

  const start = useCallback(async () => {
    setError("");
    setResult(null);
    // Clear flash state for a fresh session
    prevValuesRef.current = new Map();
    flashesRef.current = {};
    setFlashes({});
    flashTimersRef.current.forEach((t) => clearTimeout(t));
    flashTimersRef.current.clear();
    stop();

    if (!selectedMarket) {
      setError("Select a saved market from the dropdown.");
      return;
    }

    const kalshiUrl = selectedMarket.kalshiUrl?.trim();
    const pmUrl = selectedMarket.polymarketUrl?.trim();

    if (!kalshiUrl || !pmUrl) {
      setError("Selected market is missing Kalshi or Polymarket URL.");
      return;
    }

    setLoading(true);
    setStatus("Connecting...");

    try {
      const params = new URLSearchParams();
      params.set("kalshiUrl", kalshiUrl);
      params.set("pmUrl", pmUrl);
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
          // Compute flash diffs before setting result
          computeFlashDiffs(data.result.outcomes as LiveArbOutcome[]);
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
  }, [selectedMarket, capital, stop, computeFlashDiffs]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  const fmt = (n: number | null) =>
    n === null ? "—" : n.toFixed(4);

  const fmtUsd = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

  const roiColor = (roi: number) => {
    if (roi > 0) return "text-[#5DBE81]";
    return "text-[#FFFFFF]";
  };

  const strategyColor = (s: string) => {
    if (s !== "No arb") return "text-[#5DBE81]";
    return "text-[#FFFFFF]";
  };

  return (
    <div className="space-y-5">
      {/* Header / Controls */}
      <div className="rounded-xl border border-[#182533] bg-[#17212B] p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-5 h-5 text-[#5DBE81]" />
          <h2 className="text-sm font-bold text-[#FFFFFF]">Live WebSocket Scanner</h2>
          <span className="ml-auto text-xs px-2 py-1 rounded-full bg-[#182533] text-[#5E6875]">
            {running ? "Live" : status}
          </span>
        </div>

        <div className="mb-4">
          <label className="block text-xs font-medium text-[#8A9BA8] mb-2">Select saved market</label>
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              disabled={running}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81] disabled:opacity-60"
            >
              {selectedMarket ? (
                <span className="flex items-center gap-2 truncate">
                  <span className="truncate">{selectedMarket.eventTitle}</span>
                  <span className={`text-xs font-medium ${(selectedMarket.lastScanResult?.bestRoiPct ?? 0) > 0 ? "text-[#5DBE81]" : "text-[#5E6875]"}`}>
                    {(() => {
                      const roi = selectedMarket.lastScanResult?.bestRoiPct ?? 0;
                      return `${roi > 0 ? "+" : ""}${roi.toFixed(1)}%`;
                    })()}
                  </span>
                </span>
              ) : (
                <span className="text-[#5E6875]">Choose a market...</span>
              )}
              <ChevronDown className={`w-4 h-4 text-[#5E6875] transition-transform ${dropdownOpen ? "rotate-180" : ""}`} />
            </button>

            {dropdownOpen && (
              <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-[#232E3C] bg-[#182533] shadow-lg">
                {marketOptions.length === 0 ? (
                  <div className="px-3 py-2.5 text-xs text-[#5E6875]">No saved markets. Save one from Scan or MarketFinder.</div>
                ) : (
                  marketOptions.map((m) => {
                    const roi = m.roiPct;
                    const isPositive = roi > 0;
                    return (
                      <button
                        key={m.id}
                        onClick={() => {
                          setSelectedId(m.id);
                          setDropdownOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-[#232E3C] transition-colors ${selectedId === m.id ? "bg-[#5DBE81]/10" : ""}`}
                      >
                        <span className="truncate text-[#FFFFFF] text-left pr-2">{m.eventTitle}</span>
                        <span className={`shrink-0 text-xs font-medium ${isPositive ? "text-[#5DBE81]" : "text-[#5E6875]"}`}>
                          {isPositive ? "+" : ""}{roi.toFixed(1)}%
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {!running ? (
            <button
              onClick={start}
              disabled={loading || !selectedMarket}
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

      {/* Outcomes Table */}
      {result && result.outcomes.length > 0 && (
        <div className="rounded-xl border border-[#182533] bg-[#17212B] p-5">
          <h3 className="text-sm font-bold text-[#FFFFFF] mb-4">
            Matched Outcomes ({result.outcomes.length})
          </h3>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#182533]">
                  <th className="text-left py-2 px-2 text-[#5E6875] font-medium">OUTCOME</th>
                  <th className="text-right py-2 px-2 text-[#5E6875] font-medium">K YES</th>
                  <th className="text-right py-2 px-2 text-[#5E6875] font-medium">K NO</th>
                  <th className="text-right py-2 px-2 text-[#5E6875] font-medium">PM YES</th>
                  <th className="text-right py-2 px-2 text-[#5E6875] font-medium">PM NO</th>
                  <th className="text-right py-2 px-2 text-[#5E6875] font-medium">SPREAD</th>
                  <th className="text-right py-2 px-2 text-[#5E6875] font-medium">ROI</th>
                  <th className="text-right py-2 px-2 text-[#5E6875] font-medium">PROFIT</th>
                  <th className="text-left py-2 px-2 text-[#5E6875] font-medium">STRATEGY</th>
                </tr>
              </thead>
              <tbody>
                {result.outcomes.map((o, idx) => (
                  <tr
                    key={`${o.artist}-${idx}`}
                    className="border-b border-[#182533]/50 hover:bg-[#182533] transition-colors"
                  >
                    <td className="py-2 px-2 text-[#FFFFFF] font-medium">{o.artist}</td>
                    <FlashCell
                      flash={flashes[`${idx}-kYes`]}
                      className="py-2 px-2 text-right text-[#5DBE81] font-mono"
                    >
                      {fmt(o.kalshiYesAsk)}
                    </FlashCell>
                    <FlashCell
                      flash={flashes[`${idx}-kNo`]}
                      className="py-2 px-2 text-right text-[#5DBE81] font-mono"
                    >
                      {fmt(o.kalshiNoAsk)}
                    </FlashCell>
                    <FlashCell
                      flash={flashes[`${idx}-pmYes`]}
                      className="py-2 px-2 text-right text-[#a855f7] font-mono"
                    >
                      {fmt(o.pmYesAsk)}
                    </FlashCell>
                    <FlashCell
                      flash={flashes[`${idx}-pmNo`]}
                      className="py-2 px-2 text-right text-[#a855f7] font-mono"
                    >
                      {fmt(o.pmNoAsk)}
                    </FlashCell>
                    <FlashCell
                      flash={flashes[`${idx}-spread`]}
                      className="py-2 px-2 text-right font-mono text-[#FFFFFF]"
                    >
                      {(() => {
                        if (o.kalshiYesAsk != null && o.pmNoAsk != null) {
                          return `${((1 - (o.kalshiYesAsk + o.pmNoAsk)) * 100).toFixed(2)}%`;
                        }
                        if (o.pmYesAsk != null && o.kalshiNoAsk != null) {
                          return `${((1 - (o.pmYesAsk + o.kalshiNoAsk)) * 100).toFixed(2)}%`;
                        }
                        return "—";
                      })()}
                    </FlashCell>
                    <FlashCell
                      flash={flashes[`${idx}-roi`]}
                      className={`py-2 px-2 text-right font-mono font-bold ${roiColor(o.roiPct)}`}
                    >
                      {o.roiPct > 0 ? `+${o.roiPct.toFixed(2)}%` : `${o.roiPct.toFixed(2)}%`}
                    </FlashCell>
                    <FlashCell
                      flash={flashes[`${idx}-profit`]}
                      className={`py-2 px-2 text-right font-mono font-bold ${o.expectedProfit > 0 ? "text-[#5DBE81]" : "text-[#FFFFFF]"}`}
                    >
                      {fmtUsd(o.expectedProfit)}
                    </FlashCell>
                    <td className={`py-2 px-2 text-left font-medium ${strategyColor(o.strategy)}`}>
                      {o.strategy}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Summary stats */}
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
            {(() => {
              const positiveArbs = result.outcomes.filter((o) => o.roiPct > 0);
              const bestRoi = positiveArbs.length > 0
                ? Math.max(...positiveArbs.map((o) => o.roiPct))
                : 0;
              const totalProfit = result.outcomes.reduce((s, o) => s + o.expectedProfit, 0);
              return (
                <>
                  <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                    <div className="text-[10px] text-[#5E6875]">Total Outcomes</div>
                    <div className="text-lg font-bold text-[#FFFFFF]">{result.outcomes.length}</div>
                  </div>
                  <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                    <div className="text-[10px] text-[#5E6875]">Positive Arbs</div>
                    <div className={`text-lg font-bold ${positiveArbs.length > 0 ? "text-[#5DBE81]" : "text-[#FFFFFF]"}`}>{positiveArbs.length}</div>
                  </div>
                  <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                    <div className="text-[10px] text-[#5E6875]">Best ROI</div>
                    <div className={`text-lg font-bold ${bestRoi > 0 ? "text-[#5DBE81]" : "text-[#FFFFFF]"}`}>
                      {bestRoi > 0 ? `+${bestRoi.toFixed(2)}%` : "0.00%"}
                    </div>
                  </div>
                  <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                    <div className="text-[10px] text-[#5E6875]">Combined Profit</div>
                    <div className={`text-lg font-bold ${totalProfit > 0 ? "text-[#5DBE81]" : "text-[#FFFFFF]"}`}>
                      {fmtUsd(totalProfit)}
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}