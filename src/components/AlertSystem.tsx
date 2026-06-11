"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bell, BellOff, Volume2, VolumeX, History, X, Settings, Play, Square, Trash2 } from "lucide-react";

// ─── Types ───────────────────────────────────────────────

export interface AlertSettings {
  enabled: boolean;
  minRoiPct: number;         // Lower threshold — alert when ROI >= this
  maxSpreadPct: number;       // Upper threshold — alert when spread <= this (tight spread = good)
  soundEnabled: boolean;
  browserNotifications: boolean;
  notifyOnCross: "enter" | "exit" | "both"; // Alert when crossing threshold in/out
}

export interface AlertEntry {
  id: string;
  marketTitle: string;
  marketId: string;
  roiPct: number;
  strategy: string;
  profit: number;
  direction: "above" | "below"; // Above min threshold or below max spread
  timestamp: string;
  notified: boolean; // Was browser notification sent?
}

export interface ToastMessage {
  id: string;
  title: string;
  message: string;
  type: "success" | "warning" | "info" | "alert";
  timestamp: number;
}

const DEFAULT_SETTINGS: AlertSettings = {
  enabled: true,
  minRoiPct: 5,           // Alert when ROI >= 5%
  maxSpreadPct: 20,       // Alert when spread (100 - buyPrice) <= 20 cents (very cheap buy)
  soundEnabled: true,
  browserNotifications: false,
  notifyOnCross: "both",
};

const SETTINGS_KEY = "h2h-alert-settings";
const HISTORY_KEY = "h2h-alert-history";
const MAX_HISTORY = 100;

// ─── Helpers ─────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadSettings(): AlertSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore corrupt storage */ }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: AlertSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* quota exceeded */ }
}

function loadHistory(): AlertEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveHistory(history: AlertEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
  } catch { /* quota exceeded */ }
}

// ─── Sound utility ───────────────────────────────────────

// Generate a pleasant alert chime using Web Audio API (no external files needed)
function playAlertSound(): void {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.15); // E5
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch { /* Audio not available */ }
}

// ─── Browser Notification ────────────────────────────────

async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const perm = await Notification.requestPermission();
  return perm === "granted";
}

function sendBrowserNotification(title: string, body: string): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(title, {
      body,
      icon: "/favicon.ico",
      tag: `h2h-${Date.now()}`, // Unique tag so each notification stacks
    });
  } catch { /* ignore */ }
}

// ─── Hook: useAlertSystem ────────────────────────────────

interface UseAlertSystemReturn {
  settings: AlertSettings;
  setSettings: React.Dispatch<React.SetStateAction<AlertSettings>>;
  history: AlertEntry[];
  clearHistory: () => void;
  toasts: ToastMessage[];
  dismissToast: (id: string) => void;
  clearToasts: () => void;
  checkAndFire: (marketTitle: string, marketId: string, roiPct: number, strategy: string, profit: number) => void;
  notificationPermission: "default" | "granted" | "denied" | "unsupported";
  onRequestPermission: () => Promise<void>;
}

