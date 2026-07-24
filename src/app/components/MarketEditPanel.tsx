"use client";

import { useState, useCallback } from "react";
import { X, Save, Loader2, Pencil } from "lucide-react";
import { CATEGORIES } from "@/lib/categories";
import type { SavedMarket } from "@/app/lib/page-shared";

interface MarketEditPanelProps {
  market: SavedMarket;
  onSave: (updated: SavedMarket) => void;
  onCancel: () => void;
}

export default function MarketEditPanel({ market, onSave, onCancel }: MarketEditPanelProps) {
  const [eventTitle, setEventTitle] = useState(market.eventTitle);
  const [kalshiUrl, setKalshiUrl] = useState(market.kalshiUrl);
  const [polymarketUrl, setPolymarketUrl] = useState(market.polymarketUrl);
  const [category, setCategory] = useState(market.category ?? "");
  const [expiryDate, setExpiryDate] = useState(market.expiryDate ? market.expiryDate.slice(0, 10) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = {};
      if (eventTitle.trim() !== market.eventTitle) body.eventTitle = eventTitle.trim();
      if (kalshiUrl.trim() !== market.kalshiUrl) body.kalshiUrl = kalshiUrl.trim() || null;
      if (polymarketUrl.trim() !== market.polymarketUrl) body.polymarketUrl = polymarketUrl.trim() || null;
      if (category !== (market.category ?? "")) body.category = category || undefined;
      if (expiryDate !== (market.expiryDate ? market.expiryDate.slice(0, 10) : "")) body.expiryDate = expiryDate || null;

      if (Object.keys(body).length === 0) {
        onCancel();
        return;
      }

      const res = await fetch(`/api/saved-markets/${encodeURIComponent(market.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || `Save failed (${res.status})`);
        return;
      }
      onSave(data.market ?? { ...market, ...body });
    } catch (e: any) {
      setError(e.message || "Network error");
    } finally {
      setSaving(false);
    }
  }, [eventTitle, kalshiUrl, polymarketUrl, category, expiryDate, market, onSave, onCancel]);

  return (
    <div className="rounded-xl border border-[#5DBE81]/30 bg-[#17212B] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#FFFFFF]">
          <Pencil className="w-4 h-4 text-[#5DBE81]" />
          Edit Market
        </div>
        <button onClick={onCancel} className="p-1 rounded hover:bg-[#0E1621] text-[#8A9BA8]">
          <X className="w-4 h-4" />
        </button>
      </div>

      {error && (
        <div className="text-xs text-[#ef4444] bg-[#ef4444]/10 border border-[#ef4444]/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-[10px] text-[#8A9BA8] uppercase tracking-wide">Event Title</span>
          <input
            type="text"
            value={eventTitle}
            onChange={(e) => setEventTitle(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] placeholder-[#8A9BA8] focus:outline-none focus:border-[#5DBE81]"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[10px] text-[#8A9BA8] uppercase tracking-wide">Category</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81] cursor-pointer"
          >
            <option value="">— None —</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-[10px] text-[#8A9BA8] uppercase tracking-wide">Kalshi URL</span>
          <input
            type="url"
            value={kalshiUrl}
            onChange={(e) => setKalshiUrl(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] placeholder-[#8A9BA8] focus:outline-none focus:border-[#5DBE81]"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[10px] text-[#8A9BA8] uppercase tracking-wide">Polymarket URL</span>
          <input
            type="url"
            value={polymarketUrl}
            onChange={(e) => setPolymarketUrl(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] placeholder-[#8A9BA8] focus:outline-none focus:border-[#5DBE81]"
          />
        </label>

        <label className="space-y-1 md:col-span-2">
          <span className="text-[10px] text-[#8A9BA8] uppercase tracking-wide">End Date</span>
          <input
            type="date"
            value={expiryDate}
            onChange={(e) => setExpiryDate(e.target.value)}
            className="w-full md:w-64 px-3 py-2 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-[#FFFFFF] focus:outline-none focus:border-[#5DBE81]"
          />
        </label>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg bg-[#0E1621] border border-[#182533] text-xs text-[#8A9BA8] hover:text-[#FFFFFF] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 rounded-lg bg-[#5DBE81] text-black text-xs font-semibold hover:bg-[#4DA66E] transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
