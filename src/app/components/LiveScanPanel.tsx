"use client";

import React, { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Play, Square, Activity, RefreshCw, AlertCircle, ChevronDown, X, Zap } from "lucide-react";
import { SavedMarket } from "@/lib/persistence";
import { ExecuteArbModal, buildExecutableArb, type ExecutableArb } from "@/app/components/ExecuteArbModal";
import { DepthHeatmap } from "@/app/components/DepthHeatmap";
import { ArbDecayCurve } from "@/app/components/ArbDecayCurve";
import { analyzeLiquidity } from "@/lib/liquidity-sizing";
import { parseArbLegs, LegBreakdown, ArbTypeBadge } from "@/app/components/ArbLegBreakdown";
import { ProfitDistributionPanel } from "@/app/components/ProfitDistributionPanel";
import { formatPrice } from "@/app/lib/page-shared";
import { TrendingUp } from "lucide-react";

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
  /** Available contracts at the exact live ask displayed for each side. */
  kalshiYesAskShares: number;
  kalshiNoAskShares: number;
  pmYesAskShares: number;
  pmNoAskShares: number;
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
  /** True when any underlying orderbook is missing or older than the staleness threshold (30s). */
  stale?: boolean;
  lastUpdate: string;
  /** HOOKUP-04: leg identifiers for manual execution. */
  kalshiTicker?: string;
  pmYesTokenId?: string;
  pmNoTokenId?: string;
  /** HOOKUP-02 (FEAT-004): likelihood-to-last rating attached server-side. */
  persistence?: {
    score: number;
    level: "stable" | "moderate" | "volatile";
    interpretation: string;
  };
  /** HOOKUP-03 (FEAT-005): arb-formation signal attached server-side. */
  formation?: {
    signal: "FORMING" | "STABLE" | "DIVERGING";
    minutesToArb: number | null;
    predictedSpread: number;
    kalshiVelocity1min: number;
    pmVelocity1min: number;
    isSpike: boolean;
  };
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
  /** UI-14: expanded artist for leg breakdown */
  expandedArtist: string | null;
}

const MAX_TABS = 8;

/* ── Main component ─────────────────────────────────────────────── */

