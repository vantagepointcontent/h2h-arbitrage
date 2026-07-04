"use client";

import { useState, useEffect } from "react";
import { Bell, X } from "lucide-react";

// ─── Telegram Settings Section ──────────────────────────
// The working server-side alert path. The old client-side alert engine
// (toasts, chime, browser notifications) was removed in PT-09: its
// checkAndFire entry point was never called, so it could never fire.

function TelegramSettingsSection() {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [status, setStatus] = useState<"idle" | "testing" | "success" | "error" | "configured">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [minRoi, setMinRoi] = useState("1.0");
  const [minProfit, setMinProfit] = useState("1.0");
  const [paused, setPaused] = useState(false);

  // Check if already configured via env
  useEffect(() => {
    fetch("/api/telegram-alerts", { cache: "no-store" })
      .then(r => r.json())
      .then(data => {
        if (data.configured) {
          setStatus("configured");
          if (data.minRoiPct != null) setMinRoi(String(data.minRoiPct));
          if (data.minProfitUsd != null) setMinProfit(String(data.minProfitUsd));
        }
        setPaused(data.paused === true);
      })
      .catch(() => {});
  }, []);

  const handleTest = async () => {
    if (!botToken || !chatId) {
      setStatus("error");
      setErrorMsg("Bot token and chat ID are required");
      return;
    }
    setStatus("testing");
    setErrorMsg("");
    try {
      const res = await fetch("/api/telegram-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", botToken, chatId }),
      });
      const data = await res.json();
      if (data.sent) {
        setStatus("success");
      } else {
        setStatus("error");
        setErrorMsg(data.error || "Failed to send test message");
      }
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-3 p-3 rounded-lg bg-[#182533] border border-[#232E3C]">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 text-[#5DBE81]" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64-6.8c-.15.75-1.42 6.07-1.42 6.07l-.72 3.04s-.05.22-.26.22c-.21 0-.55-.16-.55-.16l-2.35-1.75-.93.93s-.07.05-.15.05c-.08 0-.12-.06-.12-.06l.05-2.13 4.2-3.79s.26-.22-.05-.22c-.31 0-5.83 2.15-5.83 2.15l-2.04-.6s-.31-.11-.31-.36c0-.25.35-.39.35-.39l8.4-3.3s.69-.25.69.4z"/>
        </svg>
        <span className="text-sm font-medium">Telegram Push Notifications</span>
        {status === "configured" && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#5DBE81]/10 text-[#5DBE81]">
            env configured
          </span>
        )}
      </div>

      <p className="text-xs text-[#8A9BA8]">
        Get instant push notifications when arbitrage opportunities are found.
        Set credentials via environment variables or test below.
      </p>

      {status === "configured" && (
        <div className={`text-xs flex items-center gap-1.5 ${paused ? "text-[#facc15]" : "text-[#5DBE81]"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${paused ? "bg-[#facc15]" : "bg-[#5DBE81]"}`} />
          {paused ? "Paused — alerts suppressed (TELEGRAM_ALERTS_PAUSED=true)" : "Active — alerts fire automatically on positive arbs"}
        </div>
      )}

      <div className="space-y-2">
        <div>
          <label className="text-[10px] text-[#5E6875] uppercase tracking-wider">Bot Token</label>
          <input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="123456:ABC-DEF..."
            className="w-full px-2 py-1.5 text-xs rounded-md bg-[#0E1621] border border-[#232E3C] text-[#FFFFFF] placeholder-[#5E6875] focus:border-[#5DBE81]/50 focus:outline-none"
          />
        </div>
        <div>
          <label className="text-[10px] text-[#5E6875] uppercase tracking-wider">Chat ID</label>
          <input
            type="text"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="-1001234567890"
            className="w-full px-2 py-1.5 text-xs rounded-md bg-[#0E1621] border border-[#232E3C] text-[#FFFFFF] placeholder-[#5E6875] focus:border-[#5DBE81]/50 focus:outline-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-[#5E6875] uppercase tracking-wider">Min ROI %</label>
            <input
              type="text"
              value={minRoi}
              onChange={(e) => setMinRoi(e.target.value)}
              className="w-full px-2 py-1.5 text-xs rounded-md bg-[#0E1621] border border-[#232E3C] text-[#FFFFFF] focus:border-[#5DBE81]/50 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[10px] text-[#5E6875] uppercase tracking-wider">Min Profit $</label>
            <input
              type="text"
              value={minProfit}
              onChange={(e) => setMinProfit(e.target.value)}
              className="w-full px-2 py-1.5 text-xs rounded-md bg-[#0E1621] border border-[#232E3C] text-[#FFFFFF] focus:border-[#5DBE81]/50 focus:outline-none"
            />
          </div>
        </div>
      </div>

      <button
        onClick={handleTest}
        disabled={status === "testing"}
        className="px-3 py-1.5 rounded-md bg-[#5DBE81]/10 border border-[#5DBE81]/30 text-[#5DBE81] text-xs font-semibold hover:bg-[#5DBE81]/20 transition-colors disabled:opacity-50"
      >
        {status === "testing" ? "Sending..." : "Send Test Message"}
      </button>

      {status === "success" && (
        <p className="text-xs text-[#5DBE81]">✓ Test message sent! Check your Telegram.</p>
      )}
      {status === "error" && (
        <p className="text-xs text-[#ef4444]">✗ {errorMsg}</p>
      )}
    </div>
  );
}

// ─── Alert Settings Panel (Bell-button modal) ───────────

export function AlertSettingsPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm"
         onClick={onClose}>
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
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[#182533] text-[#5E6875] hover:text-[#FFFFFF] transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          <TelegramSettingsSection />
        </div>
      </div>
    </div>
  );
}
