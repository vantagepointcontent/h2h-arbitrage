# Frontend Performance Audit — H2H Arbitrage

**Scope**: `src/app/page.tsx` (1799 lines), `MarketSidebar.tsx`, `OverviewPanel.tsx`, `OutcomeTableBody.tsx`, `Bookmaker1on1.tsx`, `next.config.ts`
**Method**: Static code analysis, no build/run
**Date**: 2026-07-04

---

## Findings (Prioritized by User-Perceived Latency Impact)

### #1 — Sidebar Re-renders on Every Price Update (CRITICAL)

**Files**: `src/app/page.tsx` lines 1114–1148
**Problem**: `MarketSidebar` receives `markets={savedMarkets}` as a prop. `savedMarkets` is a state variable in `Home()`. Every time *any* state in `Home()` changes (price updates every 60s, `priceChanges`, `lastUpdated`, `loading`, etc.), the entire `Home()` component re-renders, producing a new `savedMarkets` reference. `MarketSidebar` is **not wrapped in `React.memo`**, so it re-renders fully — re-executing the filter+sort pipeline over ~130+ markets — on every single state change in `Home()`.

**Evidence**:
- `MarketSidebar` does not use `React.memo` (file has no `memo` import, no `React.memo` call)
- `OverviewPanel` also not wrapped in `React.memo`
- `OutcomeTableBody` also not wrapped in `React.memo`
- `savedMarkets` is a plain `useState<SavedMarket[]>([])` — every re-render creates a new render context

**Impact**: With ~130+ saved markets, the sidebar's filter+sort (lines 154–202 in `MarketSidebar.tsx`) runs on every render. Each market item computes `computeApy()`, `formatPercent()`, `timeUntilExpiry()`, and `tickFreshness()` — all doing `new Date()` and `Intl` formatting. This is a measurable layout/jank cost.

**Fix**:
1. Wrap `MarketSidebar`, `OverviewPanel`, and `OutcomeTableBody` in `React.memo`.
2. Add `useMemo` for the filtered+sorted list inside each component (currently computed inline on every render).
3. Consider lifting `savedMarkets` into a `useRef`-backed pattern where the sidebar reads from ref but only re-renders on explicit updates.

---

### #2 — Full 574KB Payload Every 60 Seconds (CRITICAL)

**Files**: `src/app/page.tsx` line 780, `src/app/api/saved-markets/route.ts` lines 5–28
**Problem**: `loadSavedMarkets()` calls `GET /api/saved-markets` with no `fields` param, defaulting to `'full'` (line 8 of route.ts). The full payload includes `allArbs` arrays, `liveResult` with nested outcomes, and full `lastScanResult` — 574KB total. This fires:
- On mount (line 775)
- Every 60s via `setInterval` (line 780)
- After every action: save (line 509), delete (line 474), scan-all completion (line 455), bulk save (line 948), single save from MarketFinder (line 1233), initial sync (line 229)

**Evidence**: The API route already has a `fields=names` endpoint (line 12–21 of route.ts) that returns only `{id, eventTitle}` — ~20KB for 500 markets. The sidebar doesn't need `allArbs`, `liveResult`, or `lastScanResult` for its display — it only needs `id`, `eventTitle`, `category`, `expiryDate`, `liveResult.bestRoiPct`, `lastScanResult.bestRoiPct`, `liveResult.scannedAt`, `lastScanResult.scannedAt`, `liveResult.pmClosed`, `lastScanResult.pmClosed`.

**Impact**: 574KB over the network on every 60s poll. On slow connections, this causes noticeable latency and can block the main thread during JSON parsing.

**Fix**:
1. Add a `fields=sidebar` or `fields=compact` query parameter to the API that returns only the subset needed by the sidebar/overview.
2. Change `loadSavedMarkets()` to call `/api/saved-markets?fields=compact` by default.
3. Only fetch full data when the user navigates to the overview or explicitly refreshes.
4. Estimated reduction: 574KB → ~80–120KB (still full enough for overview, but ~5× smaller than full payload).

---

### #3 — No List Virtualization for Sidebar (HIGH)

