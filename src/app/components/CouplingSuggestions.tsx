"use client";

import { useState, useEffect, useCallback } from "react";
import { Lightbulb, Check, X, Loader2, Sparkles } from "lucide-react";

// ─── Types (mirror lib/coupling.ts) ─────────────────────────────────────

interface CouplingCandidate {
  kalshiTicker: string;
  kalshiTitle: string;
  pmConditionId: string;
  pmTitle: string;
  confidence: number; // 0-100
  scoreBreakdown: {
    keywordSimilarity: number;
    expiryProximity: number;
    categoryOverlap: number;
  };
}

interface UnmatchedKalshi {
  ticker: string;
  title: string;
  yesAsk: number;
  noAsk: number;
}

interface UnmatchedPolymarket {
  conditionId: string;
  title: string;
  yesPrice: number;
  noPrice: number;
}

// ─── Confidence bar color ───────────────────────────────────────────────

function confidenceColor(score: number): string {
  if (score >= 70) return "#5DBE81"; // green
  if (score >= 50) return "#facc15"; // yellow
  return "#ef4444"; // red
}

function confidenceLabel(score: number): string {
  if (score >= 80) return "Strong";
  if (score >= 60) return "Moderate";
  if (score >= 40) return "Weak";
  return "Low";
}

// ─── Component ──────────────────────────────────────────────────────────

interface CouplingSuggestionsProps {
  unmatchedKalshi: UnmatchedKalshi[];
  unmatchedPolymarket: UnmatchedPolymarket[];
  expiryDate?: string;
  category?: string;
  onAccept: (kalshiTicker: string, pmConditionId: string) => void;
}

