"use client";

import { useState, useEffect, useCallback } from "react";

export interface AppSettings {
  // Appearance
  theme: "dark" | "light";
  overviewLayout: "grid" | "table";

  // Behavior
  refreshInterval: number; // milliseconds (legacy, kept for backward compat)
  sidebarOpen: boolean;

  // Refresh rate intervals (admin dashboard)
  globalRefreshInterval: number; // ms — overall overview refresh cycle (5s–30min)
  shortTermInterval: number; // ms — aggressive refresh for active scans
  longTermInterval: number; // ms — relaxed refresh for idle monitoring

  // Sorting & filtering
  sortField: "roi" | "profit" | "expiry";
  sortDirection: "asc" | "desc";
  overviewExpiryFilter: "all" | "lte7" | "lte14" | "lte30";

  // Overview-specific sort (separate from outcome sortField)
  overviewSort: "expiry" | "roi" | "name" | "apy";
  overviewSortDir: "asc" | "desc";
  hideUnmatched: boolean;

  // Sidebar state
  sidebarSort: "name" | "roi" | "expiry" | "apy";
  sidebarSortDir: "asc" | "desc";
  sidebarCategoryFilter: string;
  sidebarSearch: string;

  // View state
  viewMode: "overview" | "scan" | "marketfinder";
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  overviewLayout: "grid",
  refreshInterval: 5000,
  sidebarOpen: true,
  globalRefreshInterval: 10000,
  shortTermInterval: 3000,
  longTermInterval: 30000,
  sortField: "roi",
  sortDirection: "desc",
  overviewExpiryFilter: "all",
  overviewSort: "expiry",
  overviewSortDir: "asc",
  hideUnmatched: false,
  sidebarSort: "name",
  sidebarSortDir: "asc",
  sidebarCategoryFilter: "",
  sidebarSearch: "",
  viewMode: "overview",
};

const STORAGE_KEY = "h2h-settings";

/** Declarative per-field validators for applySettings/importJSON. Each entry
 *  validates and coerces one raw input value; returning undefined means "skip". */
const SETTINGS_VALIDATORS: {
  [K in keyof AppSettings]: (v: unknown) => AppSettings[K] | undefined;
} = {
  theme: (v) => (typeof v === "string" && ["dark", "light"].includes(v) ? (v as AppSettings["theme"]) : undefined),
  overviewLayout: (v) => (typeof v === "string" && ["grid", "table"].includes(v) ? (v as AppSettings["overviewLayout"]) : undefined),
  refreshInterval: (v) => (typeof v === "number" && v > 0 ? v : undefined),
  sidebarOpen: (v) => (typeof v === "boolean" ? v : undefined),
  globalRefreshInterval: (v) => (typeof v === "number" && v > 0 ? v : undefined),
  shortTermInterval: (v) => (typeof v === "number" && v > 0 ? v : undefined),
  longTermInterval: (v) => (typeof v === "number" && v > 0 ? v : undefined),
  sortField: (v) => (typeof v === "string" && ["roi", "profit", "expiry"].includes(v) ? (v as AppSettings["sortField"]) : undefined),
  sortDirection: (v) => (typeof v === "string" && ["asc", "desc"].includes(v) ? (v as AppSettings["sortDirection"]) : undefined),
  overviewExpiryFilter: (v) => (typeof v === "string" && ["all", "lte7", "lte14", "lte30"].includes(v) ? (v as AppSettings["overviewExpiryFilter"]) : undefined),
  overviewSort: (v) => (typeof v === "string" && ["expiry", "roi", "name", "apy"].includes(v) ? (v as AppSettings["overviewSort"]) : undefined),
  overviewSortDir: (v) => (typeof v === "string" && ["asc", "desc"].includes(v) ? (v as AppSettings["overviewSortDir"]) : undefined),
  hideUnmatched: (v) => (typeof v === "boolean" ? v : undefined),
  sidebarSort: (v) => (typeof v === "string" && ["name", "roi", "expiry", "apy"].includes(v) ? (v as AppSettings["sidebarSort"]) : undefined),
  sidebarSortDir: (v) => (typeof v === "string" && ["asc", "desc"].includes(v) ? (v as AppSettings["sidebarSortDir"]) : undefined),
  sidebarCategoryFilter: (v) => (typeof v === "string" ? v : undefined),
  sidebarSearch: (v) => (typeof v === "string" ? v : undefined),
  viewMode: (v) => (typeof v === "string" && ["overview", "scan", "marketfinder"].includes(v) ? (v as AppSettings["viewMode"]) : undefined),
};

function loadInitial<T extends object>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...defaultValue, ...parsed };
    }
  } catch {
    // corrupted JSON — fall through to default
  }
  return defaultValue;
}

function saveToStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota exceeded — silent fail
  }
}

/**
 * Generic typed localStorage hook.
 * Persists to localStorage and syncs across tabs via storage event.
 */
export function useLocalStorage<T extends object>(
  key: string,
  defaultValue: T,
): [T, (updater: (prev: T) => T) => void, () => void] {
  const [value, setValue] = useState<T>(() => loadInitial(key, defaultValue));

  // Persist on change
  useEffect(() => {
    saveToStorage(key, value);
  }, [key, value]);

  // Cross-tab sync
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === key && e.newValue) {
        try {
          setValue(JSON.parse(e.newValue));
        } catch {
          // ignore parse errors
        }
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [key]);

  const update = useCallback(
    (fn: (prev: T) => T) => setValue(fn),
    [],
  );

  const reset = useCallback(() => setValue(defaultValue), [defaultValue]);

  return [value, update, reset];
}

/**
 * Application settings persisted in localStorage.
 * Provides current settings, updater, reset, export, and import.
 */
export function useAppSettings() {
  const [settings, update, _reset] = useLocalStorage<AppSettings>(
    STORAGE_KEY,
    DEFAULT_SETTINGS,
  );

  /** Reset all settings to defaults. */
  const resetToDefaults = useCallback(() => _reset(), [_reset]);

  /** Serialize settings to JSON string for export. */
  const exportJSON = useCallback((): string => {
    return JSON.stringify(settings, null, 2);
  }, [settings]);

  /** Apply settings from an object, validating known keys against SETTINGS_VALIDATORS. */
  const applySettings = useCallback((input: Record<string, unknown>): string | null => {
    if (typeof input !== "object" || input === null) {
      return "Imported data is not a valid settings object.";
    }

    const validated: Partial<AppSettings> = {};
    for (const key of Object.keys(SETTINGS_VALIDATORS) as (keyof AppSettings)[]) {
      if (!(key in input)) continue;
      const validator = SETTINGS_VALIDATORS[key] as (v: unknown) => unknown;
      const value = validator(input[key]);
      if (value !== undefined) {
        (validated as Record<string, unknown>)[key] = value;
      }
    }

    const merged = { ...DEFAULT_SETTINGS, ...validated };
    saveToStorage(STORAGE_KEY, merged);
    update(() => merged);
    return null;
  }, [update]);

  /** Import settings from a JSON string. Returns error message or null. */
  const importJSON = useCallback(
    (json: string): string | null => {
      try {
        const parsed = JSON.parse(json);
        return applySettings(parsed);
      } catch {
        return "Failed to parse settings JSON.";
      }
    },
    [applySettings],
  );

  return {
    settings,
    update,
    set: useCallback((partial: Partial<AppSettings>) => update((prev) => ({ ...prev, ...partial })), [update]),
    resetToDefaults,
    exportJSON,
    importJSON,
  };
}
