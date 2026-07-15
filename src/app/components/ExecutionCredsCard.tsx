"use client";
// HOOKUP-04 (FEAT-006): Trading credentials management card.
// Renders in Settings. Write-only: values are POSTed to /api/execute and
// never read back — the UI only shows set/missing status per key.

import { useState, useEffect, useCallback } from "react";
import { KeyRound, Trash2, ShieldAlert, CheckCircle2, XCircle, Plug, Loader2 } from "lucide-react";

interface CredStatus {
  kalshi: { keyId: boolean; privateKey: boolean; ready: boolean };
  polymarket: {
    walletKey: boolean;
    apiKey: boolean;
    apiSecret: boolean;
    apiPassphrase: boolean;
    ready: boolean;
  };
  allReady: boolean;
}

const FIELDS: { key: string; label: string; platform: "Kalshi" | "Polymarket"; multiline?: boolean; statusPath: (c: CredStatus) => boolean }[] = [
  { key: "KALSHI_API_KEY_ID", label: "API Key ID", platform: "Kalshi", statusPath: (c) => c.kalshi.keyId },
  { key: "KALSHI_API_PRIVATE_KEY", label: "RSA Private Key (PEM)", platform: "Kalshi", multiline: true, statusPath: (c) => c.kalshi.privateKey },
  { key: "POLYMARKET_PRIVATE_KEY", label: "Wallet Private Key", platform: "Polymarket", statusPath: (c) => c.polymarket.walletKey },
  { key: "POLYMARKET_API_KEY", label: "CLOB API Key", platform: "Polymarket", statusPath: (c) => c.polymarket.apiKey },
  { key: "POLYMARKET_API_SECRET", label: "CLOB API Secret", platform: "Polymarket", statusPath: (c) => c.polymarket.apiSecret },
  { key: "POLYMARKET_API_PASSPHRASE", label: "CLOB Passphrase", platform: "Polymarket", statusPath: (c) => c.polymarket.apiPassphrase },
];

