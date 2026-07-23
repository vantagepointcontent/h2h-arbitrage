'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';

type Level = { price: number; size: number; cumulativeSize: number };
type Book = { label: string; bids: Level[]; asks: Level[] };
type DepthResponse = { updatedAt: string; kalshi: Book; polymarket: Book; error?: string };

function formatContracts(size: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(size);
}

function DepthChart({ platform, book }: { platform: 'Kalshi' | 'Polymarket'; book: Book }) {
  const maxSize = Math.max(1, ...book.bids.map(x => x.cumulativeSize), ...book.asks.map(x => x.cumulativeSize));
  const rows = Math.max(book.bids.length, book.asks.length);

  return (
    <section className="rounded-xl border border-[#232E3C] bg-[#0E1621] overflow-hidden" aria-label={`${platform} market depth`}>
      <header className="flex items-center justify-between border-b border-[#182533] px-3 py-2">
        <div className="flex items-center gap-2">
          <BarChart3 className={platform === 'Kalshi' ? 'h-3.5 w-3.5 text-[#facc15]' : 'h-3.5 w-3.5 text-[#a855f7]'} />
          <span className="text-xs font-semibold text-[#FFFFFF]">{platform} Depth</span>
        </div>
        <span className="text-[10px] text-[#8A9BA8]">{book.label}</span>
      </header>
      {rows === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-[#8A9BA8]">No live orderbook levels available.</div>
      ) : (
        <div className="p-3">
          <div className="mb-2 grid grid-cols-[1fr_52px_52px_1fr] gap-2 text-[9px] uppercase tracking-wide text-[#5E6875]">
            <span>Bid shares</span><span className="text-right">Bid price</span><span>Ask price</span><span className="text-right">Ask shares</span>
          </div>
          <div className="space-y-1">
            {Array.from({ length: rows }, (_, index) => {
              const bid = book.bids[index];
              const ask = book.asks[index];
              return (
                <div key={`${bid?.price ?? 'b'}-${ask?.price ?? 'a'}-${index}`} className="grid grid-cols-[1fr_52px_52px_1fr] items-center gap-2 text-[11px] font-mono">
                  <div className="relative h-5 overflow-hidden rounded-sm bg-[#5DBE81]/5 text-left">
                    {bid && <div className="absolute inset-y-0 right-0 bg-[#5DBE81]/20" style={{ width: `${(bid.cumulativeSize / maxSize) * 100}%` }} />}
                    <span className="relative z-10 flex h-full items-center px-1.5 text-[#A9DDB9]" title={bid ? `${formatContracts(bid.size)} shares at ${(bid.price * 100).toFixed(2)}¢ · ${formatContracts(bid.cumulativeSize)} cumulative` : undefined}>{bid ? formatContracts(bid.size) : ''}</span>
                  </div>
                  <span className="text-right text-[#A9DDB9]">{bid ? `${(bid.price * 100).toFixed(2)}¢` : ''}</span>
                  <span className="text-[#F4B0B0]">{ask ? `${(ask.price * 100).toFixed(2)}¢` : ''}</span>
                  <div className="relative h-5 overflow-hidden rounded-sm bg-[#ef4444]/5 text-right">
                    {ask && <div className="absolute inset-y-0 left-0 bg-[#ef4444]/20" style={{ width: `${(ask.cumulativeSize / maxSize) * 100}%` }} />}
                    <span className="relative z-10 flex h-full items-center justify-end px-1.5 text-[#F4B0B0]" title={ask ? `${formatContracts(ask.size)} shares at ${(ask.price * 100).toFixed(2)}¢ · ${formatContracts(ask.cumulativeSize)} cumulative` : undefined}>{ask ? formatContracts(ask.size) : ''}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between text-[9px] text-[#5E6875]"><span className="text-[#5DBE81]">Bids: shares at each price</span><span>Hover a row for cumulative shares</span><span className="text-[#ef4444]">Asks: shares at each price</span></div>
        </div>
      )}
    </section>
  );
}

export function MarketDepthCharts({ kalshiTicker, pmConditionId }: { kalshiTicker?: string; pmConditionId?: string }) {
  const [data, setData] = useState<DepthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const url = useMemo(() => kalshiTicker && pmConditionId
    ? `/api/market-depth?kalshiTicker=${encodeURIComponent(kalshiTicker)}&pmConditionId=${encodeURIComponent(pmConditionId)}`
    : null, [kalshiTicker, pmConditionId]);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(url, { cache: 'no-store' });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load market depth');
        if (!cancelled) { setData(body); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load market depth');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [url]);

  if (!url) return null;
  return (
    <div className="mt-4 border-t border-[#182533] pt-4">
      <div className="mb-2 flex items-center justify-between"><span className="text-[10px] font-medium uppercase tracking-wider text-[#8A9BA8]">Live market depth</span>{loading && <RefreshCw className="h-3 w-3 animate-spin text-[#8A9BA8]" />}</div>
      {error ? <div className="rounded-lg border border-[#ef4444]/20 bg-[#ef4444]/5 px-3 py-2 text-xs text-[#ef4444]">{error}</div> : data ? <><div className="grid gap-3 lg:grid-cols-2"><DepthChart platform="Kalshi" book={data.kalshi} /><DepthChart platform="Polymarket" book={data.polymarket} /></div><div className="mt-1.5 text-right text-[9px] text-[#5E6875]">Updated {new Date(data.updatedAt).toLocaleTimeString()}</div></> : <div className="rounded-lg border border-[#182533] px-3 py-5 text-center text-xs text-[#8A9BA8]">Loading live orderbook depth…</div>}
    </div>
  );
}
