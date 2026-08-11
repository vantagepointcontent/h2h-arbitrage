'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';

type LogStatus = 'passed' | 'failed' | 'pending';
interface ActionStep { id:number; timestamp:string; step:string; action:string; responseStatus:LogStatus; errorReason:string|null; durationMs:number|null; requestPayload:unknown; responsePayload:unknown; alertMetadata:unknown }
interface TradeChain { tradeId:string; trigger:string; marketId:string; marketTitle:string; startedAt:string; status:LogStatus; qualified:boolean|null; steps:ActionStep[] }
interface ScanDecision { scanId:number; state:string; reasonCode:string; reason:string; updatedAt:string }

const statusClass: Record<LogStatus,string> = { passed:'text-[var(--status-positive)]', failed:'text-[var(--status-negative)]', pending:'text-[var(--status-warning)]' };
const statusIcon: Record<LogStatus,string> = { passed:'✓', failed:'✕', pending:'◷' };
const pretty = (value: unknown) => value == null ? '—' : JSON.stringify(value, null, 2);

export default function BotActionLogs({ selectionMethod }: { selectionMethod?: 'roi' | 'apy' | 'hybrid' }) {
  const [trades,setTrades]=useState<TradeChain[]>([]);
  const [decisions,setDecisions]=useState<ScanDecision[]>([]);
  const [status,setStatus]=useState<'all'|LogStatus>('all');
  const [market,setMarket]=useState('');
  const [since,setSince]=useState('');
  const [expanded,setExpanded]=useState<Set<string>>(new Set());
  const [autoRefresh,setAutoRefresh]=useState(true);
  const [qualifiedOnly,setQualifiedOnly]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);

  const load=useCallback(async()=>{
    const q=new URLSearchParams();
    if(status!=='all') q.set('status',status);
    if(market.trim()) q.set('marketId',market.trim());
    if(since) q.set('since',new Date(`${since}T00:00:00`).toISOString());
    if(qualifiedOnly) q.set('qualified','true');
    try {
      const response=await fetch(`/api/bot-trader/logs?${q}`,{cache:'no-store'});
      const data=await response.json();
      if(!response.ok||!data.success) throw new Error(data.error||'Failed to load action logs');
      setTrades(data.trades||[]); setDecisions(data.decisions||[]); setError(null);
    } catch(cause) { setError(cause instanceof Error?cause.message:'Failed to load action logs'); }
    finally { setLoading(false); }
  },[market,since,status,qualifiedOnly]);

  useEffect(()=>{ void load(); if(!autoRefresh)return; const id=window.setInterval(()=>void load(),30_000); return()=>window.clearInterval(id); },[autoRefresh,load]);

  return <section className="space-y-3" aria-label="BotTrader action logs">
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3">
      <label className="text-xs text-[var(--text-secondary)]">Status<select value={status} onChange={e=>setStatus(e.target.value as typeof status)} className="ml-2 min-h-11 rounded border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]"><option value="all">All</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="pending">Pending</option></select></label>
      <label className="text-xs text-[var(--text-secondary)]">Since<input type="date" value={since} onChange={e=>setSince(e.target.value)} className="ml-2 min-h-11 rounded border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]" /></label>
      <label className="text-xs text-[var(--text-secondary)]">Market ID<input value={market} onChange={e=>setMarket(e.target.value)} placeholder="All markets" className="ml-2 min-h-11 rounded border border-[var(--border-strong)] bg-[var(--surface-workspace)] px-2 text-[var(--text-primary)]" /></label>
      <label className="flex min-h-11 items-center gap-2 text-xs text-[var(--text-secondary)]"><input type="checkbox" checked={autoRefresh} onChange={e=>setAutoRefresh(e.target.checked)} /> Auto-refresh 30s</label>
      <label className={`flex min-h-11 cursor-pointer items-center gap-2 rounded border px-3 text-xs font-semibold ${qualifiedOnly?'border-[var(--status-positive)]/40 bg-[var(--status-positive)]/10 text-[var(--status-positive)]':'border-[var(--border-strong)] text-[var(--text-secondary)]'}`}><input aria-label="Qualified only" type="checkbox" checked={qualifiedOnly} onChange={e=>setQualifiedOnly(e.target.checked)} /> Qualified only</label>
      <span title="Backend-ranked selection method used for new BotTrader evaluations" className="flex min-h-11 items-center rounded border border-[var(--border-strong)] px-3 text-[10px] font-bold uppercase text-[var(--text-primary)]">Method: {selectionMethod ?? 'unknown'}</span>
      <button onClick={()=>void load()} aria-label="Refresh action logs" className="min-h-11 min-w-11 rounded border border-[var(--border-strong)]"><RefreshCw className={`mx-auto h-4 w-4 ${loading?'animate-spin':''}`} /></button>
    </div>
    {error&&<div role="alert" className="rounded border border-[var(--status-negative)]/40 p-3 text-sm text-[var(--status-negative)]">{error}</div>}
    {decisions.length>0&&<div className="space-y-2" aria-label="Persisted scan decisions">
      <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Completed scan reconciliation</h3>
      {decisions.map(decision=><article key={decision.scanId} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2"><strong className="text-[var(--text-primary)]">Scan #{decision.scanId}</strong><span className="rounded bg-[var(--surface-workspace)] px-2 py-1 font-mono">{decision.state}</span><span className="font-mono text-[var(--text-secondary)]">{decision.reasonCode}</span></div>
        <p className="mt-2 text-[var(--text-secondary)]">{decision.reason}</p>
      </article>)}
    </div>}
    <div className="space-y-2">
      {trades.map(trade=>{const open=expanded.has(trade.tradeId);return <article key={trade.tradeId} className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
        <button onClick={()=>setExpanded(current=>{const next=new Set(current);open?next.delete(trade.tradeId):next.add(trade.tradeId);return next})} className="flex min-h-14 w-full items-center gap-3 px-3 text-left">
          {open?<ChevronDown className="h-4 w-4"/>:<ChevronRight className="h-4 w-4"/>}<span className={statusClass[trade.status]}>{statusIcon[trade.status]}</span><span className="min-w-0 flex-1"><strong className="block truncate text-sm text-[var(--text-primary)]">{trade.marketTitle}</strong><span className="text-[10px] text-[var(--text-secondary)]">{new Date(trade.startedAt).toLocaleString()} · {trade.steps.length} steps · {trade.trigger}</span></span>
        </button>
        {open&&<div className="overflow-x-auto border-t border-[var(--border-subtle)]"><table className="w-full min-w-[760px] text-xs"><thead><tr className="text-[var(--text-secondary)]"><th className="p-2 text-left">Time</th><th className="p-2 text-left">Step</th><th className="p-2 text-left">Action</th><th className="p-2 text-left">Status</th><th className="p-2 text-right">Duration</th></tr></thead><tbody>{trade.steps.map(step=><tr key={step.id} className="border-t border-[var(--border-subtle)] align-top"><td className="whitespace-nowrap p-2">{new Date(step.timestamp).toLocaleTimeString()}</td><td className="p-2 font-mono">{step.step}</td><td className="p-2">{step.action}{step.errorReason&&<div className="mt-1 text-[var(--status-negative)]">{step.errorReason}</div>}<details className="mt-1"><summary className="cursor-pointer text-[var(--text-secondary)]">Request / response details</summary><pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-workspace)] p-2 text-[10px]">REQUEST\n{pretty(step.requestPayload)}\n\nRESPONSE\n{pretty(step.responsePayload)}\n\nALERT\n{pretty(step.alertMetadata)}</pre></details></td><td className={`p-2 ${statusClass[step.responseStatus]}`}>{statusIcon[step.responseStatus]} {step.responseStatus}</td><td className="p-2 text-right tabular-nums">{step.durationMs==null?'—':`${step.durationMs} ms`}</td></tr>)}</tbody></table></div>}
      </article>})}
      {!loading&&trades.length===0&&<div className="py-12 text-center text-sm text-[var(--text-secondary)]">{qualifiedOnly?'No qualifying evaluations in the selected period.':'No BotTrader actions match these filters.'}</div>}
    </div>
  </section>;
}
