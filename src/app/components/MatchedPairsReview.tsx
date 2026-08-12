"use client";

import { useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, X } from "lucide-react";

interface ReviewPair {
  id: number;
  kalshiTitle: string | null;
  polymarketTitle: string | null;
  kalshiUrl: string | null;
  polymarketUrl: string | null;
  confidence: number;
  confidenceBreakdown: {
    nameSimilarity: number;
    entityMatch: number;
    categoryMatch: number;
    expiryProximity: number;
  };
  verifiedAt: string | null;
}

export default function MatchedPairsReview() {
  const [pairs, setPairs] = useState<ReviewPair[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [processing, setProcessing] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/matches?status=pending_review", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Failed to load pending matches");
        return response.json();
      })
      .then((body) => {
        if (!cancelled) setPairs(Array.isArray(body.pairs) ? body.pairs : []);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Failed to load pending matches");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const decide = async (id: number, action: "approve" | "reject") => {
    setProcessing(id);
    setError("");
    try {
      const response = await fetch(`/api/matches/${id}/${action}`, { method: "POST" });
      if (!response.ok) throw new Error(`Failed to ${action} match`);
      setPairs((current) => current.filter((pair) => pair.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Failed to ${action} match`);
    } finally {
      setProcessing(null);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-xs text-[#8A9BA8]"><Loader2 className="h-4 w-4 animate-spin" />Loading pending matches…</div>;
  }

  return (
    <section className="space-y-3 rounded-xl border border-[#182533] bg-[#121E2B] p-4" aria-label="Pending match review">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Pending match review</h3>
          <p className="text-xs text-[#8A9BA8]">Live-verified pairs requiring a deterministic human decision.</p>
        </div>
        <span className="rounded-full bg-[#facc15]/10 px-2 py-1 text-xs text-[#facc15]">{pairs.length}</span>
      </div>
      {error && <p className="text-xs text-[#ef4444]">{error}</p>}
      {pairs.length === 0 ? (
        <p className="text-xs text-[#8A9BA8]">No pairs await review.</p>
      ) : pairs.map((pair) => (
        <article key={pair.id} className="space-y-3 rounded-lg border border-[#26384a] bg-[#0E1621] p-3">
          <div className="grid gap-3 md:grid-cols-2">
            <MarketLink label="Kalshi" title={pair.kalshiTitle} url={pair.kalshiUrl} ariaLabel="Open Kalshi market" />
            <MarketLink label="Polymarket" title={pair.polymarketTitle} url={pair.polymarketUrl} ariaLabel="Open Polymarket market" />
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] text-[#B8C5D0]">
            <strong className="text-white">Confidence {pair.confidence}/100</strong>
            <span>Name {pair.confidenceBreakdown.nameSimilarity}/40</span>
            <span>Entities {pair.confidenceBreakdown.entityMatch}/30</span>
            <span>Category {pair.confidenceBreakdown.categoryMatch}/20</span>
            <span>Expiry {pair.confidenceBreakdown.expiryProximity}/10</span>
            <span>{pair.verifiedAt ? `Verified ${new Date(pair.verifiedAt).toLocaleString()}` : "Not verified"}</span>
          </div>
          <div className="flex gap-2">
            <button aria-label="Approve match" disabled={processing === pair.id} onClick={() => void decide(pair.id, "approve")} className="flex min-h-11 items-center gap-1.5 rounded-lg bg-[#5DBE81] px-3 text-xs font-semibold text-black disabled:opacity-50"><Check className="h-4 w-4" />Approve</button>
            <button aria-label="Reject match" disabled={processing === pair.id} onClick={() => void decide(pair.id, "reject")} className="flex min-h-11 items-center gap-1.5 rounded-lg border border-[#ef4444]/40 px-3 text-xs font-semibold text-[#ef4444] disabled:opacity-50"><X className="h-4 w-4" />Reject</button>
          </div>
        </article>
      ))}
    </section>
  );
}

function MarketLink({ label, title, url, ariaLabel }: { label: string; title: string | null; url: string | null; ariaLabel: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#8A9BA8]">{label}</div>
      <div className="text-sm text-white">{title || "Untitled market"}</div>
      {url && <a href={url} target="_blank" rel="noreferrer" aria-label={ariaLabel} className="inline-flex items-center gap-1 text-xs text-[#5DBE81] hover:underline"><ExternalLink className="h-3 w-3" />Open verified URL</a>}
    </div>
  );
}