export function ExecutionCredsCard() {
  const [status, setStatus] = useState<CredStatus | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ kalshi?: { ok: boolean; detail: string }; polymarket?: { ok: boolean; detail: string } } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/execute");
      if (res.ok) {
        const data = await res.json();
        setStatus(data.credentials);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test-connection", platform: "both" }),
      });
      const data = await res.json();
      setTestResult(data.results || {});
    } catch (e: any) {
      setTestResult({ kalshi: { ok: false, detail: e.message || "Network error" } });
    } finally {
      setTesting(false);
    }
  };

  const save = async (key: string) => {
    if (!draft.trim()) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-credential", key, value: draft }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus(data.credentials);
        setMsg(`${key} saved.`);
        setEditing(null);
        setDraft("");
      } else {
        setErr(data.error || "Save failed");
      }
    } catch (e: any) {
      setErr(e.message || "Network error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key: string) => {
    setBusy(true); setErr(""); setMsg("");
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove-credential", key }),
      });
      const data = await res.json();
      if (res.ok) { setStatus(data.credentials); setMsg(`${key} removed.`); }
      else setErr(data.error || "Remove failed");
    } catch (e: any) {
      setErr(e.message || "Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-6 rounded-xl border border-[#182533] bg-[#17212B]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#182533]">
        <div className="flex items-center gap-2 text-[#8A9BA8] font-semibold text-sm uppercase tracking-wide">
          <KeyRound className="w-4 h-4" /> Trading Credentials
        </div>
        <div className="flex items-center gap-2">
          {status && (
            <span className={`text-[11px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wide ${status.allReady ? "border-[#5DBE81]/40 bg-[#5DBE81]/10 text-[#5DBE81]" : "border-amber-500/40 bg-amber-500/10 text-amber-400"}`}>
              {status.allReady ? "ready" : "incomplete"}
            </span>
          )}
          <button
            onClick={testConnection}
            disabled={testing || !status?.allReady}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#0E1621] border border-[#182533] text-xs hover:border-[#5DBE81] transition-colors disabled:opacity-50"
            title="Test API connection with stored credentials"
          >
            {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plug className="w-3 h-3" />}
            {testing ? "Testing..." : "Test"}
          </button>
        </div>
      </div>

      {/* Test connection results */}
      {testResult && (
        <div className="mx-4 mt-3 space-y-1.5">
          {testResult.kalshi && (
            <div className={`flex items-center gap-2 p-2 rounded-lg text-xs ${testResult.kalshi.ok ? "border border-[#5DBE81]/40 bg-[#5DBE81]/10 text-[#5DBE81]" : "border border-red-800 bg-red-950/40 text-red-400"}`}>
              {testResult.kalshi.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
              <span className="font-medium">Kalshi:</span> <span className="font-mono text-[10px]">{testResult.kalshi.detail}</span>
            </div>
          )}
          {testResult.polymarket && (
            <div className={`flex items-center gap-2 p-2 rounded-lg text-xs ${testResult.polymarket.ok ? "border border-[#5DBE81]/40 bg-[#5DBE81]/10 text-[#5DBE81]" : "border border-red-800 bg-red-950/40 text-red-400"}`}>
              {testResult.polymarket.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
              <span className="font-medium">Polymarket:</span> <span className="font-mono text-[10px]">{testResult.polymarket.detail}</span>
            </div>
          )}
        </div>
      )}

      <div className="px-4 py-3 flex items-start gap-2 text-xs text-amber-400/90 bg-amber-500/5 border-b border-[#182533]">
        <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          Execution is <b>manual-only</b> — trades fire exclusively from an explicit Execute action, never automatically.
          Values are stored server-side (.env.local, mode 600) and are never displayed after saving.
          The kill switch above must be OFF and dry-run disabled before any real order is possible.
        </span>
      </div>

      {msg && <div className="mx-4 mt-3 p-2 rounded-lg border border-[#5DBE81]/40 bg-[#5DBE81]/10 text-[#5DBE81] text-xs">{msg}</div>}
      {err && <div className="mx-4 mt-3 p-2 rounded-lg border border-red-800 bg-red-950/40 text-red-400 text-xs">{err}</div>}

      <div className="divide-y divide-[#182533]">
        {FIELDS.map((f) => {
          const isSet = status ? f.statusPath(status) : false;
          const isEditing = editing === f.key;
          return (
            <div key={f.key} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {isSet
                    ? <CheckCircle2 className="w-4 h-4 text-[#5DBE81] shrink-0" />
                    : <XCircle className="w-4 h-4 text-[#8A9BA8] shrink-0" />}
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      <span className="text-[#8A9BA8]">{f.platform} · </span>{f.label}
                    </div>
                    <div className="text-[10px] text-[#8A9BA8] font-mono">{f.key} — {isSet ? "set" : "not set"}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {!isEditing && (
                    <button
                      onClick={() => { setEditing(f.key); setDraft(""); setMsg(""); setErr(""); }}
                      className="px-2.5 py-1 rounded-lg bg-[#0E1621] border border-[#182533] text-xs hover:border-[#5DBE81] transition-colors"
                    >
                      {isSet ? "Replace" : "Add"}
                    </button>
                  )}
                  {isSet && !isEditing && (
                    <button
                      onClick={() => remove(f.key)}
                      disabled={busy}
                      className="p-1.5 rounded-lg bg-[#0E1621] border border-[#182533] text-[#ef4444] hover:border-[#ef4444] transition-colors disabled:opacity-50"
                      title={`Remove ${f.key}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              {isEditing && (
                <div className="mt-2 flex flex-col gap-2">
                  {f.multiline ? (
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={5}
                      placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;..."
                      className="w-full px-2 py-1.5 rounded-lg bg-[#0E1621] border border-[#182533] text-xs font-mono focus:border-[#5DBE81] outline-none resize-y"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  ) : (
                    <input
                      type="password"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={`Paste ${f.label}`}
                      className="w-full px-2 py-1.5 rounded-lg bg-[#0E1621] border border-[#182533] text-sm font-mono focus:border-[#5DBE81] outline-none"
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => save(f.key)}
                      disabled={busy || !draft.trim()}
                      className="px-3 py-1 rounded-lg bg-[#5DBE81] text-black text-xs font-semibold hover:bg-[#4DA66E] transition-colors disabled:opacity-50"
                    >
                      {busy ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={() => { setEditing(null); setDraft(""); }}
                      className="px-3 py-1 rounded-lg bg-[#0E1621] border border-[#182533] text-xs hover:border-[#5E6875] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