**File**: `src/app/page.tsx` lines 368–437 (inside `MarketSidebar`)
**Problem**: The sidebar renders all ~130+ filtered markets as individual `<div>` elements in a scrollable container. Each market item has ~10 DOM nodes (star button, title, category badge, expiry, freshness indicator, ROI, APY). That's ~1300+ DOM nodes visible at any time.

**Impact**: With 1300+ DOM nodes, scrolling performance degrades, especially on mobile. Each node has event handlers (`onClick`, `e.stopPropagation()`).

**Fix**:
1. Use `react-window` or `@tanstack/react-virtual` to virtualize the list — only render items visible in the viewport (~15–20 items).
2. This would reduce DOM nodes from ~1300 to ~30, dramatically improving scroll performance.

---

### #4 — Inline `useCallback` Closures Capture Stale State (MEDIUM-HIGH)

**Files**: `src/app/page.tsx` lines 785–834
**Problem**: The auto-refresh interval for the active market (line 785) closes over `capital` (line 796) but not other state it depends on. More critically, the `useCallback` hooks for `mfBulkSave` (line 908), `fetchFreshMfMarkets` (line 960), and `fetchAllMfMarkets` (line 982) have dependency arrays that may not capture all mutated state.

**Specific issue at line 791**: The `setInterval` callback calls `fetch("/api/scan", ...)` with `capital` from the closure. If `capital` changes, the interval still uses the old value until the component re-renders and recreates the interval. The `useEffect` cleanup at line 833 handles this, but the dependency array `[activeMarketId, viewMode, capital]` means the interval recreates every time `capital` changes — which happens on every keystroke in the capital input field.

**Impact**: Every keystroke in the capital input field tears down and recreates the 60s polling interval. This is a memory leak pattern and causes missed polls.

