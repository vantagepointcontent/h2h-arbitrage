"use client";

import { useState, useEffect, useCallback } from "react";
import { Link2, Unlink, X, Plus, Check, Loader2, ChevronRight } from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────

interface CoupledPair {
  kalshiTicker: string;
  kalshiTitle: string;
  pmConditionId: string;
  pmTitle: string;
  source: "auto" | "manual";
  matchId?: string; // manual match ID for unlink
}

interface AvailableMarket {
  ticker?: string;
  conditionId?: string;
  title: string;
  platform: "kalshi" | "polymarket";
}

interface DecoupledPair {
  id: string;
  kalshiTicker: string;
  pmConditionId: string;
  kalshiTitle: string;
  pmTitle: string;
}

interface CouplingPanelProps {
  open: boolean;
  onClose: () => void;
  outcomes: any[];
  unmatchedKalshi: any[];
  unmatchedPolymarket: any[];
  manualMatches: any[];
  decoupledPairs: DecoupledPair[];
  onRescan: () => void;
  onDecouple: (kalshiTicker: string, pmConditionId: string, kalshiTitle: string, pmTitle: string) => Promise<void>;
  onRemoveManualMatch: (matchId: string) => Promise<void>;
  onReconcple: (decoupledPairId: string) => Promise<void>;
  onCreateMatch: (kalshiTicker: string, pmConditionId: string, kalshiTitle: string, pmTitle: string) => Promise<void>;
}

// ─── Component ──────────────────────────────────────────────────────────

