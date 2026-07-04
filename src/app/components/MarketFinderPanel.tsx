// MarketFinderPanel.tsx — market discovery view (PERF-002 split from page.tsx).
'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { AlertCircle, Calendar, Check, Download, Filter, Globe, Hash, Loader2, RefreshCw, Save } from "lucide-react";
import { CATEGORIES, CategoryName } from "@/lib/categories";
import { getTimeAgo, isMatched, formatPercent, formatCurrency, formatRelativeTime, formatProfitDisplay } from "@/app/lib/page-shared";

/* ── MarketFinder Panel ── */
export function MarketFinderPanel({
  markets,
  savedMarketUrls,
  loading,
  syncing,
  error,
  lastSync,
  savingIds,
  selectedIds,
  bulkSaving,
  bulkMsg,
  spreadThreshold,
  expiryDays,
  fetchCount,
  categories,
  autoRefreshEnabled,
  onFetch,
  onSync,
  onSaveToH2H,
  onToggleSelected,
  onToggleSelectAll,
  onBulkSave,
  onSetCategories,
  onSetExpiryDays,
  onSetFetchCount,
  onToggleAutoRefresh,
  allMarkets,
  showAllPlatforms,
  onFetchAll,
  onToggleShowAllPlatforms,
  matchFilter,
  onSetMatchFilter,
}: {
  markets: any[];
  savedMarketUrls: { kalshi: string; pm: string }[];
  loading: boolean;
  syncing: boolean;
  error: string;
  lastSync: any;
  savingIds: Set<string>;
  selectedIds: Set<string>;
  bulkSaving: boolean;
  bulkMsg: string;
  spreadThreshold: number;
  expiryDays: number;
  fetchCount: number;
  categories: string[];
  autoRefreshEnabled: boolean;
  onFetch: () => void;
  onSync: () => void;
  onSaveToH2H: (m: any) => void;
  onToggleSelected: (id: string) => void;
  onToggleSelectAll: (visibleIds: string[]) => void;
  onBulkSave: () => void;
  onSetCategories: (cats: string[]) => void;
  onSetExpiryDays: (days: number) => void;
  onSetFetchCount: (count: number) => void;
  onToggleAutoRefresh: (enabled: boolean) => void;
  allMarkets: any[];
  showAllPlatforms: boolean;
  onFetchAll: () => void;
  onToggleShowAllPlatforms: () => void;
  matchFilter: "all" | "matched" | "unmatched";
  onSetMatchFilter: (f: "all" | "matched" | "unmatched") => void;
}) {
  // Local fetch count (defaults to prop, user-adjustable via slider)
  const [localFetchCount, setLocalFetchCount] = useState(fetchCount);

  const normalized = (url: string) => (url || '').split('?')[0].replace(/\/$/, '').toLowerCase();

  // Determine which data source to use
  const displayMarkets = showAllPlatforms ? allMarkets : markets;

  const filtered = displayMarkets.filter((m) => {
    const kUrl = normalized(m.kalshiUrl);
    const pmUrl = normalized(m.polymarketUrl);
    // When showing all platforms, allow markets with only one URL
    if (showAllPlatforms) {
      // Apply match filter
      if (matchFilter === 'matched' && (!kUrl || !pmUrl)) return false;
      if (matchFilter === 'unmatched' && kUrl && pmUrl) return false;
      return true;
    }
    // Matched-only mode: require both URLs and not already saved
    if (!kUrl || !pmUrl) return false;
    return !savedMarketUrls.some(
      (saved) => (kUrl && normalized(saved.kalshi) === kUrl) || (pmUrl && normalized(saved.pm) === pmUrl)
    );
  });

  // Category filter (applied to both modes)
  const categoryFiltered = categories.length > 0
    ? filtered.filter(m => categories.includes(m.eventType))
    : filtered;

  // Sort: markets with spread < threshold first, then by spread, then by expiry
  const sorted = categoryFiltered.sort((a, b) => {
    const aBelow = a.spreadPct != null && a.spreadPct <= spreadThreshold;
    const bBelow = b.spreadPct != null && b.spreadPct <= spreadThreshold;
    if (aBelow !== bBelow) return aBelow ? -1 : 1;
    if (a.spreadPct != null && b.spreadPct != null) {
      return a.spreadPct - b.spreadPct;
    }
    const da = a.eventDate ? new Date(a.eventDate).getTime() : Infinity;
    const db = b.eventDate ? new Date(b.eventDate).getTime() : Infinity;
    return da - db;
  });

  const visibleIds = sorted.map(m => m.id);
  const selectedVisibleCount = visibleIds.filter(id => selectedIds.has(id)).length;
  const allSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const indeterminate = selectedVisibleCount > 0 && !allSelected;

  const hiddenCount = showAllPlatforms ? 0 : markets.length - sorted.length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Globe className="w-5 h-5 text-[#5DBE81]" />
            MarketFinder
          </h2>
          <p className="text-xs text-[#5E6875] mt-0.5">
            {showAllPlatforms
              ? `All platforms — ${allMarkets.length} markets`
              : `PredictionHunt matched events — Kalshi + Polymarket only`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastSync && !showAllPlatforms && (
            <span className="text-[10px] text-[#232E3C]">
              Last sync: {getTimeAgo(lastSync.finishedAt || lastSync.startedAt)}
            </span>
          )}
          <button
            onClick={onFetchAll}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#232E3C] text-[#8A9BA8] text-sm font-medium hover:bg-[#182533] hover:text-[#FFFFFF] transition-all border border-[#232E3C] disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {loading ? "Fetching..." : "Fetch All"}
          </button>
          <button
            onClick={onSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#5DBE81]/10 text-[#5DBE81] text-sm font-medium hover:bg-[#5DBE81]/20 transition-all border border-[#5DBE81]/20 disabled:opacity-50"
          >
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {syncing ? "Syncing..." : "Sync All"}
          </button>
        </div>
      </div>

      {/* View toggle: Matched vs All Platforms */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#182533]/50 border border-[#232E3C]">
        <span className="text-xs text-[#5E6875]">View:</span>
        <button
          onClick={() => !showAllPlatforms && onToggleShowAllPlatforms()}
          className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${showAllPlatforms ? 'bg-[#5DBE81]/15 text-[#5DBE81]' : 'bg-[#182533] text-[#5E6875] hover:text-[#8A9BA8]'}`}
        >
          All Platforms
        </button>
        <button
          onClick={() => showAllPlatforms && onToggleShowAllPlatforms()}
          className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${!showAllPlatforms ? 'bg-[#5DBE81]/15 text-[#5DBE81]' : 'bg-[#182533] text-[#5E6875] hover:text-[#8A9BA8]'}`}
        >
          Matched Only
        </button>
      </div>

      {/* Matched/Unmatched filter (only in All Platforms mode) */}
      {showAllPlatforms && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#182533]/50 border border-[#232E3C]">
          <span className="text-xs text-[#5E6875]">Match:</span>
          {(["all", "matched", "unmatched"] as const).map(f => (
            <button
              key={f}
              onClick={() => onSetMatchFilter(f)}
              className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${matchFilter === f ? 'bg-[#5DBE81]/15 text-[#5DBE81]' : 'bg-[#182533] text-[#5E6875] hover:text-[#8A9BA8]'}`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      )}

      {/* Spread threshold control */}
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[#182533]/50 border border-[#232E3C]">
        <Filter className="w-3.5 h-3.5 text-[#5E6875]" />
        <span className="text-xs text-[#5E6875]">Spread threshold:</span>
        <input
          type="range"
          min="1"
          max="50"
          step="0.5"
          value={spreadThreshold}
          onChange={(e) => window.dispatchEvent(new CustomEvent('mf-spread-change', { detail: Number(e.target.value) }))}
          className="flex-1 accent-[#5DBE81] h-1"
        />
        <span className="text-xs font-mono text-[#5DBE81] min-w-[3rem] text-right">{spreadThreshold}%</span>
      </div>

      {/* Expiry days control */}
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[#182533]/50 border border-[#232E3C]">
        <Calendar className="w-3.5 h-3.5 text-[#5E6875]" />
        <span className="text-xs text-[#5E6875]">Expiry within:</span>
        <input
          type="range"
          min="1"
          max="365"
          step="1"
          value={expiryDays}
          onChange={(e) => onSetExpiryDays(Number(e.target.value))}
          className="flex-1 accent-[#5DBE81] h-1"
        />
        <span className="text-xs font-mono text-[#5DBE81] min-w-[3rem] text-right">{expiryDays}d</span>
      </div>

      {/* Fetch count control */}
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[#182533]/50 border border-[#232E3C]">
        <Hash className="w-3.5 h-3.5 text-[#5E6875]" />
        <span className="text-xs text-[#5E6875]">Fetch count:</span>
        <input
          type="range"
          min="1"
          max="20"
          step="1"
          value={localFetchCount}
          onChange={(e) => {
            const n = Number(e.target.value);
            setLocalFetchCount(n);
            onSetFetchCount(n);
          }}
          className="flex-1 accent-[#5DBE81] h-1"
        />
        <span className="text-xs font-mono text-[#5DBE81] min-w-[3rem] text-right">{localFetchCount}</span>
      </div>

      {/* Category filter — multi-select chips */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-[#182533]/50 border border-[#232E3C]">
        <Filter className="w-3.5 h-3.5 text-[#5E6875] shrink-0" />
        <span className="text-xs text-[#5E6875]">Category:</span>
        {CATEGORIES.map(c => {
          const isActive = categories.includes(c);
          return (
            <button
              key={c}
              onClick={() => {
                if (isActive) {
                  onSetCategories(categories.filter(x => x !== c));
                } else {
                  onSetCategories([...categories, c]);
                }
                // Changing categories fetches fresh filtered markets
                onFetch();
              }}
              className={`px-2 py-0.5 rounded-full text-[11px] font-medium transition-all border ${
                isActive
                  ? "bg-[#5DBE81]/15 text-[#5DBE81] border-[#5DBE81]/30"
                  : "bg-[#182533] text-[#5E6875] border-[#232E3C] hover:text-[#8A9BA8] hover:border-[#232E3C]"
              }`}
            >
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </button>
          );
        })}
        {categories.length > 0 && (
          <button
            onClick={() => {
              onSetCategories([]);
              onFetch();
            }}
            className="px-2 py-0.5 rounded-full text-[11px] text-[#232E3C] hover:text-[#8A9BA8] transition-colors"
          >
            Clear
          </button>
        )}
        {categories.length > 0 && (
          <span className="text-[10px] text-[#232E3C] ml-auto">
            {sorted.length} of {filtered.length} markets
          </span>
        )}
      </div>

      {hiddenCount > 0 && (
        <div className="text-xs text-[#5E6875] flex items-center gap-2 px-3 py-2 rounded-lg bg-[#182533]/50">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[#5DBE81]"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          {hiddenCount} market{hiddenCount !== 1 ? 's' : ''} hidden (already in H2H)
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-[#ef4444]">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {bulkMsg && (
        <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${bulkMsg.includes("failed") ? "text-[#facc15] bg-[#facc15]/10" : "text-[#5DBE81] bg-[#5DBE81]/10"}`}>
          <Check className="w-4 h-4" /> {bulkMsg}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden overflow-x-auto">
          {/* Skeleton rows */}
          {[...Array(6)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-[#182533] last:border-0 animate-pulse">
              <div className="w-3.5 h-3.5 rounded bg-[#232E3C] shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-48 rounded bg-[#232E3C]" />
                <div className="h-3 w-16 rounded bg-[#182533]" />
              </div>
              <div className="h-4 w-24 rounded bg-[#232E3C]" />
              <div className="h-4 w-20 rounded bg-[#232E3C]" />
              <div className="h-4 w-20 rounded bg-[#232E3C]" />
              <div className="h-8 w-24 rounded bg-[#232E3C]" />
            </div>
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="py-20 text-center text-sm text-[#232E3C]">
          No markets found. Try syncing to fetch from PredictionHunt.
        </div>
      ) : (
        <div className="rounded-xl border border-[#182533] bg-[#17212B] overflow-hidden overflow-x-auto">
          {/* Bulk action bar */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#182533] bg-[#17212B]">
            <div className="flex items-center gap-3">
              <span className="text-xs text-[#5E6875]">
                {selectedVisibleCount}/{sorted.length} selected
              </span>
              {selectedVisibleCount > 0 && (
                <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-[#182533] text-[#232E3C] border border-[#232E3C]">⌘↵</kbd>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onBulkSave()}
                disabled={bulkSaving || selectedVisibleCount === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#5DBE81]/10 text-[#5DBE81] text-xs font-medium hover:bg-[#5DBE81]/20 transition-all border border-[#5DBE81]/20 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {bulkSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {bulkSaving ? "Saving..." : `Save Selected (${selectedVisibleCount})`}
              </button>
            </div>
          </div>

          <table className="w-full text-sm">
            <thead className="bg-[#17212B] border-b border-[#182533]">
              <tr className="text-[10px] text-[#5E6875] uppercase tracking-wider">
                <th className="px-4 py-3 font-medium w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={cb => { if (cb) cb.indeterminate = indeterminate; }}
                    onChange={() => onToggleSelectAll(visibleIds)}
                    className="w-3.5 h-3.5 rounded border-[#232E3C] bg-[#182533] text-[#5DBE81] focus:ring-[#5DBE81]/30 focus:ring-offset-0 cursor-pointer"
                  />
                </th>
                <th className="text-left px-4 py-3 font-medium">Matched Event</th>
                <th className="text-left px-4 py-3 font-medium w-40">Expiry</th>
                <th className="text-left px-4 py-3 font-medium w-40">Links</th>
                <th className="text-center px-4 py-3 font-medium w-32"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#182533]">
              {sorted.map((m) => {
                const isSaving = savingIds.has(m.id);
                const isChecked = selectedIds.has(m.id);

                // Matched/unmatched badge
                const isMatched = m.kalshiUrl && m.polymarketUrl;
                const matchBadge = isMatched
                  ? <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-[#5DBE81]/15 text-[#5DBE81]">Matched</span>
                  : <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-[#facc15]/15 text-[#facc15]">Unmatched</span>;

                return (
                  <tr key={m.id} className={`hover:bg-[#182533]/50 transition-colors ${isChecked ? "bg-[#5DBE81]/5" : ""}`}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => onToggleSelected(m.id)}
                        className="w-3.5 h-3.5 rounded border-[#232E3C] bg-[#182533] text-[#5DBE81] focus:ring-[#5DBE81]/30 focus:ring-offset-0 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-[#FFFFFF] text-sm">{m.title}</div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-[#182533] text-[#5E6875]">{m.eventType}</span>
                        {showAllPlatforms && matchBadge}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-[#FFFFFF]">
                        {m.eventDate ? new Date(m.eventDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {showAllPlatforms ? (
                        <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${m.platform === 'polymarket' ? 'bg-[#5DBE81]/15 text-[#5DBE81]' : 'bg-[#facc15]/15 text-[#facc15]'}`}>
                          {m.platform}
                        </span>
                      ) : (
                        <div className="flex items-center gap-3">
                          {m.kalshiUrl ? (
                            <a href={m.kalshiUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs font-medium text-[#facc15] hover:underline">Kalshi →</a>
                          ) : (
                            <span className="text-xs text-[#232E3C]">—</span>
                          )}
                          {m.polymarketUrl ? (
                            <a href={m.polymarketUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs font-medium text-[#5DBE81] hover:underline">Polymarket →</a>
                          ) : (
                            <span className="text-xs text-[#232E3C]">—</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {isSaving ? (
                        <span className="inline-flex items-center gap-1 text-xs text-[#5E6875]">
                          <Loader2 className="w-3 h-3 animate-spin" /> Saving
                        </span>
                      ) : (
                        <button
                          onClick={() => onSaveToH2H(m)}
                          disabled={!m.kalshiUrl || !m.polymarketUrl}
                          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[#5DBE81]/10 text-[#5DBE81] hover:bg-[#5DBE81]/20 transition-colors border border-[#5DBE81]/20 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          Add
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