export default function LiveScanPanel({ capital, savedMarkets }: Props) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  const [executingArb, setExecutingArb] = useState<ExecutableArb | null>(null);
  const tabCounterRef = useRef(0);
  const tabsRef = useRef<TabState[]>([]);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

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
          expandedArtist: null,
        };
      })
    );

    // Need to read the updated tab state — use a ref or re-read.
    // NOTE: tabId is the React-generated key ("tab-1"), NOT the market ID.
    // Look up the market by the tab's marketId instead.
    const tab = tabsRef.current?.find((t) => t.id === tabId);
    const lookupMarketId = tab?.marketId || tabId;
    const market = savedMarkets.find((m) => m.id === lookupMarketId);
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
      params.set("marketId", market.id); // HOOKUP-02: keys historical lifespan for persistence score
      const es = new EventSource(`/api/ws/live-scan?${params.toString()}`);

      es.onopen = () => {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? { ...t, loading: false, running: true, status: "Streaming live prices", error: "", eventSource: es }
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
        // EventSource fires onerror for transient issues (proxy timeouts,
        // network blips, browser connection management). The stream may
        // still be alive on the server side. Instead of immediately killing
        // the connection, check if readyState is CLOSED (fatal) vs
        // CONNECTING (browser is auto-reconnecting).
        if (es.readyState === EventSource.CLOSED) {
          // Fatal — server closed the connection
          setTabs((prev) =>
            prev.map((t) =>
              t.id === tabId
                ? { ...t, error: "Stream disconnected.", running: false, loading: false, status: "Disconnected" }
                : t
            )
          );
          es.close();
        } else {
          // readyState === CONNECTING — browser is auto-reconnecting.
          // Update status but DON'T close the EventSource. The browser
          // will retry automatically and onmessage will fire again if it
          // reconnects.
          setTabs((prev) =>
            prev.map((t) =>
              t.id === tabId
                ? { ...t, status: "Reconnecting...", loading: true }
                : t
            )
          );
        }
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
      expandedArtist: null,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
    // Auto-start the new tab
    setTimeout(() => startTab(tabId), 50);
  }, [selectedMarket, tabs, startTab]);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) || null, [tabs, activeTabId]);

  const fmt = (n: number | null) => formatPrice(n);
  const fmtUsd = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const roiColor = (roi: number) => (roi > 0 ? "text-[#5DBE81]" : roi < 0 ? "text-[#ef4444]" : "text-[#FFFFFF]");
  const strategyColor = (s: string) => (s !== "No arb" ? "text-[#5DBE81]" : "text-[#FFFFFF]");

  // UI-14: Toggle leg breakdown expansion for a row in the active tab
  const toggleExpandedArtist = useCallback((artist: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { ...t, expandedArtist: t.expandedArtist === artist ? null : artist }
          : t,
      ),
    );
  }, [activeTabId]);

  return (
    <div className="space-y-5">
      {/* Header / Controls */}
      <div className="rounded-xl border border-[#182533] bg-[#17212B] p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-5 h-5 text-[#5DBE81]" />
          <h2 className="text-sm font-bold text-[#FFFFFF]">Live WebSocket Scanner</h2>
          <span className="ml-auto text-xs px-2 py-1 rounded-full bg-[#182533] text-[#8A9BA8]">
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
                  <span className={`text-xs font-medium ${(selectedMarket.lastScanResult?.bestRoiPct ?? 0) > 0 ? "text-[#5DBE81]" : (selectedMarket.lastScanResult?.bestRoiPct ?? 0) < 0 ? "text-[#ef4444]" : "text-[#8A9BA8]"}`}>
                    {(() => {
                      const roi = selectedMarket.lastScanResult?.bestRoiPct ?? 0;
                      return `${roi > 0 ? "+" : ""}${roi.toFixed(1)}%`;
                    })()}
                  </span>
                </span>
              ) : (
                <span className="text-[#8A9BA8]">Choose a market...</span>
              )}
              <ChevronDown className={`w-4 h-4 text-[#8A9BA8] transition-transform ${dropdownOpen ? "rotate-180" : ""}`} />
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
                    className="w-full bg-transparent text-sm text-[#FFFFFF] placeholder-[#8A9BA8] px-3 py-2.5 outline-none"
                    autoFocus
                  />
                  {searchQuery && (
                    <button
                      onClick={() => {
                        setSearchQuery("");
                        setFocusedIdx(-1);
                        searchInputRef.current?.focus();
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8A9BA8] hover:text-[#FFFFFF] transition-colors"
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
                    <div className="px-3 py-2.5 text-xs text-[#8A9BA8]">No markets found.</div>
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
                          <span className={`shrink-0 text-xs font-medium ${isPositive ? "text-[#5DBE81]" : "text-[#8A9BA8]"}`}>
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
          {selectedMarket && (
            <div className="flex items-center gap-2">
              {selectedMarket.kalshiUrl && (
                <a
                  href={selectedMarket.kalshiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#182533] text-[#8A9BA8] text-xs font-medium hover:text-[#5DBE81] hover:bg-[#232E3C] transition-colors"
                  title="Open in Kalshi"
                >
                  <img src="/kalshi-icon.png" alt="Kalshi" className="w-3.5 h-3.5 rounded-sm" />
                  Kalshi
                </a>
              )}
              {selectedMarket.polymarketUrl && (
                <a
                  href={selectedMarket.polymarketUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#182533] text-[#8A9BA8] text-xs font-medium hover:text-[#5DBE81] hover:bg-[#232E3C] transition-colors"
                  title="Open in Polymarket"
                >
                  <img src="/polymarket-icon.png" alt="Polymarket" className="w-3.5 h-3.5 rounded-sm" />
                  Polymarket
                </a>
              )}
            </div>
          )}
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
                    : "bg-[#121E2B] border border-[#182533] text-[#8A9BA8] hover:text-[#FFFFFF]"
                }`}
              >
                <span className="truncate max-w-[120px]">{tab.marketTitle}</span>
                <span className={`text-[10px] ${roi > 0 ? "text-[#5DBE81]" : "text-[#8A9BA8]"}`}>
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
            <span className="text-xs text-[#8A9BA8]">{activeTab.status}</span>
            {activeTab.result && (
              <span className="text-xs text-[#8A9BA8]">
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
                      <th className="text-left py-2 px-2 text-[#8A9BA8] font-medium">OUTCOME</th>
                      <th className="text-right py-2 px-2 text-[#8A9BA8] font-medium"><span className="inline-flex items-center gap-1 flex-row-reverse"><img src="/kalshi-icon.png" alt="Kalshi" className="w-3 h-3 rounded-sm" />Yes</span></th>
                      <th className="text-right py-2 px-2 text-[#8A9BA8] font-medium"><span className="inline-flex items-center gap-1 flex-row-reverse"><img src="/kalshi-icon.png" alt="Kalshi" className="w-3 h-3 rounded-sm" />No</span></th>
                      <th className="text-right py-2 px-2 text-[#8A9BA8] font-medium"><span className="inline-flex items-center gap-1 flex-row-reverse"><img src="/polymarket-icon.png" alt="Polymarket" className="w-3 h-3 rounded-sm" />Yes</span></th>
                      <th className="text-right py-2 px-2 text-[#8A9BA8] font-medium"><span className="inline-flex items-center gap-1 flex-row-reverse"><img src="/polymarket-icon.png" alt="Polymarket" className="w-3 h-3 rounded-sm" />No</span></th>
                      <th className="text-right py-2 px-2 text-[#8A9BA8] font-medium">SPREAD</th>
                      <th className="text-right py-2 px-2 text-[#8A9BA8] font-medium">ROI</th>
                      <th className="text-right py-2 px-2 text-[#8A9BA8] font-medium">PROFIT</th>
                      <th className="text-right py-2 px-2 text-[#8A9BA8] font-medium" title="Orderbook depth: how much capital can be deployed">DEPTH</th>
                      <th className="text-right py-2 px-2 text-[#8A9BA8] font-medium" title="Persistence: likelihood the arb lasts (depth, velocity, history)">PERSIST</th>
                      <th className="text-center py-2 px-2 text-[#8A9BA8] font-medium" title="Arb formation signal from price velocity: FORMING = spread converging toward arb, DIVERGING = moving away, quiet = stable">SIGNAL</th>
                      <th className="text-right py-2 px-2 text-[#8A9BA8] font-medium" title="Per-episode ROI trajectory: is THIS specific arb opportunity peaking or fading?">DECAY</th>
                      <th className="text-left py-2 px-2 text-[#8A9BA8] font-medium">ARB TYPE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeTab.result.outcomes.map((o, idx) => {
                      const isRowExpanded = activeTab.expandedArtist === o.artist;
                      return (
                      <React.Fragment key={`${o.artist}-${idx}`}>
                      <tr
                        className={`border-b border-[#182533]/50 transition-colors cursor-pointer ${
                          isRowExpanded ? "bg-[#182533]/30" : ""
                        } ${
                          o.stale
                            ? "opacity-40 grayscale hover:opacity-60"
                            : "hover:bg-[#182533]"
                        }`}
                        title={o.stale ? "Stale: orderbook data older than 30s — prices may be wrong" : undefined}
                        onClick={() => toggleExpandedArtist(o.artist)}
                      >
                        <td className="py-2 px-2 text-[#FFFFFF] font-medium">
                          <span className="inline-flex items-center gap-1.5">
                            <span className={`transition-transform text-[#8A9BA8] text-[10px] ${isRowExpanded ? "rotate-90" : ""}`}>▶</span>
                            {o.artist}
                            {o.stale && (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#5E6875]/30 text-[#8A9BA8] uppercase tracking-wide">
                                Stale
                              </span>
                            )}
                          </span>
                        </td>
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
                        <td className="py-2 px-2 text-right">
                          {(() => {
                            // UI-10: Hide stake/depth for negative-arb rows — no point showing
                            // deployable capital when there's no profitable arb.
                            if (o.roiPct <= 0) return <span className="text-[#8A9BA8]">—</span>;
                            // Compute liquidity from the numeric depth fields already on the outcome
                            const kDepth = Math.max(o.kalshiYesDepth, o.kalshiNoDepth) || 0;
                            const pmDepth = (o.pmYesDepth > 0 || o.pmNoDepth > 0)
                              ? Math.max(o.pmYesDepth, o.pmNoDepth)
                              : Infinity;
                            const totalStake = (o.kalshiStake ?? 0) + (o.pmStake ?? 0);
                            const feeRates = {
                              kalshiFee: totalStake > 0 && o.fees ? o.fees.kalshiFee / totalStake : 0,
                              pmFee: totalStake > 0 && o.fees ? o.fees.pmFee / totalStake : 0,
                            };
                            const liq = analyzeLiquidity(
                              o.kalshiYesAsk ?? 0,
                              kDepth,
                              o.pmYesAsk ?? 0,
                              pmDepth,
                              o.kalshiNoAsk ?? 0,
                              o.pmNoAsk ?? 0,
                              feeRates,
                            );
                            return (
                              <DepthHeatmap
                                maxFillableStake={liq.maxFillableStake}
                                slippageEstimate={liq.slippageEstimate}
                                warningLevel={liq.warningLevel}
                                kalshiDepth={liq.kalshiDepth}
                                polymarketDepth={liq.polymarketDepth}
                                compact
                              />
                            );
                          })()}
                        </td>
                        <td className="py-2 px-2 text-right font-mono" title={o.persistence?.interpretation ?? "Persistence score: needs a few ticks of history"}>
                          {o.persistence && o.roiPct > 0 ? (
                            <span className={`font-bold ${o.persistence.score >= 70 ? "text-[#5DBE81]" : o.persistence.score >= 40 ? "text-[#facc15]" : "text-[#ef4444]"}`}>
                              {o.persistence.score}
                            </span>
                          ) : (
                            <span className="text-[#8A9BA8]">—</span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-center" title={o.formation ? `Predicted spread in 1 min: ${(o.formation.predictedSpread * 100).toFixed(2)}% · K vel ${(o.formation.kalshiVelocity1min * 100).toFixed(2)}¢/min · PM vel ${(o.formation.pmVelocity1min * 100).toFixed(2)}¢/min${o.formation.minutesToArb != null ? ` · ~${o.formation.minutesToArb} min to arb` : ""}` : "Formation signal: needs a few ticks of history"}>
                          {o.formation && o.formation.signal !== "STABLE" ? (
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide ${o.formation.signal === "FORMING" ? "bg-[#5DBE81]/20 text-[#5DBE81]" : "bg-[#ef4444]/20 text-[#ef4444]"}`}>
                              {o.formation.signal === "FORMING" && o.formation.minutesToArb != null && o.formation.minutesToArb <= 30
                                ? `FORMING ~${o.formation.minutesToArb}m`
                                : o.formation.signal}
                            </span>
                          ) : (
                            <span className="text-[#8A9BA8] text-[10px]">·</span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right">
                          {o.roiPct > 0 ? <ArbDecayCurve marketId={activeTab.marketId} outcome={o.artist} /> : <span className="text-[#8A9BA8] text-xs">—</span>}
                        </td>
                        <td className={`py-2 px-2 text-left font-medium ${strategyColor(o.strategy)}`}>
                          {(() => {
                            if (o.strategy === 'No arb') {
                              return <span className="text-[#FFFFFF]">No arb</span>;
                            }
                            return (
                              <span className="inline-flex items-center gap-1.5">
                                <ArbTypeBadge strategy={o.strategy} arbType={(o as any).arbType} onClick={() => toggleExpandedArtist(o.artist)} />
                                {(() => {
                                  if (o.stale || o.roiPct <= 0) return null;
                                  const exec = buildExecutableArb(o, activeTab.marketTitle);
                                  if (!exec) return null;
                                  return (
                                    <span className="flex flex-col items-center">
                                      <span className="text-[8px] uppercase tracking-wider text-[#8A9BA8] mb-0.5">Action</span>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); setExecutingArb(exec); }}
                                        className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-[#facc15]/20 text-[#facc15] hover:bg-[#facc15]/40 transition-colors inline-flex items-center gap-1"
                                        title="Manually execute this arb (opens confirmation)"
                                      >
                                        <Zap className="w-2.5 h-2.5" /> Execute
                                      </button>
                                    </span>
                                  );
                                })()}
                              </span>
                            );
                          })()}
                        </td>
                      </tr>
                      {/* UI-14: Expanded leg breakdown */}
                      {isRowExpanded && o.strategy !== 'No arb' && (() => {
                        const breakdown = parseArbLegs(
                          o.strategy,
                          o.artist,
                          o.kalshiYesAsk,
                          o.kalshiNoAsk,
                          o.pmYesAsk,
                          o.pmNoAsk,
                          o.kalshiStake,
                          o.pmStake,
                          o.fees,
                          o.expectedProfit,
                        );
                        const exec = buildExecutableArb(o, activeTab.marketTitle);
                        const supportedStrategy = o.strategy === 'Buy YES Kalshi + NO PM' || o.strategy === 'Buy YES PM + NO Kalshi';
                        return (
                          <tr className="bg-[#17212B]/50">
                            <td colSpan={13} className="px-4 py-3">
                              {exec ? (
                                <div className="mb-3 rounded-lg border border-[#5DBE81]/30 bg-[#5DBE81]/10 px-3 py-2.5 text-xs">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="font-bold text-[#5DBE81]">Live executable liquidity: {exec.shares.toLocaleString()} matched shares</span>
                                    <span className="text-[#8A9BA8]">Hedged 1:1 · limited by {exec.limitingConstraint}</span>
                                  </div>
                                  <div className="mt-1.5 grid gap-1 font-mono text-[11px] text-[#D5DEE7] sm:grid-cols-2">
                                    <span>Kalshi {exec.kalshiOrder.outcome.toUpperCase()} @ {formatPrice(exec.kalshiOrder.price)} · {exec.shares.toLocaleString()} shares · {fmtUsd(exec.kalshiOrder.size)}</span>
                                    <span>Polymarket {exec.polymarketOrder.outcome.toUpperCase()} @ {formatPrice(exec.polymarketOrder.price)} · {exec.shares.toLocaleString()} shares · {fmtUsd(exec.polymarketOrder.size)}</span>
                                  </div>
                                </div>
                              ) : (
                                <div className="mb-3 rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 px-3 py-2.5 text-xs text-[#ef4444]">
                                  Live executable liquidity is unavailable: one or both selected orderbook levels are stale, empty, or invalid.
                                </div>
                              )}
                              <div className="flex items-center gap-6 text-xs mb-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-[#8A9BA8]">Total Stake:</span>
                                  <span className="font-bold text-[#FFFFFF]">{fmtUsd((o.kalshiStake ?? 0) + (o.pmStake ?? 0))}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-[#8A9BA8]">K:</span>
                                  <span className="text-[#5DBE81]">{fmtUsd(o.kalshiStake ?? 0)}</span>
                                  <span className="text-[#8A9BA8]">|</span>
                                  <span className="text-[#8A9BA8]">PM:</span>
                                  <span className="text-[#a855f7]">{fmtUsd(o.pmStake ?? 0)}</span>
                                </div>
                              </div>
                              <LegBreakdown breakdown={breakdown} formatCurrency={fmtUsd} />
                              {exec && supportedStrategy && (
                                <ProfitDistributionPanel
                                  strategy={o.strategy as 'Buy YES Kalshi + NO PM' | 'Buy YES PM + NO Kalshi'}
                                  kalshiPrice={exec.kalshiOrder.price}
                                  pmPrice={exec.polymarketOrder.price}
                                  kalshiStake={exec.kalshiOrder.size}
                                  pmStake={exec.polymarketOrder.size}
                                  category={(o as { category?: string }).category}
                                  kalshiWinLabel={`Kalshi ${exec.kalshiOrder.outcome.toUpperCase()}`}
                                  pmWinLabel={`Polymarket ${exec.polymarketOrder.outcome.toUpperCase()}`}
                                  formatCurrency={fmtUsd}
                                  onChange={() => undefined}
                                />
                              )}
                            </td>
                          </tr>
                        );
                      })()}
                      </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Summary stats */}
              <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
                {(() => {
                  // Stale outcomes are excluded from stats — a grayed-out row
                  // is honest, a stale number in "Best ROI" is a wrong number.
                  const fresh = activeTab.result.outcomes.filter((o) => !o.stale);
                  const staleCount = activeTab.result.outcomes.length - fresh.length;
                  const positiveArbs = fresh.filter((o) => o.roiPct > 0);
                  // UI-03: Best net ROI includes negative values so Victor can see
                  // how close a pair is to being profitable.
                  const netArbs = fresh.filter((o) => o.strategy !== 'No arb');
                  const bestRoi = netArbs.length > 0
                    ? Math.max(...netArbs.map((o) => o.roiPct))
                    : 0;
                  const totalProfit = fresh.reduce((s, o) => s + o.expectedProfit, 0);
                  return (
                    <>
                      <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                        <div className="text-[10px] text-[#8A9BA8]">Total Outcomes</div>
                        <div className="text-lg font-bold text-[#FFFFFF]">
                          {activeTab.result.outcomes.length}
                          {staleCount > 0 && (
                            <span className="ml-1.5 text-[10px] font-medium text-[#8A9BA8] align-middle">({staleCount} stale)</span>
                          )}
                        </div>
                      </div>
                      <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                        <div className="text-[10px] text-[#8A9BA8]">Positive Arbs</div>
                        <div className={`text-lg font-bold ${positiveArbs.length > 0 ? "text-[#5DBE81]" : "text-[#FFFFFF]"}`}>{positiveArbs.length}</div>
                      </div>
                      <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                        <div className="text-[10px] text-[#8A9BA8]">Best ROI</div>
                        <div className={`text-lg font-bold ${bestRoi > 0 ? "text-[#5DBE81]" : bestRoi < 0 ? "text-[#ef4444]" : "text-[#FFFFFF]"}`}>
                          {bestRoi > 0 ? `+${bestRoi.toFixed(2)}%` : `${bestRoi.toFixed(2)}%`}
                        </div>
                      </div>
                      <div className="rounded-lg bg-[#121E2B] p-3 border border-[#182533]">
                        <div className="text-[10px] text-[#8A9BA8]">Combined Profit</div>
                        <div className={`text-lg font-bold ${totalProfit > 0 ? "text-[#5DBE81]" : "text-[#FFFFFF]"}`}>
                          {fmtUsd(totalProfit)}
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* UI-16: Arb Opportunities — always-visible section below outcomes table */}
              {(() => {
                const arbOpps = activeTab.result.outcomes
                  .filter(o => !o.stale && o.expectedProfit > 0 && o.roiPct > 0)
                  .sort((a, b) => b.roiPct - a.roiPct);
                if (arbOpps.length === 0) {
                  return (
                    <div className="mt-4 rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
                      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#182533]">
                        <TrendingUp className="w-4 h-4 text-[#5DBE81]" />
                        <h3 className="text-sm font-semibold text-[#FFFFFF]">Arb Opportunities</h3>
                        <span className="text-[10px] text-[#8A9BA8]">(0)</span>
                      </div>
                      <div className="px-4 py-8 text-center text-xs text-[#8A9BA8]">
                        No active arbitrage opportunities
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="mt-4 rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-3 border-b border-[#182533]">
                      <TrendingUp className="w-4 h-4 text-[#facc15]" />
                      <h3 className="text-sm font-semibold text-[#FFFFFF]">Arb Opportunities</h3>
                      <span className="text-[10px] text-[#8A9BA8]">({arbOpps.length})</span>
                      <span className="text-[10px] text-[#5E6875] ml-auto">Sorted by ROI ↓</span>
                    </div>
                    <div className="divide-y divide-[#182533]">
                      {arbOpps.map((o, idx) => {
                        const breakdown = parseArbLegs(
                          o.strategy,
                          o.artist,
                          o.kalshiYesAsk,
                          o.kalshiNoAsk,
                          o.pmYesAsk,
                          o.pmNoAsk,
                          o.kalshiStake,
                          o.pmStake,
                          o.fees,
                          o.expectedProfit,
                        );

                        return (
                          <div key={`${idx}-${o.artist}`} className="px-4 py-3 hover:bg-[#0E1621] transition-colors">
                            <div className="flex items-center gap-3 flex-wrap">
                              <ArbTypeBadge strategy={o.strategy} arbType={(o as any).arbType} />
                              <div className="flex-1" />
                              <span className="text-xs font-bold text-[#5DBE81]" title="ROI (net of fees)">
                                {o.roiPct.toFixed(2)}%
                              </span>
                              <span className="text-xs text-[#5DBE81]" title="Expected profit (net of fees)">
                                {fmtUsd(o.expectedProfit)}
                              </span>
                              {(() => {
                                const exec = buildExecutableArb(o, activeTab.marketTitle);
                                if (!exec) return null;
                                return (
                                  <span className="flex flex-col items-center">
                                    <span className="text-[8px] uppercase tracking-wider text-[#8A9BA8] mb-0.5">Action</span>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setExecutingArb(exec); }}
                                      className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-[#facc15]/20 text-[#facc15] hover:bg-[#facc15]/40 transition-colors inline-flex items-center gap-1"
                                      title="Manually execute this arb (opens confirmation)"
                                    >
                                      <Zap className="w-2.5 h-2.5" /> Execute
                                    </button>
                                  </span>
                                );
                              })()}
                            </div>
                            {breakdown.legs.length > 0 && (
                              <div className="mt-2">
                                <LegBreakdown breakdown={breakdown} formatCurrency={fmtUsd} />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </>
          )}

          {activeTab.result && activeTab.result.outcomes.length === 0 && !activeTab.error && (
            <div className="text-sm text-[#8A9BA8] py-8 text-center">No matched outcomes found for this market.</div>
          )}
        </div>
      )}

      {/* HOOKUP-04: manual execution confirmation modal */}
      {executingArb && (
        <ExecuteArbModal arb={executingArb} onClose={() => setExecutingArb(null)} />
      )}
    </div>
  );
}
