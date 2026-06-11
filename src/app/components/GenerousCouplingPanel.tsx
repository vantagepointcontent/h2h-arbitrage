"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Sparkles,
  Check,
  X,
  Loader2,
  Link2,
  Search,
  AlertCircle,
  Lightbulb,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────

interface MarketEntry {
  platform: "kalshi" | "polymarket";
  id: string;
  title: string;
  url: string;
  expiryDate?: string;
  category?: string;
  yesPrice?: number;
  noPrice?: number;
  volume?: number;
}

interface CouplingCandidate {
  kalshi: MarketEntry;
  polymarket: MarketEntry;
  confidence: number; // 0-100
  scoreBreakdown: {
    keywordSimilarity: number;
    expiryProximity: number;
    categoryOverlap: number;
  };
  matchType: "exact" | "loose" | "correlated";
}

interface CouplingRejection {
  kalshiId: string;
  pmId: string;
  rejectedAt: string;
  reason?: string;
}

// ─── Coupling Engine ─────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "and", "or", "vs", "at", "in", "on", "by", "to", "of", "for",
  "a", "an", "will", "be", "has", "is", "are", "was", "were", "that",
  "this", "these", "those", "it", "not", "but", "with", "from",
]);

const WEIGHT_KEYWORD = 0.50;
const WEIGHT_EXPIRY = 0.25;
const WEIGHT_CATEGORY = 0.25;