export function useAlertSystem(): UseAlertSystemReturn {
  const [settings, setSettingsState] = useState<AlertSettings>(loadSettings);
  const [history, setHistory] = useState<AlertEntry[]>(loadHistory);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [notifPerm, setNotifPerm] = useState<"default" | "granted" | "denied" | "unsupported">("default");
  const prevRoiRef = useRef<Map<string, number>>(new Map()); // Track previous ROI per market to detect crossings

  // Sync settings to localStorage
  const setSettings = useCallback(( updater: React.SetStateAction<AlertSettings> ) => {
    setSettingsState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      saveSettings(next);
      return next;
    });
  }, []);

  // Init notification permission state
  useEffect(() => {
    if (!("Notification" in window)) {
      setNotifPerm("unsupported");
      return;
    }
    setNotifPerm(Notification.permission);
    const handler = () => setNotifPerm(Notification.permission);
    try {
      const notifAny = Notification as unknown as { addEventListener: (e: string, h: () => void) => void; removeEventListener: (e: string, h: () => void) => void };
      if (typeof notifAny.addEventListener === "function") {
        notifAny.addEventListener("permissionchange", handler);
        return () => {
          if (typeof notifAny.removeEventListener === "function") {
            notifAny.removeEventListener("permissionchange", handler);
          }
        };
      }
    } catch {
      // Browser doesn't support permissionchange events — skip
    }
  }, []);

  const onRequestPermission = useCallback(async () => {
    await requestNotificationPermission();
    setSettings((s) => ({ ...s, browserNotifications: true }));
  }, [setSettings]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
  }, []);

  const checkAndFire = useCallback((
    marketTitle: string,
    marketId: string,
    roiPct: number,
    strategy: string,
    profit: number,
  ): void => {
    if (!settings.enabled || roiPct <= 0) return;

    const prevRoi = prevRoiRef.current.get(marketId);
    const prevAbove = prevRoi !== undefined ? prevRoi >= settings.minRoiPct : undefined;
    const currAbove = roiPct >= settings.minRoiPct;

    // Determine if we should fire based on crossing behavior
    let shouldFire = false;
    let direction: "above" | "below";

    if (settings.notifyOnCross === "both") {
      // Fire if currently above threshold, OR just crossed
      if (currAbove && prevAbove === false) {
        shouldFire = true;
        direction = "above";
      } else if (!currAbove && prevAbove === true) {
        shouldFire = true;
        direction = "below";
      } else if (currAbove && prevAbove === undefined) {
        // First time seeing this market — fire if above
        shouldFire = true;
        direction = "above";
      }
    } else if (settings.notifyOnCross === "enter") {
      shouldFire = currAbove && prevAbove === false;
      direction = "above";
    } else {
      // "exit"
      shouldFire = !currAbove && prevAbove === true;
      direction = "below";
    }

    // Also fire if ROI exceeds threshold significantly (>= minRoiPct) and we haven't recently alerted
    if (!shouldFire && currAbove) {
      // Check if last alert for this market was more than 5 minutes ago
      const lastAlert = history.find(
        (h) => h.marketId === marketId && h.direction === "above"
      );
      if (!lastAlert) {
        shouldFire = true;
        direction = "above";
      } else {
        const ageMin = (Date.now() - new Date(lastAlert.timestamp).getTime()) / 60000;
        if (ageMin > 5) {
          shouldFire = true;
          direction = "above";
        }
      }
    }

    if (!shouldFire) {
      prevRoiRef.current.set(marketId, roiPct);
      return;
    }

    // Build alert entry
    const entry: AlertEntry = {
      id: generateId(),
      marketTitle,
      marketId,
      roiPct,
      strategy,
      profit,
      direction,
      timestamp: new Date().toISOString(),
      notified: false,
    };

    // Add to history
    const newHistory = [...history, entry];
    setHistory(newHistory);
    saveHistory(newHistory);

    // Build toast
    const toast: ToastMessage = {
      id: generateId(),
      title: direction === "above" ? "🟢 Arbitrage Alert!" : "🔴 Opportunity Closed",
      message: `${marketTitle}: ${direction === "above" ? "+${roiPct.toFixed(2)}% ROI" : `${roiPct.toFixed(2)}% ROI (below threshold)`} · ${strategy}`,
      type: direction === "above" ? "success" : "warning",
      timestamp: Date.now(),
    };
    setToasts((prev) => [toast, ...prev].slice(0, 10)); // Keep last 10

    // Sound
    if (settings.soundEnabled) {
      playAlertSound();
    }

    // Browser notification
    if (settings.browserNotifications && Notification.permission === "granted") {
      sendBrowserNotification(
        toast.title,
        toast.message,
      );
      entry.notified = true;
    }

    prevRoiRef.current.set(marketId, roiPct);
  }, [settings, history]);

  return {
    settings,
    setSettings,
    history,
    clearHistory,
    toasts,
    dismissToast,
    clearToasts,
    checkAndFire,
    notificationPermission: notifPerm,
    onRequestPermission,
  };
}

// ─── Toast Container Component ──────────────────────────

