"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Link2,
  Search,
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  Check,
  ExternalLink,
  RefreshCw,
  Filter,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Radar,
} from "lucide-react";

interface UncoupledMarket {
  id: string;
  title: string;
  category: string | null;
  expiryDate: string | null;
  confidence: number;
  kalshiMarkets: { ticker: string; title: string; url: string | null }[];
  polymarketMarkets: { conditionId: string; title: string; url: string | null }[];
  coupledCount: number;
  totalPossible: number;
}

export default function CoupleManagementPanel() {
  const [markets, setMarkets] = useState<UncoupledMarket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"title" | "expiry" | "confidence">("title");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runningMatcher, setRunningMatcher] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("sortBy", sortBy);
      const res = await fetch(`/api/uncoupled-markets?${params.toString()}`, { headers: { "Cache-Control": "no-store" } });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setMarkets(data.markets || []);
    } catch (e: any) {
      setError(e.message || "Failed to load uncoupled markets");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [search, sortBy]);

  const toggleSort = (field: "title" | "expiry" | "confidence") => {
    if (sortBy === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDir(field === "title" ? "asc" : "desc");
    }
  };

  const sorted = useMemo(() => {
    const arr = [...markets];
    const mul = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      if (sortBy === "expiry") {
        const ea = a.expiryDate ? new Date(a.expiryDate).getTime() : Infinity;
        const eb = b.expiryDate ? new Date(b.expiryDate).getTime() : Infinity;
        return mul * (ea - eb);
      }
      if (sortBy === "confidence") return mul * (a.confidence - b.confidence);
      return mul * a.title.localeCompare(b.title);
    });
    return arr;
  }, [markets, sortBy, sortDir]);

  const runMatcher = async () => {
    setRunningMatcher(true);
    try {
      await fetch("/api/matches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run" }) });
      await fetchData();
    } catch { /* ignore */ }
    setRunningMatcher(false);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Link2 className="w-5 h-5 text-[#5DBE81]" />
          <h2 className="text-base font-bold text-[#FFFFFF]">Couple Management</h2>
          <span className="text-xs text-[#8A9BA8]">({markets.length} uncoupled)</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[#182533] bg-[#121E2B]">
            <Search className="w-3.5 h-3.5 text-[#8A9BA8]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by title..."
              className="bg-transparent text-sm text-[#FFFFFF] placeholder-[#8A9BA8] focus:outline-none w-40 sm:w-56"
            />
          </div>
          <SortButton field="title" label="Title" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
          <SortButton field="expiry" label="Expiry" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
          <SortButton field="confidence" label="Confidence" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-2 rounded-lg border border-[#182533] bg-[#121E2B] text-[#8A9BA8] hover:text-[#FFFFFF] transition-colors disabled:opacity-50"
            title="Refresh"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 p-3 text-sm text-[#ef4444]">
          {error}
        </div>
      )}

      {sorted.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-[#182533] bg-[#121E2B] p-8 text-center">
          <div className="flex items-center justify-center w-12 h-12 rounded-full bg-[#5DBE81]/15">
            <Check className="w-6 h-6 text-[#5DBE81]" />
          </div>
          <div className="text-sm font-semibold text-[#FFFFFF]">All discovered markets are coupled 🎉</div>
          <div className="text-xs text-[#8A9BA8]">Run the cross-platform matcher to discover new pairs.</div>
          <button
            onClick={runMatcher}
            disabled={runningMatcher}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#5DBE81] text-black text-xs font-semibold hover:bg-[#4DA66E] transition-colors disabled:opacity-50"
          >
            {runningMatcher ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radar className="w-3.5 h-3.5" />}
            Run Matcher
          </button>
        </div>
      )}

      {sorted.length > 0 && (
        <div className="rounded-xl border border-[#182533] bg-[#121E2B] overflow-hidden overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-[#17212B] border-b border-[#182533]">
              <tr className="text-[10px] text-[#8A9BA8] uppercase tracking-wider">
                <th className="text-left px-4 py-3 font-medium">Title</th>
                <th className="text-left px-4 py-3 font-medium">Kalshi</th>
                <th className="text-left px-4 py-3 font-medium">Polymarket</th>
                <th className="text-left px-4 py-3 font-medium">Category</th>
                <th className="text-left px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort("expiry")}>
                  <span className="inline-flex items-center gap-1">Expiry {sortIcon("expiry", sortBy, sortDir)}</span>
                </th>
                <th className="text-left px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort("confidence")}>
                  <span className="inline-flex items-center gap-1">Confidence {sortIcon("confidence", sortBy, sortDir)}</span>
                </th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-center">Expand</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => (
                <Row
                  key={m.id}
                  market={m}
                  expanded={expandedId === m.id}
                  onToggle={() => setExpandedId((id) => (id === m.id ? null : m.id))}
                  onLink={fetchData}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function sortIcon(field: "title" | "expiry" | "confidence", sortBy: string, sortDir: "asc" | "desc") {
  if (sortBy !== field) return <ArrowUpDown className="w-3 h-3" />;
  return sortDir === "asc" ? <ArrowUp className="w-3 h-3 text-[#5DBE81]" /> : <ArrowDown className="w-3 h-3 text-[#5DBE81]" />;
}

function SortButton({
  field,
  label,
  sortBy,
  sortDir,
  onToggle,
}: {
  field: "title" | "expiry" | "confidence";
  label: string;
  sortBy: string;
  sortDir: "asc" | "desc";
  onToggle: (f: "title" | "expiry" | "confidence") => void;
}) {
  const active = sortBy === field;
  return (
    <button
      onClick={() => onToggle(field)}
      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
        active
          ? "bg-[#5DBE81]/15 text-[#5DBE81] border-[#5DBE81]/30"
          : "bg-[#121E2B] text-[#8A9BA8] border-[#182533] hover:text-[#FFFFFF]"
      }`}
    >
      {label}
      {active && (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
    </button>
  );
}

function Row({
  market,
  expanded,
  onToggle,
  onLink,
}: {
  market: UncoupledMarket;
  expanded: boolean;
  onToggle: () => void;
  onLink: () => void;
}) {
  const [linking, setLinking] = useState(false);
  const [selectedKalshi, setSelectedKalshi] = useState<string>("");
  const [selectedPm, setSelectedPm] = useState<string>("");

  const handleLink = async () => {
    if (!selectedKalshi || !selectedPm) return;
    const k = market.kalshiMarkets.find((x) => x.ticker === selectedKalshi);
    const p = market.polymarketMarkets.find((x) => x.conditionId === selectedPm);
    if (!k || !p) return;
    setLinking(true);
    try {
      const res = await fetch("/api/manual-matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kalshiTicker: k.ticker,
          pmConditionId: p.conditionId,
          kalshiTitle: k.title,
          pmTitle: p.title,
          kalshiUrl: k.url,
          polymarketUrl: p.url,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSelectedKalshi("");
      setSelectedPm("");
      onLink();
    } catch (e: any) {
      alert(e.message || "Failed to create coupling");
    } finally {
      setLinking(false);
    }
  };

  const confidenceColor =
    market.confidence >= 70 ? "text-[#5DBE81]" : market.confidence >= 50 ? "text-[#facc15]" : "text-[#8A9BA8]";

  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-b border-[#182533] cursor-pointer transition-colors ${expanded ? "bg-[#0E1621]" : "hover:bg-[#182533]/50"}`}
      >
        <td className="px-4 py-3 align-top">
          <div className="text-sm font-medium text-[#FFFFFF] truncate" title={market.title}>{market.title}</div>
        </td>
        <td className="px-4 py-3 align-top">
          {market.kalshiMarkets.slice(0, 1).map((k) => (
            <div key={k.ticker} className="flex items-center gap-1.5">
              <img src="/kalshi-icon.png" alt="Kalshi" className="w-3.5 h-3.5 rounded-sm" />
              <span className="text-xs text-[#8A9BA8]">{k.ticker}</span>
            </div>
          ))}
          {market.kalshiMarkets.length > 1 && (
            <span className="text-[10px] text-[#8A9BA8]">+{market.kalshiMarkets.length - 1} more</span>
          )}
        </td>
        <td className="px-4 py-3 align-top">
          {market.polymarketMarkets.slice(0, 1).map((p) => (
            <div key={p.conditionId} className="flex items-center gap-1.5">
              <img src="/polymarket-icon.png" alt="Polymarket" className="w-3.5 h-3.5 rounded-sm" />
              <span className="text-xs text-[#8A9BA8] font-mono">{p.conditionId.slice(0, 12)}...</span>
            </div>
          ))}
          {market.polymarketMarkets.length > 1 && (
            <span className="text-[10px] text-[#8A9BA8]">+{market.polymarketMarkets.length - 1} more</span>
          )}
        </td>
        <td className="px-4 py-3 align-top">
          <span className="text-xs text-[#8A9BA8]">{market.category || "—"}</span>
        </td>
        <td className="px-4 py-3 align-top">
          <span className="text-xs text-[#8A9BA8]">{market.expiryDate ? formatExpiry(market.expiryDate) : "—"}</span>
        </td>
        <td className="px-4 py-3 align-top">
          <span className={`text-xs font-bold ${confidenceColor}`}>{market.confidence}%</span>
        </td>
        <td className="px-4 py-3 align-top">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-[#182533] text-[#8A9BA8]">
            Uncoupled
          </span>
        </td>
        <td className="px-4 py-3 align-top text-center">
          <button className="p-1 rounded hover:bg-[#182533] text-[#8A9BA8]" onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-[#0E1621]">
          <td colSpan={8} className="px-4 py-3 border-b border-[#182533]">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
              <div className="space-y-2">
                <div className="text-[10px] text-[#8A9BA8] uppercase tracking-wider flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-sm bg-[#5DBE81]" /> Unmatched Kalshi
                </div>
                {market.kalshiMarkets.map((k) => (
                  <div key={k.ticker} className="flex items-center justify-between p-2 rounded-lg border border-[#182533] bg-[#121E2B]">
                    <div className="min-w-0">
                      <div className="text-xs text-[#FFFFFF] truncate">{k.title}</div>
                      <div className="text-[10px] text-[#8A9BA8] font-mono">{k.ticker}</div>
                    </div>
                    {k.url && (
                      <a
                        href={k.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="p-1.5 rounded-md bg-[#182533] text-[#8A9BA8] hover:text-[#FFFFFF]"
                        title="Open Kalshi"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                ))}
                {market.kalshiMarkets.length === 0 && <div className="text-xs text-[#8A9BA8]">No unmatched Kalshi markets.</div>}
              </div>
              <div className="space-y-2">
                <div className="text-[10px] text-[#8A9BA8] uppercase tracking-wider flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-sm bg-[#a855f7]" /> Unmatched Polymarket
                </div>
                {market.polymarketMarkets.map((p) => (
                  <div key={p.conditionId} className="flex items-center justify-between p-2 rounded-lg border border-[#182533] bg-[#121E2B]">
                    <div className="min-w-0">
                      <div className="text-xs text-[#FFFFFF] truncate">{p.title}</div>
                      <div className="text-[10px] text-[#8A9BA8] font-mono truncate">{p.conditionId}</div>
                    </div>
                    {p.url && (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="p-1.5 rounded-md bg-[#182533] text-[#8A9BA8] hover:text-[#FFFFFF]"
                        title="Open Polymarket"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                ))}
                {market.polymarketMarkets.length === 0 && <div className="text-xs text-[#8A9BA8]">No unmatched Polymarket markets.</div>}
              </div>
            </div>

            {/* Inline add coupling */}
            {market.kalshiMarkets.length > 0 && market.polymarketMarkets.length > 0 && (
              <div className="rounded-lg border border-[#182533] bg-[#17212B] p-3 space-y-3">
                <div className="text-[10px] text-[#8A9BA8] uppercase tracking-wider">Add New Coupling</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-[#5DBE81] flex items-center gap-1 mb-1">
                      <div className="w-2.5 h-2.5 rounded-sm bg-[#5DBE81]" /> Kalshi
                    </label>
                    <select
                      value={selectedKalshi}
                      onChange={(e) => setSelectedKalshi(e.target.value)}
                      className="w-full px-2 py-1.5 rounded-lg bg-[#0E1621] border border-[#232E3C] text-xs text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
                    >
                      <option value="">Select Kalshi market...</option>
                      {market.kalshiMarkets.map((k) => (
                        <option key={k.ticker} value={k.ticker}>{k.ticker} — {k.title}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-[#a855f7] flex items-center gap-1 mb-1">
                      <div className="w-2.5 h-2.5 rounded-sm bg-[#a855f7]" /> Polymarket
                    </label>
                    <select
                      value={selectedPm}
                      onChange={(e) => setSelectedPm(e.target.value)}
                      className="w-full px-2 py-1.5 rounded-lg bg-[#0E1621] border border-[#232E3C] text-xs text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
                    >
                      <option value="">Select Polymarket market...</option>
                      {market.polymarketMarkets.map((p) => (
                        <option key={p.conditionId} value={p.conditionId}>{p.conditionId.slice(0, 18)}... — {p.title}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <button
                  onClick={handleLink}
                  disabled={linking || !selectedKalshi || !selectedPm}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#5DBE81] text-black text-xs font-semibold hover:bg-[#4DA66E] transition-colors disabled:opacity-50"
                >
                  {linking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Link Markets
                </button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
