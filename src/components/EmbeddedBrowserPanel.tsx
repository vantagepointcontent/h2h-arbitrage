"use client";

import { useState, useCallback } from "react";
import {
  ExternalLink,
  Eye,
  EyeOff,
  Columns2,
  LayoutGrid,
  TrendingUp,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────

interface QuickAccessProps {
  platformName: "Kalshi" | "Polymarket";
  url: string;
  iconSrc: string;
  /** Optional market stats to display in the card */
  stats?: { label: string; value: string }[];
}

interface DualPanelProps {
  kalshiUrl: string;
  pmUrl: string;
  layout?: "sidebyside" | "stacked";
  onLayoutChange?: (layout: "sidebyside" | "stacked") => void;
  defaultHeight?: number;
  minHeight?: number;
  maxHeight?: number;
}

// ─── Single Panel ─────────────────────────────────────────

export function EmbeddedBrowserPanel({
  platformName,
  url,
  iconSrc,
  stats,
}: QuickAccessProps) {
  const [visible, setVisible] = useState(true);

  const accentClass =
    platformName === "Kalshi"
      ? "border-[#facc15]/30 bg-[#facc15]/5"
      : "border-[#a855f7]/30 bg-[#a855f7]/5";

  const accentTextClass =
    platformName === "Kalshi" ? "text-[#facc15]" : "text-[#a855f7]";

  const accentBtnClass =
    platformName === "Kalshi"
      ? "bg-[#facc15]/10 text-[#facc15] hover:bg-[#facc15]/20"
      : "bg-[#a855f7]/10 text-[#a855f7] hover:bg-[#a855f7]/20";

  const toggleVisibility = useCallback(() => {
    setVisible((v) => !v);
  }, []);

  if (!visible) return null;

  // Extract a clean market name from the URL for display
  const urlLabel = url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

  return (
    <div className={`rounded-xl border ${accentClass} overflow-hidden transition-all duration-200`}>
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-black/20">
        <div className="flex items-center gap-2 min-w-0">
          <img
            src={iconSrc}
            alt={platformName}
            className="w-4 h-4 rounded-sm shrink-0"
          />
          <span className={`text-xs font-semibold ${accentTextClass} shrink-0`}>
            {platformName}
          </span>
          <span className="text-[10px] text-[#5E6875] truncate">
            {urlLabel}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium ${accentBtnClass} transition-colors`}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open
          </a>
          <button
            onClick={toggleVisibility}
            className="p-1 rounded hover:bg-white/10 text-[#5E6875] hover:text-[#FFFFFF] transition-colors"
            title="Hide panel"
          >
            <EyeOff className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Stats area — compact market info instead of dead iframe */}
      <div className="px-3 py-2.5">
        {stats && stats.length > 0 ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {stats.map((s, i) => (
              <div key={i} className="flex items-center justify-between text-[11px]">
                <span className="text-[#5E6875]">{s.label}</span>
                <span className="text-[#8A9BA8] font-medium">{s.value}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[11px] text-[#5E6875]">
            <TrendingUp className="w-3 h-3" />
            <span>Market data available in the outcomes table above</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Standalone Toggle Button ─────────────────────────────

export function ShowPanelButton({
  platformName,
  iconSrc,
  onClick,
}: {
  platformName: string;
  iconSrc: string;
  onClick: () => void;
}) {
  const accentBg =
    platformName === "Kalshi" ? "bg-[#facc15]/10" : "bg-[#a855f7]/10";
  const accentBorder =
    platformName === "Kalshi" ? "border-[#facc15]/30" : "border-[#a855f7]/30";

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg ${accentBg} border ${accentBorder} text-xs font-medium text-[#8A9BA8] hover:text-[#FFFFFF] hover:brightness-125 transition-colors`}
    >
      <Eye className="w-3.5 h-3.5" />
      <img
        src={iconSrc}
        alt={platformName}
        className="w-3.5 h-3.5 rounded-sm"
      />
      Show {platformName}
    </button>
  );
}

// ─── Dual Panel Container (side-by-side or stacked) ───────

export function DualBrowserPanels({
  kalshiUrl,
  pmUrl,
  layout = "stacked",
  onLayoutChange,
}: DualPanelProps) {
  const [kalshiVisible, setKalshiVisible] = useState(true);
  const [pmVisible, setPmVisible] = useState(true);

  const anyVisible = kalshiVisible || pmVisible;
  const isSideBySide = layout === "sidebyside";

  return (
    <div className="space-y-3">
      {/* Controls row */}
      <div className="flex items-center gap-2">
        {!kalshiVisible && (
          <ShowPanelButton
            platformName="Kalshi"
            iconSrc="/kalshi-icon.png"
            onClick={() => setKalshiVisible(true)}
          />
        )}
        {!pmVisible && (
          <ShowPanelButton
            platformName="Polymarket"
            iconSrc="/polymarket-icon.png"
            onClick={() => setPmVisible(true)}
          />
        )}

        {anyVisible && (
          <>
            <div className="flex items-center gap-2 ml-auto">
              {/* Layout toggle */}
              <div className="flex items-center rounded-lg bg-[#182533] border border-[#232E3C] overflow-hidden">
                <button
                  onClick={() => onLayoutChange?.("stacked")}
                  className={`p-1.5 transition-colors ${
                    !isSideBySide
                      ? "bg-[#5DBE81]/15 text-[#5DBE81]"
                      : "text-[#5E6875] hover:text-[#FFFFFF]"
                  }`}
                  title="Stacked layout"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => onLayoutChange?.("sidebyside")}
                  className={`p-1.5 transition-colors ${
                    isSideBySide
                      ? "bg-[#5DBE81]/15 text-[#5DBE81]"
                      : "text-[#5E6875] hover:text-[#FFFFFF]"
                  }`}
                  title="Side-by-side layout"
                >
                  <Columns2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <span className="text-[10px] text-[#232E3C]">Quick access</span>
            </div>
          </>
        )}
      </div>

      {/* Panels */}
      <div className={isSideBySide ? "grid grid-cols-1 md:grid-cols-2 gap-3" : "space-y-3"}>
        {kalshiVisible && (
          <EmbeddedBrowserPanel
            platformName="Kalshi"
            url={kalshiUrl}
            iconSrc="/kalshi-icon.png"
          />
        )}
        {pmVisible && (
          <EmbeddedBrowserPanel
            platformName="Polymarket"
            url={pmUrl}
            iconSrc="/polymarket-icon.png"
          />
        )}
      </div>
    </div>
  );
}