export function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}) {
  if (!toasts || toasts.length === 0) return null;

  const colorMap: Record<ToastMessage["type"], string> = {
    success: "border-[#5DBE81]/40 bg-[#17212B]",
    warning: "border-[#facc15]/40 bg-[#17212B]",
    info: "border-[#5DBE81]/40 bg-[#17212B]",
    alert: "border-[#ef4444]/40 bg-[#17212B]",
  };

  return (
    <div className="fixed top-4 right-4 z-[100] space-y-2 max-w-sm w-full pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto rounded-lg border ${colorMap[toast.type]} shadow-xl p-3 animate-slide-in`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-[#FFFFFF]">{toast.title}</div>
              <div className="text-xs text-[#8A9BA8] mt-0.5">{toast.message}</div>
            </div>
            <button
              onClick={() => onDismiss(toast.id)}
              className="shrink-0 p-1 rounded hover:bg-[#182533] text-[#5E6875] hover:text-[#FFFFFF]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Alert Settings Panel ───────────────────────────────

export function AlertSettingsPanel({
  settings,
  onSettingsChange,
  history,
  onClearHistory,
  notificationPermission,
  onRequestPermission,
}: {
  settings: AlertSettings;
  onSettingsChange: React.Dispatch<React.SetStateAction<AlertSettings>>;
  history: AlertEntry[];
  onClearHistory: () => void;
  notificationPermission: "default" | "granted" | "denied" | "unsupported";
  onRequestPermission: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"settings" | "history">("settings");

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm"
         onClick={() => {/* close handled by parent */}}>
      <div
        className="w-full max-w-lg rounded-xl border border-[#232E3C] bg-[#17212B] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#182533]">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-[#5DBE81]" />
            <h2 className="text-base font-semibold">Alert Settings</h2>
          </div>
          <div className="flex gap-1">
            {(["settings", "history"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  tab === t
                    ? "bg-[#5DBE81]/10 text-[#5DBE81]"
                    : "text-[#5E6875] hover:text-[#FFFFFF] hover:bg-[#182533]"
                }`}
              >
                {t === "settings" ? "Settings" : `History (${history.length})`}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {tab === "settings" ? (
            <>
              {/* Master toggle */}
              <div className="flex items-center justify-between p-3 rounded-lg bg-[#182533]">
                <div className="flex items-center gap-2">
                  {settings.enabled ? (
                    <Bell className="w-4 h-4 text-[#5DBE81]" />
                  ) : (
                    <BellOff className="w-4 h-4 text-[#5E6875]" />
                  )}
                  <span className="text-sm font-medium">Enable Alerts</span>
                </div>
                <button
                  onClick={() => onSettingsChange((s) => ({ ...s, enabled: !s.enabled }))}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    settings.enabled ? "bg-[#5DBE81]" : "bg-[#232E3C]"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                      settings.enabled ? "translate-x-5" : ""
                    }`}
                  />
                </button>
              </div>

              {/* Min ROI Threshold */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-[#8A9BA8]">
                    Minimum ROI Threshold
                  </label>
                  <span className="text-sm font-mono text-[#5DBE81]">{settings.minRoiPct}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={0.5}
                  value={settings.minRoiPct}
                  onChange={(e) => onSettingsChange((s) => ({ ...s, minRoiPct: Number(e.target.value) }))}
                  className="w-full accent-[#5DBE81]"
                />
                <div className="flex justify-between text-[10px] text-[#232E3C]">
                  <span>0%</span>
                  <span>Alert when ROI ≥ threshold</span>
                  <span>100%</span>
                </div>
              </div>

              {/* Max Spread Threshold */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-[#8A9BA8]">
                    Maximum Buy Price (cents)
                  </label>
                  <span className="text-sm font-mono text-[#5DBE81]">{settings.maxSpreadPct}¢</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={50}
                  step={1}
                  value={settings.maxSpreadPct}
                  onChange={(e) => onSettingsChange((s) => ({ ...s, maxSpreadPct: Number(e.target.value) }))}
                  className="w-full accent-[#5DBE81]"
                />
                <div className="flex justify-between text-[10px] text-[#232E3C]">
                  <span>1¢</span>
                  <span>Alert when buy price ≤ threshold</span>
                  <span>50¢</span>
                </div>
              </div>

              {/* Notify on cross */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-[#8A9BA8]">Notify When</label>
                <div className="flex gap-2">
                  {(["enter", "exit", "both"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => onSettingsChange((s) => ({ ...s, notifyOnCross: mode }))}
                      className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                        settings.notifyOnCross === mode
                          ? "bg-[#5DBE81]/10 border-[#5DBE81]/30 text-[#5DBE81]"
                          : "bg-[#182533] border-[#232E3C] text-[#5E6875] hover:text-[#FFFFFF]"
                      }`}
                    >
                      {mode === "enter" ? "Enters zone" : mode === "exit" ? "Leaves zone" : "Both"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Sound toggle */}
              <div className="flex items-center justify-between p-3 rounded-lg bg-[#182533]">
                <div className="flex items-center gap-2">
                  {settings.soundEnabled ? (
                    <Volume2 className="w-4 h-4 text-[#5DBE81]" />
                  ) : (
                    <VolumeX className="w-4 h-4 text-[#5E6875]" />
                  )}
                  <span className="text-sm font-medium">Sound Alerts</span>
                </div>
                <button
                  onClick={() => onSettingsChange((s) => ({ ...s, soundEnabled: !s.soundEnabled }))}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    settings.soundEnabled ? "bg-[#5DBE81]" : "bg-[#232E3C]"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                      settings.soundEnabled ? "translate-x-5" : ""
                    }`}
                  />
                </button>
              </div>

              {/* Browser notifications */}
              <div className="flex items-center justify-between p-3 rounded-lg bg-[#182533]">
                <div className="flex items-center gap-2">
                  <Bell className="w-4 h-4 text-[#5DBE81]" />
                  <span className="text-sm font-medium">Browser Notifications</span>
                </div>
                <button
                  onClick={() => onSettingsChange((s) => ({ ...s, browserNotifications: !s.browserNotifications }))}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    settings.browserNotifications ? "bg-[#5DBE81]" : "bg-[#232E3C]"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                      settings.browserNotifications ? "translate-x-5" : ""
                    }`}
                  />
                </button>
              </div>

              {settings.browserNotifications && notificationPermission !== "granted" && (
                <div className="p-3 rounded-lg bg-[#facc15]/10 border border-[#facc15]/30">
                  <p className="text-xs text-[#facc15] mb-2">
                    {notificationPermission === "denied"
                      ? "Notifications blocked. Check browser settings."
                      : notificationPermission === "unsupported"
                      ? "Browser does not support notifications."
                      : "Click below to enable notifications."}
                  </p>
                  {notificationPermission === "default" && (
                    <button
                      onClick={onRequestPermission}
                      className="px-3 py-1.5 rounded-md bg-[#facc15] text-black text-xs font-semibold hover:bg-[#ca8a04] transition-colors"
                    >
                      Request Permission
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            /* History Tab */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-[#5E6875]">{history.length} alerts logged</span>
                <button
                  onClick={onClearHistory}
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[#5E6875] hover:text-[#ef4444] hover:bg-[#ef4444]/10 transition-colors"
                >
                  <Trash2 className="w-3 h-3" /> Clear
                </button>
              </div>

              {history.length === 0 && (
                <div className="py-8 text-center text-sm text-[#232E3C]">
                  No alerts yet. They&apos;ll appear when ROI crosses your threshold.
                </div>
              )}

              {[...history].reverse().map((entry) => (
                <div
                  key={entry.id}
                  className={`p-3 rounded-lg border ${
                    entry.direction === "above"
                      ? "border-[#5DBE81]/20 bg-[#5DBE81]/[0.03]"
                      : "border-[#facc15]/20 bg-[#facc15]/[0.03]"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-xs font-semibold ${
                      entry.direction === "above" ? "text-[#5DBE81]" : "text-[#facc15]"
                    }`}>
                      {entry.marketTitle}
                    </span>
                    <span className="text-[10px] text-[#232E3C]">
                      {new Date(entry.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-[#8A9BA8]">
                    <span className="font-mono font-bold text-[#FFFFFF]">
                      {entry.direction === "above" ? "+" : ""}{entry.roiPct.toFixed(2)}% ROI
                    </span>
                    <span className="text-[#232E3C]">·</span>
                    <span>${entry.profit.toFixed(2)} profit</span>
                    <span className="text-[#232E3C]">·</span>
                    <span className="text-[#5E6875]">{entry.strategy}</span>
                    {entry.notified && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#5DBE81]/10 text-[#5DBE81]">
                        notified
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
