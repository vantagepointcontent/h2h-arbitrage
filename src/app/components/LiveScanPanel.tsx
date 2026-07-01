"use client";

import React, { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Play, Square, Activity, RefreshCw, AlertCircle, ChevronDown, X } from "lucide-react";
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

function computeSpread(o: LiveArbOutcome): number | null {
  if (o.kalshiYesAsk != null && o.pmNoAsk != null) {
    return (1 - (o.kalshiYesAsk + o.pmNoAsk)) * 100;
  }
  if (o.pmYesAsk != null && o.kalshiNoAsk != null) {
    return (1 - (o.pmYesAsk + o.kalshiNoAsk)) * 100;
  }
  return null;
}

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
  }, [flash?.nonce]);

  return (
    <td ref={cellRef} className={className}>
      {children}
    </td>
  );
}

/* ── Tab state ─────────────────────────────────────────────────── */

interface TabState {
  id: string;
  marketId: string;
  marketTitle: string;
  running: boolean;
  loading: boolean;
  error: string;
  status: string;
  result: LiveScanResult | null;
  eventSource: EventSource | null;
  flashes: Record<string, FlashEntry>;
  flashesRef: Record<string, FlashEntry>;
  prevValues: Map<string, PrevCellValues>;
  flashTimers: Map<string, ReturnType<typeof setTimeout>>;
}

const MAX_TABS = 8;

/* ── Main component ─────────────────────────────────────────────── */

