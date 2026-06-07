"use client";

import { useState, useEffect, useCallback } from "react";

export type CategoryName =
  | "sports" | "politics" | "election" | "entertainment" | "economics"
  | "crypto" | "science" | "technology" | "weather" | "international";

export interface CategoryOverride {
  /** Override interval in ms, or 0 to use global default */
  intervalMs: number;
}

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

  // Per-category refresh overrides (0 = use global default)
  categoryOverrides: Record<CategoryName, number>;

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
  categoryOverrides: {
    sports: 0,
    politics: 0,
    election: 0,
    entertainment: 0,
    economics: 0,
    crypto: 0,
    science: 0,
    technology: 0,
    weather: 0,
    international: 0,
  },
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

const CATEGORIES_LIST: CategoryName[] = [
  "sports", "politics", "election", "entertainment", "economics",
  "crypto", "science", "technology", "weather", "international",
];

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

  /** Apply settings from an object, validating known keys. */
  const applySettings = useCallback((input: Record<string, unknown>): string | null => {
    if (typeof input !== "object" || input === null) {
      return "Imported data is not a valid settings object.";
    }

    const validated: Partial<AppSettings> = {};
    if (input.theme && typeof input.theme === "string" && ["dark", "light"].includes(input.theme as string)) {
      validated.theme = input.theme as "dark" | "light";
    }
    if (input.overviewLayout && typeof input.overviewLayout === "string" && ["grid", "table"].includes(input.overviewLayout as string)) {
      validated.overviewLayout = input.overviewLayout as "grid" | "table";
    }
    if (typeof input.refreshInterval === "number" && input.refreshInterval > 0) {
      validated.refreshInterval = input.refreshInterval;
    }
    if (typeof input.globalRefreshInterval === "number" && input.globalRefreshInterval > 0) {
      validated.globalRefreshInterval = input.globalRefreshInterval;
    }
    if (typeof input.shortTermInterval === "number" && input.shortTermInterval > 0) {
      validated.shortTermInterval = input.shortTermInterval;
    }
    if (typeof input.longTermInterval === "number" && input.longTermInterval > 0) {
      validated.longTermInterval = input.longTermInterval;
    }
    if (typeof input.sidebarOpen === "boolean") {
      validated.sidebarOpen = input.sidebarOpen;
    }
    if (input.sortField && typeof input.sortField === "string" && ["roi", "profit", "expiry"].includes(input.sortField as string)) {
      validated.sortField = input.sortField as "roi" | "profit" | "expiry";
    }
    if (input.sortDirection && typeof input.sortDirection === "string" && ["asc", "desc"].includes(input.sortDirection as string)) {
      validated.sortDirection = input.sortDirection as "asc" | "desc";
    }
    if (input.overviewExpiryFilter && typeof input.overviewExpiryFilter === "string" &&
        ["all", "lte7", "lte14", "lte30"].includes(input.overviewExpiryFilter as string)) {
      validated.overviewExpiryFilter = input.overviewExpiryFilter as "all" | "lte7" | "lte14" | "lte30";
    }
    if (input.overviewSort && typeof input.overviewSort === "string" &&
        ["expiry", "roi", "name", "apy"].includes(input.overviewSort as string)) {
      validated.overviewSort = input.overviewSort as "expiry" | "roi" | "name" | "apy";
    }
    if (input.overviewSortDir && typeof input.overviewSortDir === "string" && ["asc", "desc"].includes(input.overviewSortDir as string)) {
      validated.overviewSortDir = input.overviewSortDir as "asc" | "desc";
    }
    if (typeof input.hideUnmatched === "boolean") {
      validated.hideUnmatched = input.hideUnmatched;
    }
    if (input.sidebarSort && typeof input.sidebarSort === "string" &&
        ["name", "roi", "expiry", "apy"].includes(input.sidebarSort as string)) {
      validated.sidebarSort = input.sidebarSort as "name" | "roi" | "expiry" | "apy";
    }
    if (input.sidebarSortDir && typeof input.sidebarSortDir === "string" && ["asc", "desc"].includes(input.sidebarSortDir as string)) {
      validated.sidebarSortDir = input.sidebarSortDir as "asc" | "desc";
    }
    if (typeof input.sidebarCategoryFilter === "string") {
      validated.sidebarCategoryFilter = input.sidebarCategoryFilter;
    }
    if (typeof input.sidebarSearch === "string") {
      validated.sidebarSearch = input.sidebarSearch;
    }
    if (input.viewMode && typeof input.viewMode === "string" &&
        ["overview", "scan", "marketfinder"].includes(input.viewMode as string)) {
      validated.viewMode = input.viewMode as "overview" | "scan" | "marketfinder";
    }
    if (input.categoryOverrides && typeof input.categoryOverrides === "object") {
      const co: Partial<Record<CategoryName, number>> = {};
      for (const cat of CATEGORIES_LIST) {
        const val = input.categoryOverrides[cat];
        if (typeof val === "number" && val >= 0) {
          co[cat] = val;
        }
      }
      validated.categoryOverrides = co as Record<CategoryName, number>;
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

/**
 * Get the effective refresh interval for a category.
 * Returns the category override if set (>0), otherwise the global default.
 */
export function getEffectiveInterval(
  category: CategoryName,
  globalInterval: number,
  overrides: Record<CategoryName, number>,
): number {
  const override = overrides[category];
  return override > 0 ? override : globalInterval;
}

/**
 * Estimate API calls per hour based on current settings.
 * Assumes N markets tracked; each market refreshes at its effective interval.
 */
export function estimateApiCallsPerHour(
  marketCount: number,
  globalInterval: number,
  overrides: Record<CategoryName, number>,
  categoryDistribution: Record<CategoryName, number>,
): number {
  let totalCalls = 0;
  for (const cat of Object.keys(categoryDistribution) as CategoryName[]) {
    const count = categoryDistribution[cat] || 0;
    const interval = getEffectiveInterval(cat, globalInterval, overrides);
    totalCalls += (3600000 / interval) * count;
  }
  return Math.round(totalCalls);
}