export function CouplingSuggestions({
  unmatchedKalshi,
  unmatchedPolymarket,
  expiryDate,
  category,
  onAccept,
}: CouplingSuggestionsProps) {
  const [suggestions, setSuggestions] = useState<CouplingCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  const fetchSuggestions = useCallback(async () => {
    if (unmatchedKalshi.length === 0 || unmatchedPolymarket.length === 0) {
      setSuggestions([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");

    try {
      // Build query params for the coupling API
      const params = new URLSearchParams();

      for (const km of unmatchedKalshi) {
        params.append("kalshi", km.title);
        params.append("kalshi_ticker", km.ticker);
        params.append("kalshi_expiry", expiryDate || "");
        params.append("kalshi_category", category || "");
      }
      for (const pm of unmatchedPolymarket) {
        params.append("pm", pm.title);
        params.append("pm_condition_id", pm.conditionId);
        params.append("pm_expiry", expiryDate || "");
        params.append("pm_category", category || "");
      }

      const res = await fetch(`/api/couplings?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to fetch suggestions");
        return;
      }
      const data = await res.json();
      setSuggestions(data.suggestions || []);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [unmatchedKalshi, unmatchedPolymarket, expiryDate, category]);

  useEffect(() => {
    if (!dismissed) {
      fetchSuggestions();
    }
  }, [fetchSuggestions, dismissed]);

  const handleReject = async (kalshiTicker: string, pmConditionId: string) => {
    const id = `${kalshiTicker}:${pmConditionId}`;
    setActingId(id);
    try {
      const res = await fetch("/api/couplings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reject",
          kalshiTicker,
          pmConditionId,
          reason: "Not a viable pairing",
        }),
      });
      if (res.ok) {
        // Remove from suggestions immediately (optimistic UI)
        setSuggestions(prev =>
          prev.filter(
            s => !(s.kalshiTicker === kalshiTicker && s.pmConditionId === pmConditionId)
          )
        );
      }
    } catch {
      // Silently fail — will be excluded on next fetch
    } finally {
      setActingId(null);
    }
  };

  const handleAccept = async (kalshiTicker: string, pmConditionId: string) => {
    const id = `${kalshiTicker}:${pmConditionId}`;
    setActingId(id);
    try {
      const res = await fetch("/api/couplings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "accept",
          kalshiTicker,
          pmConditionId,
        }),
      });
      if (res.ok) {
        onAccept(kalshiTicker, pmConditionId);
      }
    } catch {
      // Silently fail
    } finally {
      setActingId(null);
    }
  };

  if (dismissed) return null;

  return (
    <div className="rounded-xl border border-[#a855f7]/30 bg-[#17212B] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#182533] bg-[#17212B]">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[#a855f7]" />
          <h3 className="text-sm font-semibold text-[#FFFFFF]">
            Coupling Suggestions
          </h3>
          <span className="text-[10px] text-[#5E6875]">
            ({unmatchedKalshi.length} Kalshi × {unmatchedPolymarket.length} Polymarket unmatched)
          </span>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="p-1 rounded hover:bg-[#182533] text-[#5E6875] transition-colors"
          title="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="p-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-[#5E6875]">
            <Loader2 className="w-4 h-4 animate-spin" />
            Finding coupling opportunities...
          </div>
        ) : error ? (
          <div className="text-sm text-[#ef4444]">{error}</div>
        ) : suggestions.length === 0 ? (
          <div className="text-sm text-[#5E6875] text-center py-4">
            No strong coupling candidates found.
          </div>
        ) : (
          <div className="space-y-2">
            {suggestions.map((s) => {
              const id = `${s.kalshiTicker}:${s.pmConditionId}`;
              const isActing = actingId === id;
              const color = confidenceColor(s.confidence);
              return (
                <div
                  key={id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-[#17212B] border border-[#182533] hover:border-[#232E3C] transition-colors"
                >
                  {/* Confidence indicator */}
                  <div className="flex flex-col items-center gap-0.5 shrink-0 w-12">
                    <span
                      className="text-sm font-bold font-mono"
                      style={{ color }}
                    >
                      {s.confidence}%
                    </span>
                    <span
                      className="text-[9px] text-[#5E6875]"
                    >
                      {confidenceLabel(s.confidence)}
                    </span>
                  </div>

                  {/* Pair info */}
                  <div className="flex-1 min-w-0 grid grid-cols-2 gap-2">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1">
                        <img src="/kalshi-icon.png" alt="" className="w-3.5 h-3.5 rounded-sm" />
                        <span className="text-[10px] text-[#5E6875]">Kalshi</span>
                      </div>
                      <div className="text-xs text-[#FFFFFF] truncate" title={s.kalshiTitle}>
                        {s.kalshiTitle}
                      </div>
                      <div className="text-[10px] text-[#232E3C] font-mono truncate">
                        {s.kalshiTicker}
                      </div>
                    </div>
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1">
                        <img src="/polymarket-icon.png" alt="" className="w-3.5 h-3.5 rounded-sm" />
                        <span className="text-[10px] text-[#5E6875]">Polymarket</span>
                      </div>
                      <div className="text-xs text-[#FFFFFF] truncate" title={s.pmTitle}>
                        {s.pmTitle}
                      </div>
                      <div className="text-[10px] text-[#232E3C] font-mono truncate">
                        {s.pmConditionId.slice(0, 12)}...
                      </div>
                    </div>
                  </div>

                  {/* Score breakdown (tooltip-style) */}
                  <div className="hidden sm:flex flex-col gap-0.5 shrink-0 text-[9px] text-[#232E3C]">
                    <span>KW {Math.round(s.scoreBreakdown.keywordSimilarity * 100)}%</span>
                    <span>Exp {Math.round(s.scoreBreakdown.expiryProximity * 100)}%</span>
                    <span>Cat {Math.round(s.scoreBreakdown.categoryOverlap * 100)}%</span>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleAccept(s.kalshiTicker, s.pmConditionId)}
                      disabled={isActing}
                      className="p-1.5 rounded-md bg-[#5DBE81]/10 hover:bg-[#5DBE81]/20 text-[#5DBE81] transition-colors disabled:opacity-50"
                      title="Accept pairing"
                    >
                      {isActing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => handleReject(s.kalshiTicker, s.pmConditionId)}
                      disabled={isActing}
                      className="p-1.5 rounded-md bg-[#ef4444]/10 hover:bg-[#ef4444]/20 text-[#ef4444] transition-colors disabled:opacity-50"
                      title="Reject (won't suggest for 24h)"
                    >
                      {isActing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <X className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
