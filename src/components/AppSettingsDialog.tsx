"use client";

import { useState, useRef } from "react";
import {
  Settings as SettingsIcon,
  X,
  Download,
  Upload,
  RotateCcw,
  Zap,
  Gauge,
  BatteryCharging,
} from "lucide-react";
import type { AppSettings } from "@/hooks/useAppSettings";

// ── Types ──

interface Props {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdate: (partial: Partial<AppSettings>) => void;
  onReset: () => void;
  onExport: () => string;
  onImport: (json: string) => string | null;
}

// ── Presets ──

interface RefreshPreset {
  name: string;
  icon: React.ReactNode;
  description: string;
  globalRefreshInterval: number;
  shortTermInterval: number;
  longTermInterval: number;
}

const PRESETS: RefreshPreset[] = [
  {
    name: "Performance",
    icon: <Zap className="w-4 h-4" />,
    description: "Fast refresh for active trading",
    globalRefreshInterval: 5000,
    shortTermInterval: 2000,
    longTermInterval: 15000,
  },
  {
    name: "Balanced",
    icon: <Gauge className="w-4 h-4" />,
    description: "Default balanced settings",
    globalRefreshInterval: 10000,
    shortTermInterval: 3000,
    longTermInterval: 30000,
  },
  {
    name: "Conservation",
    icon: <BatteryCharging className="w-4 h-4" />,
    description: "Slow refresh to reduce API load",
    globalRefreshInterval: 30000,
    shortTermInterval: 10000,
    longTermInterval: 60000,
  },
];

// ── Helpers ──

function msToSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`;
}

function SliderControl({
  label,
  description,
  value,
  min,
  max,
  step,
  onChange,
  colorClass,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  colorClass: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-[#FFFFFF]">{label}</div>
          <div className="text-xs text-[#5E6875] mt-0.5">{description}</div>
        </div>
        <div className={`font-mono text-sm font-bold ${colorClass}`}>
          {msToSeconds(value)}
        </div>
      </div>
      <div className="relative">
        {/* Track background */}
        <div className="h-2 rounded-full bg-[#232E3C]" />
        {/* Filled track */}
        <div
          className={`absolute top-0 left-0 h-2 rounded-full ${colorClass.replace("text-", "bg-")} opacity-60`}
          style={{ width: `${pct}%` }}
        />
        {/* Thumb + hidden input */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute top-0 left-0 w-full h-2 opacity-0 cursor-pointer z-10"
          style={{ margin: 0 }}
        />
        {/* Visible thumb indicator */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 border-[#0E1621] shadow-md ${colorClass.replace("text-", "bg-")}`}
          style={{ left: `calc(${pct}% - 8px)` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-[#232E3C]">
        <span>{msToSeconds(min)}</span>
        <span>{msToSeconds(max)}</span>
      </div>
    </div>
  );
}

// ── Component ──

export default function AppSettingsDialog({
  open,
  onClose,
  settings,
  onUpdate,
  onReset,
  onExport,
  onImport,
}: Props) {
  const [activeTab, setActiveTab] = useState<"performance" | "appearance" | "sorting" | "data">(
    "performance",
  );
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  // ── Handlers ──

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const err = onImport(text);
      if (err) {
        setImportError(err);
        setImportSuccess(false);
      } else {
        setImportError(null);
        setImportSuccess(true);
        setTimeout(() => setImportSuccess(false), 2000);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleExport = () => {
    const json = onExport();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "h2h-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const applyPreset = (preset: RefreshPreset) => {
    onUpdate({
      globalRefreshInterval: preset.globalRefreshInterval,
      shortTermInterval: preset.shortTermInterval,
      longTermInterval: preset.longTermInterval,
    });
  };

  // ── Render ──

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
        <div className="pointer-events-auto w-full max-w-xl mx-4 bg-[#18181b] border border-[#232E3C] rounded-xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#232E3C]">
            <div className="flex items-center gap-2">
              <SettingsIcon className="w-5 h-5 text-[#5DBE81]" />
              <h2 className="text-base font-semibold">Admin Dashboard</h2>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-[#232E3C] text-[#5E6875] hover:text-[#FFFFFF] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-[#232E3C] px-5">
            {(
              [
                { key: "performance", label: "Performance" },
                { key: "appearance", label: "Appearance" },
                { key: "sorting", label: "Sorting" },
                { key: "data", label: "Data" },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${
                  activeTab === key
                    ? "border-[#5DBE81] text-[#FFFFFF]"
                    : "border-transparent text-[#5E6875] hover:text-[#8A9BA8]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Scrollable content */}
          <div className="overflow-y-auto px-5 py-4 space-y-5">
            {/* ═══ PERFORMANCE TAB ═══ */}
            {activeTab === "performance" && (
              <>
                {/* Presets */}
                <div className="space-y-2">
                  <div className="text-sm font-medium text-[#FFFFFF]">Presets</div>
                  <div className="text-xs text-[#5E6875] mb-2">Quick-select a configuration</div>
                  <div className="grid grid-cols-3 gap-2">
                    {PRESETS.map((preset) => {
                      const isActive =
                        settings.globalRefreshInterval === preset.globalRefreshInterval &&
                        settings.shortTermInterval === preset.shortTermInterval &&
                        settings.longTermInterval === preset.longTermInterval;
                      return (
                        <button
                          key={preset.name}
                          onClick={() => applyPreset(preset)}
                          className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-lg border transition-all ${
                            isActive
                              ? "bg-[#5DBE81]/15 border-[#5DBE81] text-[#5DBE81]"
                              : "bg-[#17212B] border-[#232E3C] text-[#8A9BA8] hover:border-[#232E3C] hover:text-[#FFFFFF]"
                          }`}
                        >
                          {preset.icon}
                          <span className="text-sm font-semibold">{preset.name}</span>
                          <span className="text-[10px] opacity-70">{preset.description}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Divider */}
                <hr className="border-[#232E3C]" />

                {/* Sliders */}
                <SliderControl
                  label="Global Refresh"
                  description="Overall overview refresh cycle"
                  value={settings.globalRefreshInterval}
                  min={3000}
                  max={60000}
                  step={1000}
                  onChange={(v) => onUpdate({ globalRefreshInterval: v })}
                  colorClass="text-[#5DBE81]"
                />

                <SliderControl
                  label="Short-Term Interval"
                  description="Aggressive refresh for active scans"
                  value={settings.shortTermInterval}
                  min={1000}
                  max={30000}
                  step={500}
                  onChange={(v) => onUpdate({ shortTermInterval: v })}
                  colorClass="text-[#5DBE81]"
                />

                <SliderControl
                  label="Long-Term Interval"
                  description="Relaxed refresh for idle monitoring"
                  value={settings.longTermInterval}
                  min={5000}
                  max={120000}
                  step={1000}
                  onChange={(v) => onUpdate({ longTermInterval: v })}
                  colorClass="text-[#a855f7]"
                />

                {/* Legacy refresh interval (kept for backward compat) */}
                <div className="mt-4 px-3 py-2 rounded-lg bg-[#232E3C]/50 border border-[#232E3C] text-xs text-[#5E6875]">
                  Tip: Changes apply immediately and persist across page reloads.
                </div>
              </>
            )}

            {/* ═══ APPEARANCE TAB ═══ */}
            {activeTab === "appearance" && (
              <>
                <SettingRow label="Theme" description="Color scheme">
                  <div className="flex gap-2">
                    {(["dark", "light"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => onUpdate({ theme: t })}
                        className={`px-4 py-2 rounded-lg text-sm font-medium capitalize border transition-colors ${
                          settings.theme === t
                            ? "bg-[#5DBE81]/15 border-[#5DBE81] text-[#5DBE81]"
                            : "border-[#232E3C] text-[#5E6875] hover:border-[#232E3C] hover:text-[#8A9BA8]"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </SettingRow>

                <SettingRow label="Overview Layout" description="Card or table view">
                  <div className="flex gap-2">
                    {(["grid", "table"] as const).map((l) => (
                      <button
                        key={l}
                        onClick={() => onUpdate({ overviewLayout: l })}
                        className={`px-4 py-2 rounded-lg text-sm font-medium capitalize border transition-colors ${
                          settings.overviewLayout === l
                            ? "bg-[#5DBE81]/15 border-[#5DBE81] text-[#5DBE81]"
                            : "border-[#232E3C] text-[#5E6875] hover:border-[#232E3C] hover:text-[#8A9BA8]"
                        }`}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </SettingRow>

                <SettingRow label="Sidebar" description="Show/hide left sidebar by default">
                  <div className="flex gap-2">
                    {(["true", "false"] as const).map((v) => (
                      <button
                        key={v}
                        onClick={() => onUpdate({ sidebarOpen: v === "true" })}
                        className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                          (settings.sidebarOpen ? "true" : "false") === v
                            ? "bg-[#5DBE81]/15 border-[#5DBE81] text-[#5DBE81]"
                            : "border-[#232E3C] text-[#5E6875] hover:border-[#232E3C] hover:text-[#8A9BA8]"
                        }`}
                      >
                        {v === "true" ? "Open" : "Closed"}
                      </button>
                    ))}
                  </div>
                </SettingRow>
              </>
            )}

            {/* ═══ SORTING TAB ═══ */}
            {activeTab === "sorting" && (
              <>
                <SettingRow label="Default Sort By" description="Primary sort column for overview">
                  <div className="flex gap-2">
                    {(["roi", "profit", "expiry"] as const).map((sf) => (
                      <button
                        key={sf}
                        onClick={() => onUpdate({ sortField: sf })}
                        className={`px-4 py-2 rounded-lg text-sm font-medium capitalize border transition-colors ${
                          settings.sortField === sf
                            ? "bg-[#5DBE81]/15 border-[#5DBE81] text-[#5DBE81]"
                            : "border-[#232E3C] text-[#5E6875] hover:border-[#232E3C] hover:text-[#8A9BA8]"
                        }`}
                      >
                        {sf}
                      </button>
                    ))}
                  </div>
                </SettingRow>

                <SettingRow label="Sort Direction" description="Ascending or descending">
                  <div className="flex gap-2">
                    {(["asc", "desc"] as const).map((sd) => (
                      <button
                        key={sd}
                        onClick={() => onUpdate({ sortDirection: sd })}
                        className={`px-4 py-2 rounded-lg text-sm font-medium capitalize border transition-colors ${
                          settings.sortDirection === sd
                            ? "bg-[#5DBE81]/15 border-[#5DBE81] text-[#5DBE81]"
                            : "border-[#232E3C] text-[#5E6875] hover:border-[#232E3C] hover:text-[#8A9BA8]"
                        }`}
                      >
                        {sd === "asc" ? "Ascending" : "Descending"}
                      </button>
                    ))}
                  </div>
                </SettingRow>

                <SettingRow label="Expiry Filter" description="Default expiry date filter">
                  <div className="flex gap-2 flex-wrap">
                    {(["all", "lte7", "lte14", "lte30"] as const).map((ef) => (
                      <button
                        key={ef}
                        onClick={() => onUpdate({ overviewExpiryFilter: ef })}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                          settings.overviewExpiryFilter === ef
                            ? "bg-[#5DBE81]/15 border-[#5DBE81] text-[#5DBE81]"
                            : "border-[#232E3C] text-[#5E6875] hover:border-[#232E3C] hover:text-[#8A9BA8]"
                        }`}
                      >
                        {ef === "all" ? "All" : `≤${ef.slice(3)}d`}
                      </button>
                    ))}
                  </div>
                </SettingRow>
              </>
            )}

            {/* ═══ DATA TAB ═══ */}
            {activeTab === "data" && (
              <>
                <SettingRow label="Export Settings" description="Download your settings as JSON">
                  <button
                    onClick={handleExport}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[#5DBE81]/15 text-[#5DBE81] hover:bg-[#5DBE81]/25 border border-[#5DBE81]/20 transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    Export
                  </button>
                </SettingRow>

                <SettingRow label="Import Settings" description="Restore from a JSON file">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleImportClick}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[#232E3C] text-[#FFFFFF] hover:bg-[#232E3C] border border-[#232E3C] transition-colors"
                    >
                      <Upload className="w-4 h-4" />
                      Import
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json,application/json"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                  </div>
                </SettingRow>

                {importError && (
                  <div className="px-3 py-2 rounded-lg bg-[#ef4444]/10 border border-[#ef4444]/20 text-[#ef4444] text-sm">
                    {importError}
                  </div>
                )}
                {importSuccess && (
                  <div className="px-3 py-2 rounded-lg bg-[#5DBE81]/10 border border-[#5DBE81]/20 text-[#5DBE81] text-sm">
                    Settings imported successfully.
                  </div>
                )}

                <SettingRow label="Reset to Defaults" description="Clear all custom settings">
                  <button
                    onClick={onReset}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[#ef4444]/10 text-[#ef4444] hover:bg-[#ef4444]/20 border border-[#ef4444]/20 transition-colors"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Reset
                  </button>
                </SettingRow>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-[#232E3C] flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-[#232E3C] text-[#FFFFFF] hover:bg-[#232E3C] transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-medium text-[#FFFFFF]">{label}</div>
        <div className="text-xs text-[#5E6875] mt-0.5">{description}</div>
      </div>
      {children}
    </div>
  );
}
