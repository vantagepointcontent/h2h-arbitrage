"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ExternalLink,
  Eye,
  EyeOff,
  RefreshCw,
  AlertTriangle,
  Minimize2,
  Maximize2,
  Columns2,
  LayoutGrid,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────

interface EmbeddedBrowserProps {
  platformName: "Kalshi" | "Polymarket";
  url: string;
  iconSrc: string;
  defaultHeight?: number;
  minHeight?: number;
  maxHeight?: number;
  onRefresh?: () => void;
  /** Called when iframe scroll position changes (for sync) */
  onScroll?: (scrollTop: number) => void;
  /** Scroll to this position (for sync from sibling) */
  scrollTo?: number | null;
}

interface DualPanelProps {
  kalshiUrl: string;
  pmUrl: string;
  onKalshiUrlChange?: (url: string) => void;
  onPmUrlChange?: (url: string) => void;
  layout?: "sidebyside" | "stacked";
  onLayoutChange?: (layout: "sidebyside" | "stacked") => void;
  defaultHeight?: number;
  minHeight?: number;
  maxHeight?: number;
  /** Trigger iframe refresh when this changes */
  refreshTrigger?: number;
}

// ─── Single Panel ─────────────────────────────────────────

export function EmbeddedBrowserPanel({
  platformName,
  url,
  iconSrc,
  defaultHeight = 320,
  minHeight = 160,
  maxHeight = 600,
  onRefresh,
  onScroll,
  scrollTo,
}: EmbeddedBrowserProps) {
  const [visible, setVisible] = useState(true);
  const [height, setHeight] = useState(defaultHeight);
  const [embedBlocked, setEmbedBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingRef = useRef(loading);
  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  const accentClass =
    platformName === "Kalshi"
      ? "border-[#facc15]/30 bg-[#facc15]/5"
      : "border-[#a855f7]/30 bg-[#a855f7]/5";

  const accentTextClass =
    platformName === "Kalshi" ? "text-[#facc15]" : "text-[#a855f7]";

  // Detect embed blocked: if iframe hasn't fired load within 5s, assume X-Frame-Options blocked
  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setEmbedBlocked(false);

    if (timerRef.current) clearTimeout(timerRef.current);

    const checkBlocked = () => {
      timerRef.current = setTimeout(() => {
        // Use ref to avoid stale closure
        if (loadingRef.current) {
          setEmbedBlocked(true);
          setLoading(false);
        }
      }, 5000);
    };
    checkBlocked();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [visible, url]);

  const handleIframeLoad = useCallback(() => {
    setLoading(false);
    setEmbedBlocked(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleIframeError = useCallback(() => {
    setLoading(false);
    setEmbedBlocked(true);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // Sync loadingRef with loading state
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  // Force refresh by toggling key
  const [refreshKey, setRefreshKey] = useState(0);
  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setEmbedBlocked(false);
    setLoading(true);
    if (onRefresh) onRefresh();
  }, [onRefresh]);

  // Drag resize handlers
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      dragStartY.current = e.clientY;
      dragStartHeight.current = height;
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = dragStartHeight.current - (ev.clientY - dragStartY.current);
        setHeight(Math.min(maxHeight, Math.max(minHeight, delta)));
      };
      const onUp = () => {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [height, minHeight, maxHeight],
  );

  const toggleFullscreen = useCallback(() => {
    setFullscreen((f) => !f);
  }, []);

  const toggleVisibility = useCallback(() => {
    setVisible((v) => !v);
  }, []);

  // ── Synchronized scroll via postMessage ──────────────────
  // We listen for scroll events from the iframe content (when same-origin allows)
  // and propagate to siblings via onScroll callback.
  const handleMessage = useCallback(
    (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data?.type === "scroll" && typeof e.data.top === "number") {
        onScroll?.(e.data.top);
      }
    },
    [onScroll],
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Respond to scrollTo prop from sibling panel
  useEffect(() => {
    if (scrollTo != null && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: "scrollto", top: scrollTo },
        "*"
      );
    }
  }, [scrollTo]);

  if (!visible) return null;

  return (
    <div
      className={`rounded-xl border ${accentClass} overflow-hidden transition-all duration-200`}
      style={{
        position: fullscreen ? "fixed" : "relative",
        zIndex: fullscreen ? 90 : undefined,
        ...(fullscreen
          ? { top: 0, left: 0, right: 0, bottom: 0, margin: 0 }
          : {}),
      }}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-black/20">
        <div className="flex items-center gap-2">
          <img
            src={iconSrc}
            alt={platformName}
            className="w-4 h-4 rounded-sm"
          />
          <span className={`text-xs font-semibold ${accentTextClass}`}>
            {platformName}
          </span>
          <span className="text-[10px] text-[#232E3C] truncate max-w-[200px]">
            {url}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            className="p-1 rounded hover:bg-white/10 text-[#5E6875] hover:text-[#FFFFFF] transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={toggleFullscreen}
            className="p-1 rounded hover:bg-white/10 text-[#5E6875] hover:text-[#FFFFFF] transition-colors"
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={toggleVisibility}
            className="p-1 rounded hover:bg-white/10 text-[#5E6875] hover:text-[#FFFFFF] transition-colors"
            title="Hide panel"
          >
            <EyeOff className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Content area */}
      <div
        style={{
          height: fullscreen ? "calc(100vh - 40px)" : height,
        }}
      >
        {embedBlocked ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-4">
            <AlertTriangle className="w-8 h-8 text-[#facc15]" />
            <div className="text-sm text-[#8A9BA8] text-center">
              <span className="font-medium text-[#FFFFFF]">{platformName}</span>{" "}
              blocks embedded viewing (X-Frame-Options).
            </div>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${
                platformName === "Kalshi"
                  ? "bg-[#facc15]/10 text-[#facc15] hover:bg-[#facc15]/20"
                  : "bg-[#a855f7]/10 text-[#a855f7] hover:bg-[#a855f7]/20"
              } transition-colors`}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open in new tab
            </a>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-2">
              <div
                className={`w-5 h-5 border-2 border-current rounded-full border-t-transparent animate-spin ${accentTextClass}`}
              />
              <span className="text-xs text-[#5E6875]">
                Loading {platformName}...
              </span>
            </div>
          </div>
        ) : (
          <iframe
            key={refreshKey}
            ref={iframeRef}
            src={url}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            onLoad={handleIframeLoad}
            onError={handleIframeError}
            title={`${platformName} embedded view`}
          />
        )}
      </div>

      {/* Resize handle */}
      {!fullscreen && !embedBlocked && (
        <div
          className="h-1.5 cursor-ns-resize bg-transparent hover:bg-[#5DBE81]/30 transition-colors group"
          onMouseDown={handleDragStart}
          title="Drag to resize"
        >
          <div className="mx-auto w-8 h-0.5 bg-[#232E3C] rounded-full group-hover:bg-[#5DBE81]" />
        </div>
      )}
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
  onKalshiUrlChange,
  onPmUrlChange,
  layout = "stacked",
  onLayoutChange,
  defaultHeight = 320,
  minHeight = 160,
  maxHeight = 600,
  refreshTrigger,
}: DualPanelProps) {
  const [kalshiVisible, setKalshiVisible] = useState(true);
  const [pmVisible, setPmVisible] = useState(true);

  // Scroll sync state
  const [kalshiScroll, setKalshiScroll] = useState<number | null>(null);
  const [pmScroll, setPmScroll] = useState<number | null>(null);

  // Debounce scroll propagation to avoid infinite loops
  const kalshiScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pmScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleKalshiScroll = useCallback((top: number) => {
    if (kalshiScrollTimer.current) clearTimeout(kalshiScrollTimer.current);
    kalshiScrollTimer.current = setTimeout(() => {
      setPmScroll(top);
    }, 100);
  }, []);

  const handlePmScroll = useCallback((top: number) => {
    if (pmScrollTimer.current) clearTimeout(pmScrollTimer.current);
    pmScrollTimer.current = setTimeout(() => {
      setKalshiScroll(top);
    }, 100);
  }, []);

  // Auto-refresh when trigger changes
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (refreshTrigger != null) {
      setRefreshKey(refreshTrigger);
    }
  }, [refreshTrigger]);

  const handleKalshiRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handlePmRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

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
              <span className="text-[10px] text-[#232E3C]">Live embed</span>
            </div>
          </>
        )}
      </div>

      {/* Panels */}
      {isSideBySide ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {kalshiVisible && (
            <EmbeddedBrowserPanel
              platformName="Kalshi"
              url={kalshiUrl}
              iconSrc="/kalshi-icon.png"
              defaultHeight={defaultHeight}
              minHeight={minHeight}
              maxHeight={maxHeight}
              onRefresh={handleKalshiRefresh}
              onScroll={handleKalshiScroll}
              scrollTo={kalshiScroll}
            />
          )}
          {pmVisible && (
            <EmbeddedBrowserPanel
              platformName="Polymarket"
              url={pmUrl}
              iconSrc="/polymarket-icon.png"
              defaultHeight={defaultHeight}
              minHeight={minHeight}
              maxHeight={maxHeight}
              onRefresh={handlePmRefresh}
              onScroll={handlePmScroll}
              scrollTo={pmScroll}
            />
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {kalshiVisible && (
            <EmbeddedBrowserPanel
              platformName="Kalshi"
              url={kalshiUrl}
              iconSrc="/kalshi-icon.png"
              defaultHeight={defaultHeight}
              minHeight={minHeight}
              maxHeight={maxHeight}
              onRefresh={handleKalshiRefresh}
              onScroll={handleKalshiScroll}
              scrollTo={kalshiScroll}
            />
          )}
          {pmVisible && (
            <EmbeddedBrowserPanel
              platformName="Polymarket"
              url={pmUrl}
              iconSrc="/polymarket-icon.png"
              defaultHeight={defaultHeight}
              minHeight={minHeight}
              maxHeight={maxHeight}
              onRefresh={handlePmRefresh}
              onScroll={handlePmScroll}
              scrollTo={pmScroll}
            />
          )}
        </div>
      )}
    </div>
  );
}
