'use client';

/**
 * TRADES-001: Global execution mode indicator — shows a persistent badge
 * in the top header so the user always knows whether trades are in TEST
 * (dry-run) or REAL (live) mode.
 *
 * Mode is derived from the server-side kill switch + dry-run settings:
 *   - kill switch ON  → TEST (blocked)
 *   - kill switch OFF + dry-run ON  → TEST (simulated)
 *   - kill switch OFF + dry-run OFF → REAL (live orders)
 *
 * Polls /api/execute GET every 30s. Color coded:
 *   TEST = blue/gray, REAL = red (danger).
 */

import { useEffect, useState } from 'react';
import { Shield, ShieldAlert, ShieldCheck } from 'lucide-react';

type Mode = 'test' | 'real' | 'blocked' | 'loading';

export default function ExecutionModeBadge() {
  const [mode, setMode] = useState<Mode>('loading');

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/execute', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const killSwitch = data.killSwitch ?? true;
        const dryRun = data.limits?.dryRunMode ?? true;
        if (killSwitch) {
          setMode('blocked');
        } else if (dryRun) {
          setMode('test');
        } else {
          setMode('real');
        }
      } catch { /* ignore — keep last known state */ }
    };
    poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (mode === 'loading') {
    return (
      <span className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[#182533] bg-[#0E1621] text-[10px] font-bold uppercase tracking-wide text-[#8A9BA8]">
        <Shield className="w-3 h-3" /> …
      </span>
    );
  }

  if (mode === 'blocked') {
    return (
      <span className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[#182533] bg-[#0E1621] text-[10px] font-bold uppercase tracking-wide text-[#8A9BA8]" title="Kill switch is ON — all execution blocked">
        <ShieldAlert className="w-3 h-3" /> Blocked
      </span>
    );
  }

  if (mode === 'test') {
    return (
      <span className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-blue-500/40 bg-blue-500/10 text-[10px] font-bold uppercase tracking-wide text-blue-400" title="Dry-run mode — simulated orders only">
        <ShieldCheck className="w-3 h-3" /> Test
      </span>
    );
  }

  return (
    <span className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-red-500/40 bg-red-500/10 text-[10px] font-bold uppercase tracking-wide text-red-400 animate-pulse" title="REAL mode — live orders will be placed">
      <ShieldAlert className="w-3 h-3" /> Real
    </span>
  );
}