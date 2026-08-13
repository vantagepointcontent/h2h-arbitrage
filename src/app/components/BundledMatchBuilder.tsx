"use client";

import { useEffect, useMemo, useState } from 'react';
import { allocateBundleBudget, type BundleLeg, type CouplingOrientation } from '@/lib/bundled-matches';
import type { BundledMatch } from '@/lib/bundled-match-store';

interface MarketChoice {
  title: string;
  ticker?: string;
  conditionId?: string;
  yesAsk?: number;
  noAsk?: number;
  yesPrice?: number;
  noPrice?: number;
}

export default function BundledMatchBuilder({
  kalshiMarkets,
  polymarketMarkets,
  onSaved,
}: {
  kalshiMarkets: MarketChoice[];
  polymarketMarkets: MarketChoice[];
  onSaved: () => void;
}) {
  const markets = useMemo(() => [
    ...kalshiMarkets.map(market => ({ ...market, platform: 'kalshi' as const, marketId: market.ticker ?? '', price: market.yesAsk ?? 0 })),
    ...polymarketMarkets.map(market => ({ ...market, platform: 'polymarket' as const, marketId: market.conditionId ?? '', price: market.yesPrice ?? 0 })),
  ], [kalshiMarkets, polymarketMarkets]);
  const [budget, setBudget] = useState('100.00');
  const [orientations, setOrientations] = useState<CouplingOrientation[]>(() => markets.map(() => 'same'));
  const [selected, setSelected] = useState<boolean[]>(() => markets.map(() => true));
  const [ranges, setRanges] = useState(() => markets.map((_, index) => ({
    min: index === 0 ? '' : String(index * 5), max: index === markets.length - 1 ? '' : String((index + 1) * 5),
  })));
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState<BundledMatch[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  const loadSaved = async () => {
    const response = await fetch('/api/bundled-matches', { cache: 'no-store' });
    if (response.ok) setSaved((await response.json()).matches ?? []);
  };
  useEffect(() => {
    let active = true;
    fetch('/api/bundled-matches', { cache: 'no-store' })
      .then(async response => response.ok ? response.json() : { matches: [] })
      .then(body => { if (active) setSaved(body.matches ?? []); });
    return () => { active = false; };
  }, []);

  const legs = markets.map((market, index): BundleLeg => ({
    id: `${market.platform}-${market.marketId}`,
    platform: market.platform,
    marketId: market.marketId,
    title: market.title,
    originalSide: 'yes',
    orientation: orientations[index] ?? 'same',
    priceCents: Math.max(1, Math.round(market.price * 100)),
    payoutCents: 100,
    feeBps: 0,
    quantityStep: 1,
    minimumQuantity: 1,
    maximumQuantity: 1000,
    range: {
      minBps: ranges[index]?.min === '' ? null : Math.round(Number(ranges[index]?.min) * 100),
      minInclusive: ranges[index]?.min !== '',
      maxBps: ranges[index]?.max === '' ? null : Math.round(Number(ranges[index]?.max) * 100),
      maxInclusive: false,
    },
  })).filter((_, index) => selected[index]);
  const budgetCents = Math.max(1, Math.round(Number(budget) * 100));
  const preview = legs.length >= 2 ? allocateBundleBudget(legs, budgetCents) : null;

  const save = async () => {
    const response = await fetch(editingId ? `/api/bundled-matches/${editingId}` : '/api/bundled-matches', {
      method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Manual bundle', budgetCents, targetRange: { minBps: null, minInclusive: false, maxBps: null, maxInclusive: false }, legs }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setMessage(body.error ?? 'Bundle was not saved');
      return;
    }
    setMessage(editingId ? 'Bundle updated' : 'Bundle saved');
    setEditingId(null);
    await loadSaved();
    onSaved();
  };

  const remove = async (id: string) => {
    const response = await fetch(`/api/bundled-matches/${id}`, { method: 'DELETE' });
    if (!response.ok) { setMessage('Bundle was not removed'); return; }
    await loadSaved();
    onSaved();
  };

  return <section className="rounded-xl border border-[#5DBE81]/30 bg-[#0E1621] p-4">
    <h3 className="text-sm font-semibold text-white">Bundled matching</h3>
    <p className="mt-1 text-xs text-amber-300">Preview only — this builder never places trades.</p>
    <label className="mt-3 block text-xs text-[#8A9BA8]">Total budget ($)
      <input aria-label="Total budget" value={budget} onChange={event => setBudget(event.target.value)} inputMode="decimal" className="mt-1 min-h-11 w-full rounded border border-[#25394d] bg-[#17212B] px-3 text-white" />
    </label>
    <div className="mt-3 space-y-2">
      {markets.map((market, index) => <div key={`${market.platform}-${market.marketId}`} className="rounded border border-[#25394d] p-3 text-xs text-white">
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selected[index] ?? false} onChange={event => setSelected(current => current.map((value, item) => item === index ? event.target.checked : value))} />Include {market.platform}: {market.title}</label>
        <label className="mt-2 block text-[#8A9BA8]">Orientation for {market.title}
          <select aria-label={`Orientation for ${market.title}`} value={orientations[index] ?? 'same'} onChange={event => setOrientations(current => current.map((value, item) => item === index ? event.target.value as CouplingOrientation : value))} className="ml-2 min-h-11 rounded bg-[#17212B] px-2 text-white">
            <option value="same">Same proposition</option><option value="inverted">Inverted/negated proposition</option>
          </select>
        </label>
        <div className="mt-1 text-[#8A9BA8]">Original YES → normalized {orientations[index] === 'inverted' ? 'NO' : 'YES'}</div>
        <div className="mt-2 flex gap-2 text-[#8A9BA8]">
          <label>Range min %<input aria-label={`Range minimum for ${market.title}`} value={ranges[index]?.min ?? ''} placeholder="unbounded" onChange={event => setRanges(current => current.map((value, item) => item === index ? { ...value, min: event.target.value } : value))} className="ml-1 w-20 rounded bg-[#17212B] p-2 text-white" /></label>
          <label>Range max %<input aria-label={`Range maximum for ${market.title}`} value={ranges[index]?.max ?? ''} placeholder="unbounded" onChange={event => setRanges(current => current.map((value, item) => item === index ? { ...value, max: event.target.value } : value))} className="ml-1 w-20 rounded bg-[#17212B] p-2 text-white" /></label>
        </div>
      </div>)}
    </div>
    {preview && <div className="mt-3 rounded bg-[#17212B] p-3 text-xs text-white">
      <div>Total cost ${(preview.totalCostCents / 100).toFixed(2)} · residual ${(preview.roundingResidualCents / 100).toFixed(2)}</div>
      <div>Worst case ${(preview.worstCaseNetProfitCents / 100).toFixed(2)} · ROI {(preview.worstCaseRoiBps / 100).toFixed(2)}%</div>
      {!preview.executable && <div className="mt-1 text-amber-300">Non-executable: {preview.reasons.join('; ')}</div>}
      {preview.allocations.map(allocation => <div key={allocation.legId}>{allocation.legId}: {allocation.quantity} shares · cost ${(allocation.costCents / 100).toFixed(2)} · fee ${(allocation.feeCents / 100).toFixed(2)} · payout ${(allocation.payoutCents / 100).toFixed(2)}</div>)}
    </div>}
    <button type="button" onClick={save} className="mt-3 min-h-11 rounded bg-[#5DBE81] px-4 text-xs font-semibold text-[#0E1621]">Save bundle configuration</button>
    {message && <p className="mt-2 text-xs text-white">{message}</p>}
    {saved.length > 0 && <div className="mt-4 space-y-2"><h4 className="text-xs font-semibold text-white">Saved bundles</h4>{saved.map(match => <div key={match.id} className="rounded border border-[#25394d] p-3 text-xs text-white">
      <div>{match.name} · ${(match.budgetCents / 100).toFixed(2)} · {match.legs.length} legs</div>
      <div className={match.preview.executable ? 'text-[#5DBE81]' : 'text-amber-300'}>{match.preview.executable ? 'Executable preview' : `Non-executable: ${match.preview.reasons.join('; ')}`}</div>
      <button type="button" onClick={() => {
        setEditingId(match.id); setBudget((match.budgetCents / 100).toFixed(2));
        setSelected(markets.map(market => match.legs.some(leg => leg.platform === market.platform && leg.marketId === market.marketId)));
        setOrientations(markets.map(market => match.legs.find(leg => leg.platform === market.platform && leg.marketId === market.marketId)?.orientation ?? 'same'));
        setRanges(markets.map(market => { const range = match.legs.find(leg => leg.platform === market.platform && leg.marketId === market.marketId)?.range; return { min: range?.minBps == null ? '' : String(range.minBps / 100), max: range?.maxBps == null ? '' : String(range.maxBps / 100) }; }));
        setMessage('Loaded for editing.');
      }} className="mr-2 mt-2 min-h-11 rounded border border-[#5DBE81]/30 px-3">Edit</button>
      <button type="button" onClick={() => remove(match.id)} className="mt-2 min-h-11 rounded border border-red-500/30 px-3 text-red-300">Remove</button>
    </div>)}</div>}
  </section>;
}
