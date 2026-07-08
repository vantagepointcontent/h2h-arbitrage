"use client";

/**
 * SETTINGS-001: Settings panel — DB-backed config with hot-reload.
 * Sections: Alerts, Scanner, Auto-Discovery, Auto-Execute, Display, System.
 * Changes take effect live (~10s cache TTL) — no restart needed.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  classifyWatcherStatus,
  computeMsgRate,
  tickFreshness,
  freshnessColor,
  statusPillClasses,
  type WatcherHealthPayload,
} from "@/lib/watcher-status";
import { ExecutionCredsCard } from "@/app/components/ExecutionCredsCard";
import {
  Settings as SettingsIcon,
  Bell,
  Radar,
  Search,
  Zap,
  Monitor,
  Activity,
  RotateCcw,
  Save,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";

interface ResolvedSetting {
  key: string;
  section: string;
  label: string;
  description: string;
  type: "number" | "boolean" | "string";
  env?: string;
  default: number | boolean | string;
  min?: number;
  max?: number;
  slider?: boolean;
  dangerous?: boolean;
  options?: string[];
  value: number | boolean | string;
  source: "db" | "env" | "default";
  updatedAt: string | null;
}

interface HealthInfo {
  [key: string]: unknown;
}

const SECTIONS: { id: string; label: string; icon: React.ReactNode }[] = [
  { id: "alerts", label: "Alerts", icon: <Bell className="w-4 h-4" /> },
  { id: "scanner", label: "Scanner", icon: <Radar className="w-4 h-4" /> },
  { id: "auto-discovery", label: "Auto-Discovery", icon: <Search className="w-4 h-4" /> },
  { id: "auto-execute", label: "Auto-Execute", icon: <Zap className="w-4 h-4" /> },
  { id: "lifecycle", label: "Lifecycle", icon: <Radar className="w-4 h-4" /> },
  { id: "display", label: "Display", icon: <Monitor className="w-4 h-4" /> },
];

const TOKEN = process.env.NEXT_PUBLIC_H2H_API_TOKEN;

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) h["x-h2h-token"] = TOKEN;
  return h;
}

export default function SettingsPanel() {
  const [settings, setSettings] = useState<ResolvedSetting[]>([]);
  const [dirty, setDirty] = useState<Record<string, number | boolean | string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [confirmDanger, setConfirmDanger] = useState<string | null>(null);

  // WS-106: watcher health polling (15s) + msgs/sec derivation
  const [watcherHealth, setWatcherHealth] = useState<WatcherHealthPayload | null>(null);
  const [msgRate, setMsgRate] = useState<number | null>(null);
  const prevSampleRef = useRef<{ msgCount: number; ts: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/watcher/health", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data: WatcherHealthPayload = await res.json();
        if (cancelled) return;
        setMsgRate(computeMsgRate(prevSampleRef.current, { msgCount: data.msgCount, ts: data.ts }));
        if (typeof data.msgCount === "number" && data.ts) {
          prevSampleRef.current = { msgCount: data.msgCount, ts: data.ts };
        }
        setWatcherHealth(data);
      } catch {
        if (!cancelled) setWatcherHealth(null);
      }
    };
    poll();
    const id = setInterval(poll, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sRes, hRes] = await Promise.all([
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/health", { cache: "no-store" }).catch(() => null),
      ]);
      if (!sRes.ok) throw new Error(`Settings load failed (${sRes.status})`);
      const data = await sRes.json();
      setSettings(data.settings ?? []);
      if (hRes?.ok) setHealth(await hRes.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const effectiveValue = (s: ResolvedSetting) =>
    s.key in dirty ? dirty[s.key] : s.value;

  const setValue = (key: string, value: number | boolean | string) => {
    setDirty((d) => ({ ...d, [key]: value }));
    setSavedMsg(null);
  };

  const dirtyCount = Object.keys(dirty).length;

  const save = async () => {
    if (!dirtyCount) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ values: dirty }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details?.join("; ") ?? data.error ?? "Save failed");
      setSettings(data.settings ?? []);
      const changed = Object.keys(dirty).join(", ");
      setDirty({});
      setSavedMsg(`Saved: ${changed}. Live within ~10s.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const resetKey = async (key: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ reset: key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Reset failed");
      setSettings(data.settings ?? []);
      setDirty((d) => { const n = { ...d }; delete n[key]; return n; });
      setSavedMsg(`${key} reset to ${data.settings?.find((s: ResolvedSetting) => s.key === key)?.source ?? "fallback"} value.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#8A9BA8]">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading settings…
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto pb-24">
      <div className="flex items-center gap-3 mb-1">
        <SettingsIcon className="w-6 h-6 text-[#5DBE81]" />
        <h2 className="text-xl font-bold">Settings</h2>
      </div>
      <p className="text-sm text-[#8A9BA8] mb-6">
        DB-backed overrides — changes apply live within ~10 seconds, no restart. Source shows where each value comes from (db → env → default).
      </p>

      {error && (
        <div className="mb-4 p-3 rounded-lg border border-red-800 bg-red-950/40 text-red-400 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}
      {savedMsg && (
        <div className="mb-4 p-3 rounded-lg border border-[#5DBE81]/40 bg-[#5DBE81]/10 text-[#5DBE81] text-sm">
          {savedMsg}
        </div>
      )}

      {SECTIONS.map((sec) => {
        const items = settings.filter((s) => s.section === sec.id);
        if (!items.length) return null;
        return (
          <div key={sec.id} className="mb-6 rounded-xl border border-[#182533] bg-[#17212B]">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[#182533] text-[#8A9BA8] font-semibold text-sm uppercase tracking-wide">
              {sec.icon} {sec.label}
            </div>
            <div className="divide-y divide-[#182533]">
              {items.map((s) => {
                const val = effectiveValue(s);
                const isDirty = s.key in dirty;
                return (
                  <div key={s.key} className={`px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 ${isDirty ? "bg-[#5DBE81]/5" : ""}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{s.label}</span>
                        {isDirty && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#5DBE81]/20 text-[#5DBE81]">unsaved</span>}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.source === "db" ? "bg-blue-500/20 text-blue-400" : s.source === "env" ? "bg-amber-500/20 text-amber-400" : "bg-[#182533] text-[#8A9BA8]"}`}>
                          {s.source}
                        </span>
                        {s.dangerous && <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />}
                      </div>
                      <p className="text-xs text-[#8A9BA8] mt-0.5">{s.description}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {s.type === "boolean" ? (
                        <button
                          onClick={() => {
                            const next = !(val as boolean);
                            if (s.dangerous && next === false) {
                              setConfirmDanger(s.key);
                            } else {
                              setValue(s.key, next);
                            }
                          }}
                          className={`relative w-11 h-6 shrink-0 rounded-full transition-colors !min-h-0 !p-0 ${val ? "bg-[#5DBE81]" : "bg-[#2A3644]"}`}
                          title={String(val)}
                        >
                          <span className={`absolute left-0 top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${val ? "translate-x-[22px]" : "translate-x-0.5"}`} />
                        </button>
                      ) : s.type === "number" && s.slider ? (
                        <div className="flex items-center gap-2 w-56">
                          <input
                            type="range"
                            min={s.min ?? 0}
                            max={s.max ?? 100}
                            step={(() => { const r = (s.max ?? 100) - (s.min ?? 0); return r <= 50 ? 0.5 : r <= 200 ? 1 : r <= 5000 ? 10 : 1000; })()}
                            value={Number(val)}
                            onChange={(e) => setValue(s.key, Number(e.target.value))}
                            className="settings-slider flex-1"
                          />
                          <span className="text-sm w-16 text-right tabular-nums">{val}</span>
                        </div>
                      ) : s.type === "number" ? (
                        <input
                          type="number"
                          min={s.min}
                          max={s.max}
                          value={Number(val)}
                          onChange={(e) => setValue(s.key, Number(e.target.value))}
                          className="w-28 px-2 py-1 rounded-lg bg-[#0E1621] border border-[#182533] text-sm text-right focus:border-[#5DBE81] outline-none"
                        />
                      ) : s.options ? (
                        <select
                          value={String(val)}
                          onChange={(e) => setValue(s.key, e.target.value)}
                          className="px-2 py-1 rounded-lg bg-[#0E1621] border border-[#182533] text-sm focus:border-[#5DBE81] outline-none"
                        >
                          {s.options.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={String(val)}
                          onChange={(e) => setValue(s.key, e.target.value)}
                          className="w-40 px-2 py-1 rounded-lg bg-[#0E1621] border border-[#182533] text-sm focus:border-[#5DBE81] outline-none"
                        />
                      )}
                      {s.source === "db" && (
                        <button onClick={() => resetKey(s.key)} className="p-1.5 rounded-lg hover:bg-[#182533] text-[#8A9BA8] hover:text-white" title="Reset to env/default">
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* HOOKUP-04: trading credentials (manual execution only) */}
      <ExecutionCredsCard />

      {/* WS-106: Watcher health card */}
      <div className="mb-6 rounded-xl border border-[#182533] bg-[#17212B]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#182533]">
          <div className="flex items-center gap-2 text-[#8A9BA8] font-semibold text-sm uppercase tracking-wide">
            <Activity className="w-4 h-4" /> Watcher
          </div>
          {(() => {
            const level = classifyWatcherStatus(watcherHealth);
            return (
              <span className={`text-[11px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wide ${statusPillClasses(level)}`}>
                {level}
              </span>
            );
          })()}
        </div>
        <div className="px-4 py-3 text-sm">
          {watcherHealth ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-lg bg-[#0E1621] border border-[#182533] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-[#8A9BA8]">Kalshi WS</div>
                  <div className={`text-sm font-medium ${watcherHealth.kalshiConnected ? "text-[#5DBE81]" : "text-[#ef4444]"}`}>
                    {watcherHealth.kalshiConnected ? "connected" : "disconnected"}
                  </div>
                </div>
                <div className="rounded-lg bg-[#0E1621] border border-[#182533] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-[#8A9BA8]">PM WS</div>
                  <div className="text-sm font-medium">{watcherHealth.pmConnections ?? "—"}</div>
                </div>
                <div className="rounded-lg bg-[#0E1621] border border-[#182533] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-[#8A9BA8]">HOT pairs</div>
                  <div className="text-sm font-medium text-[#5DBE81]">
                    {watcherHealth.hotPairs ?? 0}
                    <span className="text-[#8A9BA8] font-normal"> / {watcherHealth.tierStats?.pairs ?? "?"}</span>
                  </div>
                </div>
                <div className="rounded-lg bg-[#0E1621] border border-[#182533] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-[#8A9BA8]">Msgs/sec</div>
                  <div className="text-sm font-medium tabular-nums">{msgRate === null ? "—" : msgRate}</div>
                </div>
                <div className="rounded-lg bg-[#0E1621] border border-[#182533] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-[#8A9BA8]">Subscriptions</div>
                  <div className="text-sm font-medium">
                    <span className="text-[#facc15]">{watcherHealth.kalshiTickers ?? 0}K</span>
                    <span className="text-[#8A9BA8]"> · </span>
                    <span className="text-[#a78bfa]">{watcherHealth.pmTokens ?? 0}P</span>
                  </div>
                </div>
                <div className="rounded-lg bg-[#0E1621] border border-[#182533] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-[#8A9BA8]">Last tick</div>
                  {(() => {
                    const f = tickFreshness(watcherHealth.lastTickAt);
                    return <div className={`text-sm font-medium ${freshnessColor(f.level)}`}>{f.label}</div>;
                  })()}
                </div>
                <div className="rounded-lg bg-[#0E1621] border border-[#182533] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-[#8A9BA8]">Degraded</div>
                  <div className={`text-sm font-medium ${watcherHealth.integrity?.degraded ? "text-[#ef4444]" : "text-[#5DBE81]"}`}>
                    {watcherHealth.integrity?.degraded ? "YES" : "no"}
                  </div>
                </div>
                <div className="rounded-lg bg-[#0E1621] border border-[#182533] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-[#8A9BA8]">Last reconcile</div>
                  {(() => {
                    const f = tickFreshness(watcherHealth.integrity?.lastReconcileAt ?? null);
                    return <div className={`text-sm font-medium ${freshnessColor(f.level)}`}>{f.label}</div>;
                  })()}
                </div>
              </div>
              {watcherHealth.integrity && (
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#8A9BA8]">
                  <span>seq gaps: <span className="text-[#8A9BA8]">{watcherHealth.integrity.seqGaps ?? 0}</span></span>
                  <span>stale reseeds: <span className="text-[#8A9BA8]">{watcherHealth.integrity.staleReseeds ?? 0}</span></span>
                  <span>reconcile passes: <span className="text-[#8A9BA8]">{watcherHealth.integrity.reconcilePasses ?? 0}</span></span>
                  <span>disagreements: <span className="text-[#8A9BA8]">{watcherHealth.integrity.reconcileDisagreements ?? 0}</span></span>
                  <span>flaps: <span className="text-[#8A9BA8]">{watcherHealth.integrity.flapsInWindow ?? 0}</span></span>
                </div>
              )}
              {watcherHealth.error && (
                <div className="mt-2 text-xs text-[#ef4444]">{watcherHealth.error}</div>
              )}
            </>
          ) : (
            <span className="text-[#8A9BA8]">Watcher health endpoint unavailable.</span>
          )}
        </div>
      </div>

      {/* System (read-only) */}
      <div className="mb-6 rounded-xl border border-[#182533] bg-[#17212B]">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#182533] text-[#8A9BA8] font-semibold text-sm uppercase tracking-wide">
          <Activity className="w-4 h-4" /> System
        </div>
        <div className="px-4 py-3 text-sm">
          {health ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {Object.entries(health).map(([k, v]) => (
                <div key={k} className="rounded-lg bg-[#0E1621] border border-[#182533] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-[#8A9BA8]">{k}</div>
                  <div className={`text-sm font-medium truncate ${k === "status" && v === "ok" ? "text-[#5DBE81]" : ""}`} title={String(typeof v === "object" ? JSON.stringify(v) : v)}>
                    {typeof v === "object" ? JSON.stringify(v) : String(v)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-[#8A9BA8]">Health endpoint unavailable.</span>
          )}
        </div>
      </div>

      {/* Sticky save bar */}
      {dirtyCount > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2.5 rounded-xl border border-[#182533] bg-[#0E1621] shadow-xl">
          <span className="text-sm text-[#8A9BA8]">{dirtyCount} unsaved change{dirtyCount > 1 ? "s" : ""}</span>
          <button onClick={() => setDirty({})} className="px-3 py-1.5 rounded-lg text-sm text-[#8A9BA8] hover:text-white hover:bg-[#182533]">
            Discard
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[#5DBE81] text-black text-sm font-semibold hover:bg-[#4faf73] disabled:opacity-50"
          >
            <Save className="w-4 h-4" /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      {/* Dangerous confirm modal */}
      {confirmDanger && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setConfirmDanger(null)}>
          <div className="max-w-md mx-4 p-5 rounded-xl border border-red-800 bg-[#0E1621]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-red-400 font-bold mb-2">
              <AlertTriangle className="w-5 h-5" /> Disable dry-run mode?
            </div>
            <p className="text-sm text-[#8A9BA8] mb-4">
              Turning OFF dry-run means executions place REAL orders with REAL money on Kalshi and Polymarket. Are you sure?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDanger(null)} className="px-4 py-1.5 rounded-lg text-sm bg-[#182533] hover:bg-[#243447]">
                Cancel
              </button>
              <button
                onClick={() => { setValue(confirmDanger, false); setConfirmDanger(null); }}
                className="px-4 py-1.5 rounded-lg text-sm bg-red-600 hover:bg-red-500 font-semibold"
              >
                Yes, go live
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