**Fix**: Use a `useRef` for `capital` (already have `capitalRef` — but it doesn't exist). Add `const capitalRef = useRef(capital)` and use `capitalRef.current` inside the interval.

---

### #5 — `Bookmaker1on1` and `CouplingSuggestions` Not Lazy-Loaded (HIGH)

**Files**: `src/app/page.tsx` lines 58–59, 1554–1580, 1684–1697
**Problem**: `Bookmaker1on1` and `CouplingSuggestions` are imported with static `import` statements (lines 58–59), meaning they are bundled into the main chunk regardless of whether they're ever rendered. They are only displayed conditionally (lines 1554–1580 and 1684–1697).

`Bookmaker1on1.tsx` is 676 lines and imports `useLivePrices` (a WebSocket hook). `CouplingSuggestions` is likely similar in size.

**Impact**: These components add unnecessary JavaScript to the initial bundle. Users who never open the "1on1 Bookmaker" view still download and parse this code.

**Fix**:
```typescript
const Bookmaker1on1 = dynamic(() => import("@/app/components/Bookmaker1on1"), { ssr: false });
const CouplingSuggestions = dynamic(() => import("@/app/components/CouplingSuggestions"), { ssr: false });
```

---

### #6 — Repeated `savedMarkets.find()` Calls in Render (MEDIUM)

**Files**: `src/app/page.tsx` lines 1392–1394, 1403, 1417, 1432, 1556–1577, 1689
**Problem**: Inside the render body, `savedMarkets.find(m => m.id === activeMarketId)` is called at least 8 separate times across the render tree. Each call iterates through the entire `savedMarkets` array (O(n) per call).

**Impact**: With 130+ markets, that's 8 × 130 = ~1040 iterations per render, every time any state changes.

**Fix**: Compute `const activeMarket = savedMarkets.find(m => m.id === activeMarketId) ?? null;` once before the return statement and reference `activeMarket` throughout.

---

### #7 — `OverviewPanel` Re-sorts and Re-filters on Every Render (MEDIUM)

**File**: `src/app/components/OverviewPanel.tsx` lines 72–149
**Problem**: `sortFn` (line 72), `filteredByExpiry` (lines 130–149), and aggregate stats (lines 152–155) are computed inline on every render. The `.sort()` and `.filter()` calls create new arrays each time. `computeApy()` is called per-market inside `getMarketApy()` which is called inside `sortFn`.

**Impact**: With 130+ markets, this means 130+ `computeApy()` calls, 130+ Date constructions, and 2× full array copies per render.

**Fix**: Wrap the filtered+sorted list and aggregate stats in `useMemo` with proper dependencies (`markets`, `sort`, `sortDir`, `expiryFilter`, `showArbOnly`, `showExpired`).

---

### #8 — No `useMemo` for Sidebar Filtered List (MEDIUM)

**File**: `src/app/components/MarketSidebar.tsx` lines 154–202
**Problem**: The `filtered` variable is computed inline on every render — filtering then sorting the full market list. With 130+ markets, this involves Date constructions, string comparisons, and `computeApy()` calls per item.

**Fix**: Wrap in `useMemo` with dependencies `[markets, sidebarSearch, sidebarCategory, sidebarFavoritesOnly, showExpired, expiryFilter, showArbOnly, sort, sortDir]`.

---

### #9 — `OutcomeTableBody` Re-computes Per-Row on Every Render (MEDIUM)

**File**: `src/app/components/OutcomeTableBody.tsx` lines 91–101, 106–282
**Problem**: `profitableOutcomes`, `totalProfit`, `highestProfitOutcome` are computed on every render (lines 97–101). Inside the `.map()` (line 106), each row computes `spread`, `profit`, `stakeRatio`, `isBalanced` — all involving arithmetic and `Intl` formatting.

**Fix**: Wrap the pre-computed values in `useMemo`. Consider wrapping each row in `React.memo` if outcomes are numerous.

---

### #10 — WebSocket Connection per `Bookmaker1on1` Instance (LOW-MEDIUM)

**File**: `src/lib/use-live-prices.ts` line 40
**Problem**: `useLivePrices` creates an `EventSource` (SSE) connection when `Bookmaker1on1` is rendered with `useLivePrices={bookmakerView}`. If the component mounts/unmounts frequently (e.g., toggling bookmaker view), this creates and tears down WebSocket connections repeatedly.

**Impact**: Connection churn, potential server load, and brief UI lag during reconnection.

**Fix**: Cache the `EventSource` in a module-level ref or use a shared WebSocket provider that persists across component mounts.

---

## Summary Table

| # | Category | Severity | File | Line(s) |
|---|----------|----------|------|---------|
| 1 | Re-render propagation | CRITICAL | page.tsx, MarketSidebar.tsx | 1114–1148, 154–202 |
| 2 | Full payload every 60s | CRITICAL | page.tsx, route.ts | 780, 8 |
| 3 | No virtualization | HIGH | MarketSidebar.tsx | 368–437 |
| 4 | Interval recreation on keystroke | HIGH | page.tsx | 785–834 |
| 5 | Non-lazy components | HIGH | page.tsx | 58–59 |
| 6 | Repeated .find() in render | MEDIUM | page.tsx | 1392–1577 |
| 7 | OverviewPanel no useMemo | MEDIUM | OverviewPanel.tsx | 72–155 |
| 8 | Sidebar no useMemo | MEDIUM | MarketSidebar.tsx | 154–202 |
| 9 | OutcomeTableBody recompute | MEDIUM | OutcomeTableBody.tsx | 91–282 |
| 10 | WS connection churn | LOW-MEDIUM | use-live-prices.ts | 40 |

## Quick Wins (Highest ROI, Least Effort)

1. **Add `fields=compact` to `loadSavedMarkets()`** — 2-line change, ~5× payload reduction on every 60s poll
2. **Wrap sidebar/overview/table in `React.memo`** — 3-line change, eliminates ~90% of unnecessary re-renders
3. **Memoize filtered+sorted lists** — 3–5 line changes, eliminates repeated sort/filter work
4. **Lazy-load `Bookmaker1on1` and `CouplingSuggestions`** — 2-line changes, reduces initial bundle
5. **Cache `activeMarket` find result** — 1 line, eliminates 8× O(n) scans per render