export function LiveScanPanel({ capital, savedMarkets }: Props) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  const tabCounterRef = useRef(0);

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

  const filteredOptions = useMemo(() => {
    if (!searchQuery.trim()) return marketOptions;
    const q = searchQuery.toLowerCase().trim();
    return marketOptions.filter((m) => {
      const title = (m.eventTitle || "").toLowerCase();
      const cat = (m.category || "").toLowerCase();
      // Also search in URLs for ticker/slug
      const kalshiSlug = (m.kalshiUrl || "").toLowerCase();
      const pmSlug = (m.polymarketUrl || "").toLowerCase();
      return title.includes(q) || cat.includes(q) || kalshiSlug.includes(q) || pmSlug.includes(q);
    });
  }, [marketOptions, searchQuery]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setSearchQuery("");
        setFocusedIdx(-1);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  // Cleanup all tabs on unmount
  useEffect(() => {
    return () => {
      tabs.forEach((t) => {
        t.eventSource?.close();
        t.flashTimers.forEach((timer) => clearTimeout(timer));
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopTab = useCallback((tabId: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        t.eventSource?.close();
        t.flashTimers.forEach((timer) => clearTimeout(timer));
        return { ...t, running: false, loading: false, status: "Stopped", eventSource: null };
      })
    );
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === tabId);
      if (tab) {
        tab.eventSource?.close();
        tab.flashTimers.forEach((timer) => clearTimeout(timer));
      }
      const remaining = prev.filter((t) => t.id !== tabId);
      // Switch to another tab if closing the active one
      if (activeTabId === tabId && remaining.length > 0) {
        setActiveTabId(remaining[remaining.length - 1].id);
      } else if (remaining.length === 0) {
        setActiveTabId("");
      }
      return remaining;
    });
  }, [activeTabId]);

  const startTab = useCallback(async (tabId: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        // Clear previous state
        t.eventSource?.close();
        t.flashTimers.forEach((timer) => clearTimeout(timer));
        return {
          ...t,
          error: "",
          result: null,
          flashes: {},
          flashesRef: {},
          prevValues: new Map(),
          flashTimers: new Map(),
          loading: true,
          status: "Connecting...",
          eventSource: null,
        };
      })
    );

    // Need to read the updated tab state — use a ref or re-read
    const market = savedMarkets.find((m) => m.id === tabId);
    if (!market) return;

    const kalshiUrl = market.kalshiUrl?.trim();
    const pmUrl = market.polymarketUrl?.trim();
    if (!kalshiUrl || !pmUrl) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, error: "Missing Kalshi or Polymarket URL.", loading: false, status: "Error" }
            : t
        )
      );
      return;
    }

    try {
      const params = new URLSearchParams();
      params.set("kalshiUrl", kalshiUrl);
      params.set("pmUrl", pmUrl);
      params.set("capital", String(capital));
      const es = new EventSource(`/api/ws/live-scan?${params.toString()}`);

      es.onopen = () => {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? { ...t, loading: false, running: true, status: "Streaming live prices", eventSource: es }
              : t
          )
        );
      };

      es.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        if (data.error) {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === tabId
                ? { ...t, error: data.error, running: false, loading: false, status: "Error" }
                : t
            )
          );
          es.close();
          return;
        }
        if (data.type === "status") {
          setTabs((prev) =>
            prev.map((t) => (t.id === tabId ? { ...t, status: data.message } : t))
          );
          return;
        }
        if (data.type === "result") {
          setTabs((prev) =>
            prev.map((t) => {
              if (t.id !== tabId) return t;
              // Compute flash diffs
              const newOutcomes = data.result.outcomes as LiveArbOutcome[];
              const prevMap = t.prevValues;
              const newFlashes: Record<string, FlashEntry> = {};
              const flashRef = { ...t.flashesRef };

              newOutcomes.forEach((o: LiveArbOutcome, idx: number) => {
                const prev = prevMap.get(String(idx));
                if (prev) {
                  const priceFields: Array<{ name: string; newVal: number | null; prevVal: number | null }> = [
                    { name: "kYes", newVal: o.kalshiYesAsk, prevVal: prev.kalshiYesAsk },
                    { name: "kNo", newVal: o.kalshiNoAsk, prevVal: prev.kalshiNoAsk },
                    { name: "pmYes", newVal: o.pmYesAsk, prevVal: prev.pmYesAsk },
                    { name: "pmNo", newVal: o.pmNoAsk, prevVal: prev.pmNoAsk },
                  ];
                  priceFields.forEach((f) => {
                    if (f.prevVal != null && f.newVal != null && f.prevVal !== f.newVal) {
                      const improved = f.newVal < f.prevVal;
                      const cellKey = `${idx}-${f.name}`;
                      const currentNonce = flashRef[cellKey]?.nonce ?? 0;
                      newFlashes[cellKey] = { color: improved ? "green" : "red", nonce: currentNonce + 1 };
                    }
                  });
                  const derivedFields: Array<{ name: string; newVal: number | null; prevVal: number | null }> = [
                    { name: "spread", newVal: computeSpread(o), prevVal: prev.spread },
                    { name: "roi", newVal: o.roiPct, prevVal: prev.roiPct },
                    { name: "profit", newVal: o.expectedProfit, prevVal: prev.expectedProfit },
                  ];
                  derivedFields.forEach((f) => {
                    if (f.prevVal != null && f.newVal != null && f.prevVal !== f.newVal) {
                      const improved = f.newVal > f.prevVal;
                      const cellKey = `${idx}-${f.name}`;
                      const currentNonce = flashRef[cellKey]?.nonce ?? 0;
                      newFlashes[cellKey] = { color: improved ? "green" : "red", nonce: currentNonce + 1 };
                    }
                  });
                }
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

              // Schedule flash cleanup
              const newTimers = new Map(t.flashTimers);
              Object.keys(newFlashes).forEach((cellKey) => {
                const existing = newTimers.get(cellKey);
                if (existing) clearTimeout(existing);
                newTimers.set(
                  cellKey,
                  setTimeout(() => {
                    setTabs((prev2) =>
                      prev2.map((t2) => {
                        if (t2.id !== tabId) return t2;
                        const next = { ...t2.flashes };
                        delete next[cellKey];
                        return { ...t2, flashes: next, flashesRef: { ...t2.flashesRef, ...next } };
                      })
                    );
                  }, 1500)
                );
              });

              const mergedFlashes = { ...flashRef, ...newFlashes };
              return {
                ...t,
                result: data.result,
                flashes: mergedFlashes,
                flashesRef: mergedFlashes,
                prevValues: prevMap,
                flashTimers: newTimers,
              };
            })
          );
        }
      };

      es.onerror = () => {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? { ...t, error: "Stream disconnected.", running: false, loading: false, status: "Disconnected" }
              : t
          )
        );
        es.close();
      };
    } catch (err) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, error: String(err), loading: false, status: "Error" }
            : t
        )
      );
    }
  }, [savedMarkets, capital]);

  const addTab = useCallback(() => {
    if (!selectedMarket) return;
    if (tabs.length >= MAX_TABS) return;
    // Don't add duplicate tabs for the same market
    if (tabs.some((t) => t.marketId === selectedMarket.id)) {
      setActiveTabId(tabs.find((t) => t.marketId === selectedMarket.id)!.id);
      return;
    }
    tabCounterRef.current += 1;
    const tabId = `tab-${tabCounterRef.current}`;
    const newTab: TabState = {
      id: tabId,
      marketId: selectedMarket.id,
      marketTitle: selectedMarket.eventTitle,
      running: false,
      loading: false,
      error: "",
      status: "Idle",
      result: null,
      eventSource: null,
      flashes: {},
      flashesRef: {},
      prevValues: new Map(),
      flashTimers: new Map(),
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
    // Auto-start the new tab
    setTimeout(() => startTab(tabId), 50);
  }, [selectedMarket, tabs, startTab]);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) || null, [tabs, activeTabId]);

  const fmt = (n: number | null) => (n === null ? "—" : n.toFixed(4));
  const fmtUsd = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const roiColor = (roi: number) => (roi > 0 ? "text-[#5DBE81]" : "text-[#FFFFFF]");
  const strategyColor = (s: string) => (s !== "No arb" ? "text-[#5DBE81]" : "text-[#FFFFFF]");

  return (
    <div className="space-y-5">
      {/* Header / Controls */}
      <div className="rounded-xl border border-[#182533] bg-[#17212B] p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-5 h-5 text-[#5DBE81]" />
          <h2 className="text-sm font-bold text-[#FFFFFF]">Live WebSocket Scanner</h2>
          <span className="ml-auto text-xs px-2 py-1 rounded-full bg-[#182533] text-[#5E6875]">
            {tabs.filter((t) => t.running).length} active
          </span>
        </div>

        <div className="mb-4">
          <label className="block text-xs font-medium text-[#8A9BA8] mb-2">Select saved market</label>
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg bg-[#182533] border border-[#232E3C] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
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
              <div className="absolute z-20 mt-1 w-full rounded-lg border border-[#232E3C] bg-[#182533] shadow-lg">
                {/* Search input */}
                <div className="relative border-b border-[#232E3C]">
                  <input
                    ref={searchInputRef}
                    type="text"
                    placeholder="Search markets..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setFocusedIdx(-1);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setDropdownOpen(false);
                        setSearchQuery("");
                        setFocusedIdx(-1);
                      } else if (e.key === "Enter" && focusedIdx >= 0 && filteredOptions[focusedIdx]) {
                        const m = filteredOptions[focusedIdx];
                        setSelectedId(m.id);
                        setDropdownOpen(false);
                        setSearchQuery("");
                        setFocusedIdx(-1);
                      } else if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setFocusedIdx((prev) =>
                          prev < filteredOptions.length - 1 ? prev + 1 : 0
                        );
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setFocusedIdx((prev) =>
                          prev > 0 ? prev - 1 : filteredOptions.length - 1
                        );
                      }
                    }}
                    className="w-full bg-transparent text-sm text-[#FFFFFF] placeholder-[#5E6875] px-3 py-2.5 outline-none"
                    autoFocus
                  />
                  {searchQuery && (
                    <button
                      onClick={() => {
                        setSearchQuery("");
                        setFocusedIdx(-1);
                        searchInputRef.current?.focus();
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[#5E6875] hover:text-[#FFFFFF] transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {/* Market list */}
                <div
                  ref={listRef}
                  className="max-h-60 overflow-y-auto"
                  onMouseMove={() => setFocusedIdx(-1)}
                >
                  {filteredOptions.length === 0 ? (
                    <div className="px-3 py-2.5 text-xs text-[#5E6875]">No markets found.</div>
                  ) : (
                    filteredOptions.map((m, idx) => {
                      const roi = m.roiPct;
                      const isPositive = roi > 0;
                      const isFocused = idx === focusedIdx;
                      return (
                        <button
                          key={m.id}
                          ref={isFocused ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                          onClick={() => {
                            setSelectedId(m.id);
                            setDropdownOpen(false);
                            setSearchQuery("");
                            setFocusedIdx(-1);
                          }}
                          className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors ${
                            isFocused
                              ? "bg-[#232E3C]"
                              : selectedId === m.id
                                ? "bg-[#5DBE81]/10"
                                : "hover:bg-[#232E3C]"
                          }`}
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
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={addTab}
            disabled={!selectedMarket || tabs.length >= MAX_TABS}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#5DBE81] text-black font-semibold text-sm hover:bg-[#4DA66E] transition-all disabled:opacity-50"
            title={tabs.length >= MAX_TABS ? `Max ${MAX_TABS} tabs` : "Start Live Scan"}
          >
            <Play className="w-4 h-4" />
            Start Live Scan
          </button>
          {tabs.length >= MAX_TABS && (
            <span className="text-xs text-[#ef4444]">Max {MAX_TABS} tabs</span>
          )}
        </div>
      </div>

      {/* Tab bar */}
      {tabs.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const roi = tab.result
              ? Math.max(...tab.result.outcomes.map((o) => o.roiPct))
              : (savedMarkets.find((m) => m.id === tab.marketId)?.lastScanResult?.bestRoiPct ?? 0);
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-xs font-medium transition-colors shrink-0 ${
                  isActive
                    ? "bg-[#17212B] border-t border-l border-r border-[#182533] text-[#FFFFFF]"
                    : "bg-[#121E2B] border border-[#182533] text-[#5E6875] hover:text-[#FFFFFF]"
                }`}
              >
                <span className="truncate max-w-[120px]">{tab.marketTitle}</span>
                <span className={`text-[10px] ${roi > 0 ? "text-[#5DBE81]" : "text-[#5E6875]"}`}>
                  {roi > 0 ? `+${roi.toFixed(1)}%` : ""}
                </span>
                {tab.running && <span className="w-1.5 h-1.5 rounded-full bg-[#5DBE81] animate-pulse" />}
                <X
                  className="w-3 h-3 ml-0.5 hover:text-[#ef4444]"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Active tab content */}
      {activeTab && (
        <div className="rounded-xl border border-[#182533] bg-[#17212B] p-5">
          {/* Per-tab controls */}
          <div className="flex items-center gap-3 mb-4">
            <h3 className="text-sm font-bold text-[#FFFFFF] truncate flex-1">{activeTab.marketTitle}</h3>
            {!activeTab.running ? (
              <button
                onClick={() => startTab(activeTab.id)}
                disabled={activeTab.loading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#5DBE81] text-black font-semibold text-xs hover:bg-[#4DA66E] transition-all disabled:opacity-50"
              >
                {activeTab.loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {activeTab.loading ? "Starting..." : "Start"}
              </button>
            ) : (
              <button
                onClick={() => stopTab(activeTab.id)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#ef4444]/20 text-[#ef4444] border border-[#ef4444]/30 font-semibold text-xs hover:bg-[#ef4444]/30 transition-all"
              >
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            )}
            <span className="text-xs text-[#5E6875]">{activeTab.status}</span>
            {activeTab.result && (
              <span className="text-xs text-[#5E6875]">
                Last update: {new Date(activeTab.result.lastUpdate).toLocaleTimeString()}
              </span>
            )}
          </div>

          {activeTab.error && (
            <div className="mb-3 flex items-center gap-2 text-sm text-[#ef4444]">
              <AlertCircle className="w-4 h-4" /> {activeTab.error}
            </div>
          )}

          {/* Outcomes Table */}
          {activeTab.result && activeTab.result.outcomes.length > 0 && (
            <>
              <h3 className="text-sm font-bold text-[#FFFFFF] mb-3">
                Matched Outcomes ({activeTab.result.outcomes.length})
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
                    {activeTab.result.outcomes.map((o, idx) => (
                      <tr
                        key={`${o.artist}-${idx}`}
                        className="border-b border-[#182533]/50 hover:bg-[#182533] transition-colors"
                      >
                        <td className="py-2 px-2 text-[#FFFFFF] font-medium">{o.artist}</td>
                        <FlashCell flash={activeTab.flashes[`${idx}-kYes`]} className="py-2 px-2 text-right text-[#5DBE81] font-mono">
                          {fmt(o.kalshiYesAsk)}
                        </FlashCell>
                        <FlashCell flash={activeTab.flashes[`${idx}-kNo`]} className="py-2 px-2 text-right text-[#5DBE81] font-mono">
                          {fmt(o.kalshiNoAsk)}
                        </FlashCell>
                        <FlashCell flash={activeTab.flashes[`${idx}-pmYes`]} className="py-2 px-2 text-right text-[#a855f7] font-mono">
                          {fmt(o.pmYesAsk)}
                        </FlashCell>
                        <FlashCell flash={activeTab.flashes[`${idx}-pmNo`]} className="py-2 px-2 text-right text-[#a855f7] font-mono">
                          {fmt(o.pmNoAsk)}
                        </FlashCell>
                        <FlashCell flash={activeTab.flashes[`${idx}-spread`]} className="py-2 px-2 text-right font-mono text-[#FFFFFF]">
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
                        <FlashCell flash={activeTab.flashes[`${idx}-roi`]} className={`py-2 px-2 text-right font-mono font-bold ${roiColor(o.roiPct)}`}>
                          {o.roiPct > 0 ? `+${o.roiPct.toFixed(2)}%` : `${o.roiPct.toFixed(2)}%`}
                        </FlashCell>
                        <FlashCell flash={activeTab.flashes[`${idx}-profit`]} className={`py-2 px-2 text-right font-mono font-bold ${o.expectedProfit > 0 ? "text-[#5DBE81]" : "text-[#FFFFFF]"}`}>
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
                  const positiveArbs = activeTab.result.outcomes.filter((o) => o.roiPct > 0);
                  const bestRoi = positiveArbs.length > 0
                    ? Math.max(...positiveArbs.map((o) => o.roiPct))
                    : 0;
                  const totalProfit = activeTab.result.outcomes.reduce((s, o) => s + o.expectedProfit, 0);
                  return (
                    <>
                      <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                        <div className="text-[10px] text-[#5E6875]">Total Outcomes</div>
                        <div className="text-lg font-bold text-[#FFFFFF]">{activeTab.result.outcomes.length}</div>
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
            </>
          )}

          {activeTab.result && activeTab.result.outcomes.length === 0 && !activeTab.error && (
            <div className="text-sm text-[#5E6875] py-8 text-center">No matched outcomes found for this market.</div>
          )}
        </div>
      )}
    </div>
  );
}