export function CouplingPanel({
  open,
  onClose,
  outcomes,
  unmatchedKalshi,
  unmatchedPolymarket,
  manualMatches,
  decoupledPairs,
  onRescan,
  onDecouple,
  onRemoveManualMatch,
  onReconcple,
  onCreateMatch,
}: CouplingPanelProps) {
  const [activeTab, setActiveTab] = useState<"current" | "available" | "add">("current");
  const [editPair, setEditPair] = useState<string | null>(null);
  const [editKalshi, setEditKalshi] = useState<string | null>(null);
  const [editPm, setEditPm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newKalshi, setNewKalshi] = useState<string | null>(null);
  const [newPm, setNewPm] = useState<string | null>(null);

  // Build coupled pairs from outcomes
  const coupledPairs: CoupledPair[] = (outcomes || [])
    .filter((o: any) => o.kalshi && o.polymarket)
    .map((o: any) => {
      const manualMatch = manualMatches?.find(
        (mm: any) => mm.kalshiTicker === o.kalshi.ticker && mm.pmConditionId === o.polymarket.conditionId
      );
      return {
        kalshiTicker: o.kalshi.ticker,
        kalshiTitle: o.kalshi.ticker,
        pmConditionId: o.polymarket.conditionId,
        pmTitle: o.artist,
        source: manualMatch ? "manual" : "auto",
        matchId: manualMatch?.id,
      };
    });

  // Build available markets
  const availableKalshi: AvailableMarket[] = (unmatchedKalshi || []).map((k: any) => ({
    ticker: k.ticker,
    title: k.title || k.artist || k.ticker,
    platform: "kalshi" as const,
  }));

  const availablePm: AvailableMarket[] = (unmatchedPolymarket || []).map((p: any) => ({
    conditionId: p.conditionId,
    title: p.title || p.artist || p.conditionId?.slice(0, 12) + "...",
    platform: "polymarket" as const,
  }));

  // ── Actions ──

  const handleRemove = async (pair: CoupledPair) => {
    setBusy(`remove:${pair.kalshiTicker}`);
    try {
      if (pair.source === "manual" && pair.matchId) {
        await onRemoveManualMatch(pair.matchId);
      } else {
        // Auto-matched: add to decoupled pairs
        await onDecouple(pair.kalshiTicker, pair.pmConditionId, pair.kalshiTitle, pair.pmTitle);
      }
      onRescan();
    } finally {
      setBusy(null);
    }
  };

  const handleEditSave = async (pair: CoupledPair) => {
    if (!editKalshi || !editPm) return;
    setBusy(`edit:${pair.kalshiTicker}`);
    try {
      // 1. Remove old coupling
      if (pair.source === "manual" && pair.matchId) {
        await onRemoveManualMatch(pair.matchId);
      } else {
        await onDecouple(pair.kalshiTicker, pair.pmConditionId, pair.kalshiTitle, pair.pmTitle);
      }
      // 2. Create new manual match
      const k = availableKalshi.find(k => k.ticker === editKalshi);
      const p = availablePm.find(p => p.conditionId === editPm);
      if (k && p) {
        await onCreateMatch(k.ticker!, p.conditionId!, k.title, p.title);
      }
      onRescan();
      setEditPair(null);
      setEditKalshi(null);
      setEditPm(null);
    } finally {
      setBusy(null);
    }
  };

  const handleAddNew = async () => {
    if (!newKalshi || !newPm) return;
    setBusy("add");
    try {
      const k = availableKalshi.find(k => k.ticker === newKalshi);
      const p = availablePm.find(p => p.conditionId === newPm);
      if (k && p) {
        await onCreateMatch(k.ticker!, p.conditionId!, k.title, p.title);
        onRescan();
        setNewKalshi(null);
        setNewPm(null);
      }
    } finally {
      setBusy(null);
    }
  };

  const handleReconcple = async (dp: DecoupledPair) => {
    setBusy(`recouple:${dp.id}`);
    try {
      await onReconcple(dp.id);
      onRescan();
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop — click to close */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-14 bottom-0 z-50 w-[420px] bg-[#17212B] border-l border-[#182533] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#182533]">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-[#5DBE81]" />
            <h3 className="text-sm font-semibold text-[#FFFFFF]">Couplings</h3>
            <span className="text-[10px] text-[#5E6875]">
              ({coupledPairs.length} active)
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#182533] text-[#5E6875] transition-colors"
            title="Close panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-3 py-2 border-b border-[#182533]">
          {([
            { key: "current", label: "Current", count: coupledPairs.length },
            { key: "available", label: "Available", count: availableKalshi.length + availablePm.length },
            { key: "add", label: "Add New", count: null },
          ] as const).map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === tab.key
                  ? "bg-[#5DBE81]/15 text-[#5DBE81] ring-1 ring-[#5DBE81]/30"
                  : "text-[#5E6875] hover:text-[#FFFFFF] hover:bg-[#182533]"
              }`}
            >
              {tab.label}
              {tab.count !== null && (
                <span className="text-[9px] text-[#5E6875]">({tab.count})</span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3">
          {/* ── Current Couplings Tab ── */}
          {activeTab === "current" && (
            <div className="space-y-2">
              {coupledPairs.length === 0 ? (
                <div className="text-center py-8 text-sm text-[#5E6875]">
                  No active couplings. Run a scan to see matched pairs.
                </div>
              ) : (
                coupledPairs.map((pair, idx) => {
                  const pairKey = `${idx}-${pair.kalshiTicker}`;
                  const isEditing = editPair === pairKey;
                  const isBusy = busy === `remove:${pair.kalshiTicker}` || busy === `edit:${pair.kalshiTicker}`;

                  return (
                    <div
                      key={pairKey}
                      className={`rounded-lg border bg-[#0E1621] overflow-hidden transition-colors ${
                        isEditing ? "border-[#5DBE81]/30" : "border-[#182533]"
                      }`}
                    >
                      {/* Pair display */}
                      <div className="flex items-center gap-2 p-3">
                        <div className="flex-1 min-w-0 space-y-1.5">
                          {/* Kalshi side */}
                          <div className="flex items-center gap-1.5">
                            <div className="flex items-center justify-center w-4 h-4 rounded-sm bg-[#5DBE81] shrink-0">
                              <span className="text-[8px] font-bold text-[#FFFFFF]">K</span>
                            </div>
                            <span className="text-xs text-[#FFFFFF] truncate" title={pair.kalshiTitle}>
                              {pair.kalshiTitle}
                            </span>
                            {pair.source === "manual" && (
                              <span className="shrink-0 px-1 py-0.5 rounded text-[8px] bg-[#a855f7]/15 text-[#a855f7]">
                                manual
                              </span>
                            )}
                          </div>
                          {/* PM side */}
                          <div className="flex items-center gap-1.5">
                            <div className="flex items-center justify-center w-4 h-4 rounded-sm bg-[#a855f7] shrink-0">
                              <span className="text-[7px] font-bold text-[#FFFFFF]">PM</span>
                            </div>
                            <span className="text-xs text-[#FFFFFF] truncate" title={pair.pmTitle}>
                              {pair.pmTitle}
                            </span>
                          </div>
                        </div>

                        {/* Actions */}
                        {!isEditing && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => {
                                setEditPair(pairKey);
                                setEditKalshi(null);
                                setEditPm(null);
                              }}
                              disabled={isBusy}
                              className="p-1.5 rounded-md bg-[#182533] hover:bg-[#232E3C] text-[#8A9BA8] transition-colors disabled:opacity-50"
                              title="Edit coupling"
                            >
                              {busy === `edit:${pair.kalshiTicker}` ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <button
                              onClick={() => handleRemove(pair)}
                              disabled={isBusy}
                              className="p-1.5 rounded-md bg-[#ef4444]/10 hover:bg-[#ef4444]/20 text-[#ef4444] transition-colors disabled:opacity-50"
                              title={pair.source === "manual" ? "Unlink manual match" : "Decouple (prevent auto-match)"}
                            >
                              {busy === `remove:${pair.kalshiTicker}` ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Unlink className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Edit mode */}
                      {isEditing && (
                        <div className="border-t border-[#182533] p-3 space-y-2">
                          <div className="text-[10px] text-[#5E6875] uppercase tracking-wider">
                            Replace with:
                          </div>
                          {/* Kalshi selector */}
                          <div>
                            <label className="text-[10px] text-[#5DBE81] flex items-center gap-1 mb-1">
                              <div className="w-3 h-3 rounded-sm bg-[#5DBE81]" />
                              Kalshi market:
                            </label>
                            <select
                              value={editKalshi || ""}
                              onChange={(e) => setEditKalshi(e.target.value)}
                              className="w-full px-2 py-1.5 rounded-lg bg-[#182533] border border-[#232E3C] text-xs text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
                            >
                              <option value="">Select Kalshi market...</option>
                              {availableKalshi.map(k => (
                                <option key={k.ticker} value={k.ticker}>
                                  {k.title}
                                </option>
                              ))}
                            </select>
                          </div>
                          {/* PM selector */}
                          <div>
                            <label className="text-[10px] text-[#a855f7] flex items-center gap-1 mb-1">
                              <div className="w-3 h-3 rounded-sm bg-[#a855f7]" />
                              Polymarket market:
                            </label>
                            <select
                              value={editPm || ""}
                              onChange={(e) => setEditPm(e.target.value)}
                              className="w-full px-2 py-1.5 rounded-lg bg-[#182533] border border-[#232E3C] text-xs text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
                            >
                              <option value="">Select Polymarket market...</option>
                              {availablePm.map(p => (
                                <option key={p.conditionId} value={p.conditionId}>
                                  {p.title}
                                </option>
                              ))}
                            </select>
                          </div>
                          {/* Edit actions */}
                          <div className="flex items-center gap-2 pt-1">
                            <button
                              onClick={() => handleEditSave(pair)}
                              disabled={!editKalshi || !editPm || busy === `edit:${pair.kalshiTicker}`}
                              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#5DBE81] text-black text-xs font-semibold hover:bg-[#4DA66E] transition-colors disabled:opacity-50"
                            >
                              {busy === `edit:${pair.kalshiTicker}` ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Check className="w-3 h-3" />
                              )}
                              Save
                            </button>
                            <button
                              onClick={() => {
                                setEditPair(null);
                                setEditKalshi(null);
                                setEditPm(null);
                              }}
                              className="px-3 py-1.5 rounded-lg bg-[#182533] text-xs text-[#8A9BA8] hover:bg-[#232E3C] transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {/* Decoupled pairs section */}
              {decoupledPairs.length > 0 && (
                <div className="pt-3 mt-3 border-t border-[#182533]">
                  <div className="text-[10px] text-[#5E6875] uppercase tracking-wider mb-2">
                    Decoupled (auto-match blocked)
                  </div>
                  {decoupledPairs.map(dp => (
                    <div
                      key={dp.id}
                      className="flex items-center gap-2 p-2 mb-1 rounded-lg bg-[#0E1621] border border-[#182533] opacity-60"
                    >
                      <div className="flex-1 min-w-0 text-xs text-[#5E6875] truncate">
                        <span className="text-[#5DBE81]">K:</span> {dp.kalshiTitle} ↔{" "}
                        <span className="text-[#a855f7]">PM:</span> {dp.pmTitle}
                      </div>
                      <button
                        onClick={() => handleReconcple(dp)}
                        disabled={busy === `recouple:${dp.id}`}
                        className="p-1 rounded-md bg-[#182533] hover:bg-[#232E3C] text-[#8A9BA8] transition-colors"
                        title="Re-enable auto-match"
                      >
                        {busy === `recouple:${dp.id}` ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Plus className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Available Alternatives Tab ── */}
          {activeTab === "available" && (
            <div className="space-y-3">
              {availableKalshi.length === 0 && availablePm.length === 0 ? (
                <div className="text-center py-8 text-sm text-[#5E6875]">
                  No unmatched markets available. All markets are coupled.
                </div>
              ) : (
                <>
                  {/* Unmatched Kalshi */}
                  {availableKalshi.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1.5 mb-2">
                        <div className="w-3 h-3 rounded-sm bg-[#5DBE81]" />
                        <span className="text-[10px] text-[#5E6875] uppercase tracking-wider">
                          Unmatched Kalshi ({availableKalshi.length})
                        </span>
                      </div>
                      <div className="space-y-1">
                        {availableKalshi.map(k => (
                          <div
                            key={k.ticker}
                            className="px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533]"
                          >
                            <div className="text-xs text-[#FFFFFF] truncate">{k.title}</div>
                            <div className="text-[10px] text-[#5E6875] font-mono">{k.ticker}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Unmatched Polymarket */}
                  {availablePm.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1.5 mb-2">
                        <div className="w-3 h-3 rounded-sm bg-[#a855f7]" />
                        <span className="text-[10px] text-[#5E6875] uppercase tracking-wider">
                          Unmatched Polymarket ({availablePm.length})
                        </span>
                      </div>
                      <div className="space-y-1">
                        {availablePm.map(p => (
                          <div
                            key={p.conditionId}
                            className="px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533]"
                          >
                            <div className="text-xs text-[#FFFFFF] truncate">{p.title}</div>
                            <div className="text-[10px] text-[#5E6875] font-mono truncate">
                              {p.conditionId?.slice(0, 20)}...
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Add New Coupling Tab ── */}
          {activeTab === "add" && (
            <div className="space-y-3">
              {availableKalshi.length === 0 || availablePm.length === 0 ? (
                <div className="text-center py-8 text-sm text-[#5E6875]">
                  Need at least one unmatched market on each platform to create a new coupling.
                </div>
              ) : (
                <>
                  <div className="text-[10px] text-[#5E6875] uppercase tracking-wider">
                    Create manual coupling
                  </div>

                  {/* Kalshi selector */}
                  <div>
                    <label className="text-[10px] text-[#5DBE81] flex items-center gap-1 mb-1">
                      <div className="w-3 h-3 rounded-sm bg-[#5DBE81]" />
                      Kalshi market:
                    </label>
                    <select
                      value={newKalshi || ""}
                      onChange={(e) => setNewKalshi(e.target.value)}
                      className="w-full px-2 py-1.5 rounded-lg bg-[#182533] border border-[#232E3C] text-xs text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
                    >
                      <option value="">Select Kalshi market...</option>
                      {availableKalshi.map(k => (
                        <option key={k.ticker} value={k.ticker}>
                          {k.title}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* PM selector */}
                  <div>
                    <label className="text-[10px] text-[#a855f7] flex items-center gap-1 mb-1">
                      <div className="w-3 h-3 rounded-sm bg-[#a855f7]" />
                      Polymarket market:
                    </label>
                    <select
                      value={newPm || ""}
                      onChange={(e) => setNewPm(e.target.value)}
                      className="w-full px-2 py-1.5 rounded-lg bg-[#182533] border border-[#232E3C] text-xs text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
                    >
                      <option value="">Select Polymarket market...</option>
                      {availablePm.map(p => (
                        <option key={p.conditionId} value={p.conditionId}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Create button */}
                  <button
                    onClick={handleAddNew}
                    disabled={!newKalshi || !newPm || busy === "add"}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#5DBE81] text-black text-sm font-semibold hover:bg-[#4DA66E] transition-colors disabled:opacity-50"
                  >
                    {busy === "add" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4" />
                    )}
                    Create Coupling
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}