const CONFIDENCE_EXACT = 80;
const CONFIDENCE_LOOSE = 50;
const CONFIDENCE_CORRELATED = 30;
const MAX_SUGGESTIONS_PER_MARKET = 3;
const REJECTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function normalizeTitle(title: string): string {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractKeywords(title: string): string[] {
  return normalizeTitle(title)
    .split(" ")
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

function keywordSimilarity(a: string, b: string): number {
  const kwA = extractKeywords(a);
  const kwB = extractKeywords(b);
  const setA = new Set(kwA);
  const setB = new Set(kwB);

  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const w of setA) {
    if (setB.has(w)) shared++;
  }
  const union = new Set([...kwA, ...kwB]).size;
  return union > 0 ? shared / union : 0;
}

function expiryProximity(expA?: string, expB?: string): number {
  if (!expA || !expB) return 0.5;

  const dateA = new Date(expA).getTime();
  const dateB = new Date(expB).getTime();
  const diffDays = Math.abs(dateA - dateB) / (1000 * 60 * 60 * 24);

  if (diffDays === 0) return 1;
  return Math.exp(-diffDays / 7);
}

function categoryOverlap(catA?: string, catB?: string): number {
  if (!catA || !catB) return 0.5;
  return catA.toLowerCase() === catB.toLowerCase() ? 1 : 0;
}

function getMatchType(confidence: number): "exact" | "loose" | "correlated" {
  if (confidence >= CONFIDENCE_EXACT) return "exact";
  if (confidence >= CONFIDENCE_LOOSE) return "loose";
  return "correlated";
}

// ─── Component ───────────────────────────────────────────────────────────

interface GenerousCouplingPanelProps {
  kalshiMarkets: MarketEntry[];
  pmMarkets: MarketEntry[];
  onAccept: (kalshiId: string, pmId: string) => void;
  onReject: (kalshiId: string, pmId: string) => void;
  initialRejections?: CouplingRejection[];
}

function confidenceColor(score: number): string {
  if (score >= CONFIDENCE_EXACT) return "#5DBE81";
  if (score >= CONFIDENCE_LOOSE) return "#facc15";
  return "#ef4444";
}

function confidenceLabel(score: number): string {
  if (score >= 80) return "Exact";
  if (score >= 60) return "Loose";
  if (score >= 40) return "Correlated";
  return "Weak";
}

function matchTypeBadge(type: "exact" | "loose" | "correlated"): { bg: string; text: string; label: string } {
  switch (type) {
    case "exact":
      return { bg: "bg-[#5DBE81]/10", text: "text-[#5DBE81]", label: "Exact" };
    case "loose":
      return { bg: "bg-[#facc15]/10", text: "text-[#facc15]", label: "Loose" };
    case "correlated":
      return { bg: "bg-[#ef4444]/10", text: "text-[#ef4444]", label: "Correlated" };
  }
}

export function GenerousCouplingPanel({
  kalshiMarkets,
  pmMarkets,
  onAccept,
  onReject,
  initialRejections = [],
}: GenerousCouplingPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rejectedPairs, setRejectedPairs] = useState<Set<string>>(new Set());
  const [acceptedPairs, setAcceptedPairs] = useState<Set<string>>(new Set());
  const [actingId, setActingId] = useState<string | null>(null);
  const [showCorrelatedOnly, setShowCorrelatedOnly] = useState(false);
  const [sortByConfidence, setSortByConfidence] = useState(true);

  // Load rejections from API on mount
  const [loadingRejections, setLoadingRejections] = useState(true);
  useEffect(() => {
    fetch("/api/couplings")
      .then((r) => r.json())
      .then((data) => {
        // Rejections are stored server-side; we just initialize our local state
        if (initialRejections.length > 0) {
          const rejSet = new Set(
            initialRejections.map((r) => `${r.kalshiId}:${r.pmId}`),
          );
          setRejectedPairs(rejSet);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingRejections(false));
  }, []);

  // Generate all coupling suggestions
  const allCandidates = useMemo(() => {
    const candidates: CouplingCandidate[] = [];
    const rejSet = new Set(initialRejections.map((r) => `${r.kalshiId}:${r.pmId}`));

    // Track how many suggestions each market already has
    const kalshiSuggestionCount = new Map<string, number>();
    const pmSuggestionCount = new Map<string, number>();

    for (const km of kalshiMarkets) {
      for (const pm of pmMarkets) {
        const pairId = `${km.id}:${pm.id}`;
        if (rejSet.has(pairId) || rejectedPairs.has(pairId)) continue;
        if (acceptedPairs.has(pairId)) continue;

        const kwScore = keywordSimilarity(km.title, pm.title);
        const expScore = expiryProximity(km.expiryDate, pm.expiryDate);
        const catScore = categoryOverlap(km.category, pm.category);

        const rawScore =
          kwScore * WEIGHT_KEYWORD +
          expScore * WEIGHT_EXPIRY +
          catScore * WEIGHT_CATEGORY;

        const confidence = Math.round(rawScore * 100);
        if (confidence < CONFIDENCE_CORRELATED) continue;

        candidates.push({
          kalshi: km,
          polymarket: pm,
          confidence,
          scoreBreakdown: {
            keywordSimilarity: Math.round(kwScore * 100) / 100,
            expiryProximity: Math.round(expScore * 100) / 100,
            categoryOverlap: Math.round(catScore * 100) / 100,
          },
          matchType: getMatchType(confidence),
        });
      }
    }

    // Sort by confidence descending
    candidates.sort((a, b) => b.confidence - a.confidence);

    // Limit suggestions per market (top N)
    const seen = new Set<string>();
    const limited: CouplingCandidate[] = [];
    for (const c of candidates) {
      const kCount = kalshiSuggestionCount.get(c.kalshi.id) ?? 0;
      const pCount = pmSuggestionCount.get(c.polymarket.id) ?? 0;
      if (kCount < MAX_SUGGESTIONS_PER_MARKET && pCount < MAX_SUGGESTIONS_PER_MARKET) {
        limited.push(c);
        kalshiSuggestionCount.set(c.kalshi.id, kCount + 1);
        pmSuggestionCount.set(c.polymarket.id, pCount + 1);
      }
    }

    return limited;
  }, [kalshiMarkets, pmMarkets, initialRejections, rejectedPairs, acceptedPairs]);

  // Apply search filter
  const filteredCandidates = useMemo(() => {
    if (!searchQuery.trim()) return allCandidates;
    const q = searchQuery.toLowerCase();
    return allCandidates.filter(
      (c) =>
        c.kalshi.title.toLowerCase().includes(q) ||
        c.polymarket.title.toLowerCase().includes(q),
    );
  }, [allCandidates, searchQuery]);

  // Apply correlated-only filter
  const displayedCandidates = useMemo(() => {
    if (!showCorrelatedOnly) return filteredCandidates;
    return filteredCandidates.filter((c) => c.matchType === "correlated");
  }, [filteredCandidates, showCorrelatedOnly]);

  // Sort by confidence or by market title
  const finalCandidates = useMemo(() => {
    if (sortByConfidence) return displayedCandidates;
    return [...displayedCandidates].sort((a, b) =>
      a.kalshi.title.localeCompare(b.kalshi.title),
    );
  }, [displayedCandidates, sortByConfidence]);

  // Group by Kalshi market for expandable rows
  const grouped = useMemo(() => {
    const groups = new Map<string, CouplingCandidate[]>();
    for (const c of finalCandidates) {
      const key = c.kalshi.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }
    return groups;
  }, [finalCandidates]);

  const handleAccept = useCallback(
    (kalshiId: string, pmId: string) => {
      const pairId = `${kalshiId}:${pmId}`;
      setActingId(pairId);
      setAcceptedPairs((prev) => new Set(prev).add(pairId));
      onAccept(kalshiId, pmId);
      setActingId(null);
    },
    [onAccept],
  );

  const handleReject = useCallback(
    (kalshiId: string, pmId: string) => {
      const pairId = `${kalshiId}:${pmId}`;
      setActingId(pairId);
      setRejectedPairs((prev) => new Set(prev).add(pairId));
      onReject(kalshiId, pmId);
      setActingId(null);
    },
    [onReject],
  );

  // Summary stats
  const stats = useMemo(() => {
    const exact = allCandidates.filter((c) => c.matchType === "exact").length;
    const loose = allCandidates.filter((c) => c.matchType === "loose").length;
    const correlated = allCandidates.filter(
      (c) => c.matchType === "correlated",
    ).length;
    return { exact, loose, correlated, total: allCandidates.length };
  }, [allCandidates]);

  if (kalshiMarkets.length === 0 && pmMarkets.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-[#a855f7]/30 bg-[#17212B] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#182533] bg-[#17212B]">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[#a855f7]" />
          <h3 className="text-sm font-semibold text-[#FFFFFF]">
            Generous Coupling
          </h3>
          <span className="text-[10px] text-[#5E6875]">
            ({kalshiMarkets.length}K &times; {pmMarkets.length}PM unmatched)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Stats badges */}
          {stats.total > 0 && (
            <div className="hidden sm:flex items-center gap-1 mr-2">
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#5DBE81]/10 text-[#5DBE81]"
              >
                {stats.exact} exact
              </span>
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#facc15]/10 text-[#facc15]"
              >
                {stats.loose} loose
              </span>
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#ef4444]/10 text-[#ef4444]"
              >
                {stats.correlated} correlated
              </span>
            </div>
          )}

          {/* Correlated-only toggle */}
          <button
            onClick={() => setShowCorrelatedOnly((v) => !v)}
            className={`p-1.5 rounded-md transition-colors ${
              showCorrelatedOnly
                ? "bg-[#ef4444]/20 text-[#ef4444]"
                : "bg-[#182533] text-[#5E6875] hover:text-[#FFFFFF]"
            }`}
            title={showCorrelatedOnly ? "Show all" : "Show correlated only"}
          >
            {showCorrelatedOnly ? (
              <EyeOff className="w-3.5 h-3.5" />
            ) : (
              <Eye className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Search bar */}
      {finalCandidates.length > 0 && (
        <div className="px-4 py-2 border-b border-[#182533]">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#232E3C]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search markets..."
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[#182533] border border-[#232E3C] text-xs text-[#FFFFFF] placeholder-[#232E3C] focus:outline-none focus:border-[#a855f7] focus:ring-1 focus:ring-[#a855f7]/30 transition-all"
            />
          </div>
        </div>
      )}

      {/* Content */}
      <div className="p-4">
        {finalCandidates.length === 0 ? (
          <div className="text-sm text-[#5E6875] text-center py-4">
            {searchQuery
              ? `No matches for "${searchQuery}"`
              : "No coupling candidates found."}
          </div>
        ) : (
          <div className="space-y-2">
            {Array.from(grouped.entries()).map(([kalshiId, suggestions]) => {
              const kalshi = suggestions[0].kalshi;
              const isExpanded = expandedId === kalshiId;
              const badge = matchTypeBadge(suggestions[0].matchType);

              return (
                <div
                  key={kalshiId}
                  className="border border-[#182533] rounded-lg bg-[#17212B] overflow-hidden"
                >
                  {/* Expandable header */}
                  <button
                    onClick={() =>
                      setExpandedId(isExpanded ? null : kalshiId)
                    }
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-[#182533]/50 transition-colors text-left"
                  >
                    <span
                      className={`transition-transform text-[#5E6875] ${
                        isExpanded ? "rotate-90" : ""
                      }`}
                    >
                      ▶
                    </span>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <img
                          src="/kalshi-icon.png"
                          alt=""
                          className="w-3.5 h-3.5 rounded-sm"
                        />
                        <span className="text-xs text-[#FFFFFF] truncate">
                          {kalshi.title}
                        </span>
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded-full ${badge.bg} ${badge.text}`}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <div className="text-[10px] text-[#232E3C] font-mono mt-0.5">
                        {suggestions.length} suggestion
                        {suggestions.length !== 1 ? "s" : ""}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {suggestions.map((s) => (
                        <span
                          key={s.polymarket.id}
                          className="text-[9px] px-1 py-0.5 rounded-full bg-[#a855f7]/10 text-[#a855f7]"
                        >
                          {s.confidence}%
                        </span>
                      ))}
                    </div>
                  </button>

                  {/* Expanded suggestions */}
                  {isExpanded && (
                    <div className="border-t border-[#182533] px-3 pb-2">
                      {suggestions.map((s) => {
                        const pairId = `${s.kalshi.id}:${s.polymarket.id}`;
                        const isActing = actingId === pairId;
                        const color = confidenceColor(s.confidence);
                        const sBadge = matchTypeBadge(s.matchType);

                        return (
                          <div
                            key={pairId}
                            className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-[#182533]/30 transition-colors"
                          >
                            {/* Confidence */}
                            <div className="flex flex-col items-center gap-0.5 shrink-0 w-12">
                              <span
                                className="text-sm font-bold font-mono"
                                style={{ color }}
                              >
                                {s.confidence}%
                              </span>
                              <span className="text-[9px] text-[#5E6875]">
                                {confidenceLabel(s.confidence)}
                              </span>
                            </div>

                            {/* PM market info */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <img
                                  src="/polymarket-icon.png"
                                  alt=""
                                  className="w-3.5 h-3.5 rounded-sm"
                                />
                                <span className="text-xs text-[#FFFFFF] truncate">
                                  {s.polymarket.title}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                <span
                                  className={`text-[9px] px-1.5 py-0.5 rounded-full ${sBadge.bg} ${sBadge.text}`}
                                >
                                  {sBadge.label}
                                </span>
                                <span className="text-[9px] text-[#232E3C]">
                                  KW:{Math.round(s.scoreBreakdown.keywordSimilarity * 100)}%
                                  Exp:{Math.round(s.scoreBreakdown.expiryProximity * 100)}%
                                  Cat:{Math.round(s.scoreBreakdown.categoryOverlap * 100)}%
                                </span>
                              </div>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() =>
                                  handleAccept(
                                    s.kalshi.id,
                                    s.polymarket.id,
                                  )
                                }
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
                                onClick={() =>
                                  handleReject(
                                    s.kalshi.id,
                                    s.polymarket.id,
                                  )
                                }
                                disabled={isActing}
                                className="p-1.5 rounded-md bg-[#ef4444]/10 hover:bg-[#ef4444]/20 text-[#ef4444] transition-colors disabled:opacity-50"
                                title="Reject (24h cooldown)"
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
              );
            })}
          </div>
        )}
      </div>

      {/* Footer info */}
      {finalCandidates.length > 0 && (
        <div className="px-4 py-2 border-t border-[#182533] bg-[#17212B] flex items-center justify-between">
          <span className="text-[10px] text-[#232E3C]">
            {finalCandidates.length} suggestion
            {finalCandidates.length !== 1 ? "s" : ""} &middot; click to expand
          </span>
          <span className="text-[10px] text-[#232E3C]">
            Sorted by {sortByConfidence ? "confidence" : "title"}
          </span>
        </div>
      )}
    </div>
  );
}
