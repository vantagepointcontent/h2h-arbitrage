'use client';

import { useEffect, useState } from 'react';
import { Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ExecutionMode } from '@/lib/execution-mode';

type BadgeMode = ExecutionMode | 'loading';

export default function ExecutionModeBadge() {
  const [mode, setMode] = useState<BadgeMode>('loading');

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/execute', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && ['paper', 'live-gated', 'live'].includes(data.mode)) setMode(data.mode);
      } catch { /* retain the last known state */ }
    };
    void poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (mode === 'loading') {
    return <span className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[#182533] bg-[#0E1621] text-[10px] font-bold uppercase tracking-wide text-[#8A9BA8]"><Shield className="w-3 h-3" /> …</span>;
  }
  if (mode === 'paper') {
    return <span className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-blue-500/40 bg-blue-500/10 text-[10px] font-bold uppercase tracking-wide text-blue-400" title="Paper mode — simulated orders only"><ShieldCheck className="w-3 h-3" /> Paper</span>;
  }
  if (mode === 'live-gated') {
    return <span className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-amber-500/40 bg-amber-500/10 text-[10px] font-bold uppercase tracking-wide text-amber-400" title="Live-gated — real orders blocked"><ShieldAlert className="w-3 h-3" /> Live gated</span>;
  }
  return <span className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-[10px] font-bold uppercase tracking-wide text-emerald-400 animate-pulse" title="Live mode — explicit manual actions place real orders"><ShieldAlert className="w-3 h-3" /> Live</span>;
}
