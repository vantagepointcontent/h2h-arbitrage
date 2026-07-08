'use client';

/* FEAT-015: Scan page category picker.
 * Choose a category → fetch matched Kalshi/PM pairs from
 * /api/predictionhunt/markets → click a pair to populate the URL fields.
 * Manual variant of MarketFinder, reusing the same API + CATEGORIES. */

import React, { useState } from 'react';
import { ChevronDown, Loader2, MousePointerClick } from 'lucide-react';
import { CATEGORIES } from '@/lib/categories';

interface PickerMarket {
  id: string;
  title: string;
  eventDate: string | null;
  kalshiUrl: string | null;
  polymarketUrl: string | null;
  confidence?: string;
}

export default function ScanCategoryPicker({
  onPick,
}: {
  onPick: (kalshiUrl: string, polymarketUrl: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [markets, setMarkets] = useState<PickerMarket[]>([]);

  const loadCategory = async (cat: string) => {
    setCategory(cat);
    if (!cat) { setMarkets([]); return; }
    setLoading(true);
    setError(null);
    setWarning(null);
    try {
      const res = await fetch(
        `/api/predictionhunt/markets?category=${encodeURIComponent(cat)}&maxDays=90&fetchCount=20`,
        { cache: 'no-store' }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Fetch failed');
      const rows: PickerMarket[] = (data.markets || []).filter(
        (m: PickerMarket) => m.kalshiUrl && m.polymarketUrl
      );
      setMarkets(rows);
      if (data.quotaWarning || data.warning) setWarning(data.quotaWarning || data.warning);
      if (rows.length === 0 && !data.warning && !data.quotaWarning)
        setWarning('No matched pairs found in this category (next 90 days).');
    } catch (e: any) {
      setError(e.message || 'Failed to load markets');
      setMarkets([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs font-medium text-[#8A9BA8] hover:text-[#FFFFFF] transition-colors"
      >
        <MousePointerClick className="w-3.5 h-3.5" />
        Browse matched markets by category
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-3 rounded-lg border border-[#232E3C] bg-[#0E1621] p-3">
          <div className="flex items-center gap-2 mb-3">
            <select
              value={category}
              onChange={(e) => loadCategory(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-[#232E3C] bg-[#17212B] text-xs text-[#8A9BA8] focus:outline-none focus:border-[#5DBE81]/50 cursor-pointer"
            >
              <option value="">Pick a category…</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
              ))}
            </select>
            {loading && <Loader2 className="w-4 h-4 animate-spin text-[#5DBE81]" />}
          </div>

          {error && <div className="text-xs text-red-400 mb-2">{error}</div>}
          {warning && <div className="text-xs text-amber-400 mb-2">{warning}</div>}

          {markets.length > 0 && (
            <div className="max-h-64 overflow-y-auto space-y-1">
              {markets.map((m) => (
                <button
                  key={m.id}
                  onClick={() => onPick(m.kalshiUrl!, m.polymarketUrl!)}
                  className="w-full text-left px-3 py-2 rounded-lg border border-transparent hover:border-[#5DBE81]/40 hover:bg-[#17212B] transition-all group"
                  title="Click to fill the Kalshi + Polymarket URL fields"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-[#FFFFFF] truncate group-hover:text-[#5DBE81]">{m.title}</span>
                    <span className="text-[10px] text-[#8A9BA8] shrink-0">
                      {m.eventDate ? new Date(m.eventDate).toLocaleDateString() : '—'}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
