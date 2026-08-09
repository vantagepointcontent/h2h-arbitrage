'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, ScanLine } from 'lucide-react';

export interface BatchScanPair {
  kalshiUrl: string;
  polymarketUrl: string;
}

export interface BatchParseResult {
  pairs: BatchScanPair[];
  errors: string[];
}

export function parseBatchScanInput(input: string): BatchParseResult {
  const links = input
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const pairs: BatchScanPair[] = [];
  const errors: string[] = [];

  for (let index = 0; index < links.length; index += 2) {
    const pairNumber = index / 2 + 1;
    const first = links[index];
    const second = links[index + 1];
    if (!second) {
      errors.push(`Pair ${pairNumber} is incomplete: add one more link.`);
      continue;
    }
    const kalshi = [first, second].find((url) => /^https?:\/\/(www\.)?kalshi\.com\//i.test(url));
    const polymarket = [first, second].find((url) => /^https?:\/\/(www\.)?polymarket\.com\//i.test(url));
    if (!kalshi || !polymarket) {
      errors.push(`Pair ${pairNumber} must contain one Kalshi link and one Polymarket link.`);
      continue;
    }
    pairs.push({ kalshiUrl: kalshi, polymarketUrl: polymarket });
  }

  return { pairs, errors };
}

type BatchRow = {
  pair: BatchScanPair;
  status: 'pending' | 'scanning' | 'saved' | 'duplicate' | 'failed';
  title?: string;
  error?: string;
  durationSec?: number;
};

export default function BatchScanPanel({ onComplete }: { onComplete: () => Promise<unknown> | unknown }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [running, setRunning] = useState(false);
  const parsed = useMemo(() => parseBatchScanInput(input), [input]);

  const run = async () => {
    if (running || parsed.errors.length || parsed.pairs.length === 0) return;
    const initial = parsed.pairs.map((pair) => ({ pair, status: 'pending' as const }));
    setRows(initial);
    setRunning(true);

    for (let index = 0; index < parsed.pairs.length; index++) {
      const pair = parsed.pairs[index];
      const started = performance.now();
      setRows((current) => current.map((row, i) => i === index ? { ...row, status: 'scanning' } : row));
      try {
        const scanResponse = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platformLinks: [
              { platform: 'kalshi', url: pair.kalshiUrl },
              { platform: 'polymarket', url: pair.polymarketUrl },
            ],
            capital: 100,
          }),
        });
        const scan = await scanResponse.json();
        if (!scanResponse.ok) throw new Error(scan.error || 'Scan failed');

        const saveResponse = await fetch('/api/saved-markets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kalshiUrl: pair.kalshiUrl,
            polymarketUrl: pair.polymarketUrl,
            eventTitle: scan.eventTitle,
            category: scan.category,
          }),
        });
        const saved = await saveResponse.json().catch(() => ({}));
        const duplicate = saveResponse.status === 409 || String(saved.error || '').includes('already exists');
        if (!saveResponse.ok && !duplicate) throw new Error(saved.error || 'Save failed');
        setRows((current) => current.map((row, i) => i === index ? {
          ...row,
          status: duplicate ? 'duplicate' : 'saved',
          title: scan.eventTitle,
          durationSec: (performance.now() - started) / 1000,
        } : row));
      } catch (cause) {
        setRows((current) => current.map((row, i) => i === index ? {
          ...row,
          status: 'failed',
          error: cause instanceof Error ? cause.message : 'Scan failed',
          durationSec: (performance.now() - started) / 1000,
        } : row));
      }
    }

    await onComplete();
    setRunning(false);
  };

  const completed = rows.filter((row) => row.status === 'saved' || row.status === 'duplicate' || row.status === 'failed').length;

  return <section className="mb-4 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
    <button type="button" onClick={() => setOpen((value) => !value)} className="flex min-h-11 w-full items-center justify-between px-4 py-3 text-left">
      <span className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]"><ScanLine className="h-4 w-4 text-[var(--status-positive)]"/>Batch Scan</span>
      {open ? <ChevronDown className="h-4 w-4"/> : <ChevronRight className="h-4 w-4"/>}
    </button>
    {open && <div className="space-y-3 border-t border-[var(--border-subtle)] p-4">
      <div className="text-xs text-[var(--text-secondary)]">Paste links in pairs: links 1–2 are one market, 3–4 the next. Newlines, blank lines and commas are accepted; platform order does not matter. Successful scans are saved automatically.</div>
      <textarea aria-label="Batch market links" value={input} onChange={(event) => setInput(event.target.value)} disabled={running} rows={9} placeholder={'Kalshi URL\nPolymarket URL\n\nPolymarket URL, Kalshi URL'} className="w-full resize-y rounded-lg border border-[var(--border-strong)] bg-[var(--surface-workspace)] p-3 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--status-positive)] disabled:opacity-60"/>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-[var(--text-secondary)]">{parsed.pairs.length} valid pair{parsed.pairs.length === 1 ? '' : 's'}{running ? ` · ${completed}/${rows.length} completed` : ''}</div>
        <button type="button" onClick={run} disabled={running || parsed.pairs.length === 0 || parsed.errors.length > 0} className="flex min-h-11 items-center gap-2 rounded-lg bg-[var(--status-positive)] px-5 py-2.5 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50">
          {running ? <Loader2 className="h-4 w-4 animate-spin"/> : <ScanLine className="h-4 w-4"/>}{running ? `Scanning ${completed + 1}/${rows.length}` : 'Submit batch'}
        </button>
      </div>
      {parsed.errors.length > 0 && <div role="alert" className="space-y-1 rounded-lg border border-[var(--status-negative)]/40 bg-[var(--status-negative)]/10 p-3 text-xs text-[var(--status-negative)]">{parsed.errors.map((error) => <div key={error}>{error}</div>)}</div>}
      {rows.length > 0 && <div className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)]">{rows.map((row, index) => <div key={`${row.pair.kalshiUrl}-${index}`} className="flex items-start justify-between gap-3 p-3 text-xs">
        <div className="min-w-0"><div className="font-medium text-[var(--text-primary)]">Pair {index + 1}{row.title ? ` · ${row.title}` : ''}</div>{row.error && <div className="mt-1 text-[var(--status-negative)]">{row.error}</div>}</div>
        <span className={row.status === 'saved' ? 'text-[var(--status-positive)]' : row.status === 'failed' ? 'text-[var(--status-negative)]' : row.status === 'duplicate' ? 'text-[var(--status-warning)]' : 'text-[var(--text-secondary)]'}>{row.status === 'scanning' ? 'Scanning…' : row.status === 'duplicate' ? 'Already saved' : row.status}{row.durationSec != null ? ` · ${row.durationSec.toFixed(1)}s` : ''}</span>
      </div>)}</div>}
    </div>}
  </section>;
}
