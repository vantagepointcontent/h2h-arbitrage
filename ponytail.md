# Ponytail Audit — h2h-arbitrage

Repo-wide over-engineering audit, 2026-07-03. Scope: complexity only — correctness bugs, security, and performance are out of scope (two out-of-scope bugs noted at the end).

Baseline: ~36,400 lines across `src/` + `scripts/`.
**Net: −13,500 lines (~37%), −5 deps possible** (framer-motion, shadcn, uuid, @types/uuid, class-variance-authority).

Findings are ranked biggest cut first within each section. Line estimates are approximate.

---

## Dead features (built, tested, never called)

1. `delete:` docs/compliance/ + scripts/compliance/ — audits GCP IAM, K8s RBAC, Cloud SQL PITR for infra this app doesn't have (SQLite + pm2 on one box). Replacement: nothing. [scripts/compliance/access-review.py] (~1,115 lines)

2. `delete:` auto-discovery feature — 4 routes + 719-line lib, zero callers (no UI, no script, no pm2 hook despite warmup's comment). Replacement: nothing. [src/app/api/auto-discovery/, src/lib/auto-discovery.ts] (~900 lines)

3. `delete:` generous-coupling feature — GenerousCouplingPanel.tsx never imported; /api/generous-coupling never fetched (the panel would call /api/couplings anyway). Replacement: nothing. [src/app/components/GenerousCouplingPanel.tsx, src/app/api/generous-coupling/route.ts] (~843 lines)

4. `delete:` cache-client.ts + idb-cache.ts — IndexedDB cache stack; idb-cache is imported only by cache-client, which nothing imports. Replacement: nothing. [src/lib/cache-client.ts, src/lib/idb-cache.ts] (~701 lines)

5. `delete:` AppSettingsDialog.tsx — never imported or rendered anywhere. Replacement: nothing. [src/components/AppSettingsDialog.tsx] (~687 lines)

6. `delete:` adaptive-refresh feature — lib imported only by its own test; the admin route persists a config JSON that only poll.mjs reads from disk; scan-frequency.ts is the live tier system. Replacement: hand-edit the JSON (CHECKLIST.md already documents doing exactly that). [src/lib/adaptive-refresh.ts, src/lib/adaptive-refresh.test.ts, src/app/api/admin/adaptive-refresh/route.ts] (~630 lines)

7. `yagni:` multi-platform-arb.ts + platform-adapters.ts — speculative 5-platform / 3+-leg abstraction layer imported only by each other; every real code path calls kalshi.ts/polymarket.ts directly. Replacement: nothing. [src/lib/multi-platform-arb.ts, src/lib/platform-adapters.ts] (~486 lines)

8. `delete:` auto-execute.ts + test — real execution is explicitly "not implemented"; the dry-run simulator, safety limits, rollback logic, and in-memory audit log are speculative with no route or UI caller. Replacement: nothing. [src/lib/auto-execute.ts, src/lib/auto-execute.test.ts] (~454 lines)

9. `delete:` AlertSystem client-side alert engine — `checkAndFire` is never called, so toasts, history, chime, and browser notifications can never fire; ToastContainer always renders null; the ROI/spread sliders configure a dead system. Replacement: keep only TelegramSettingsSection (the working server-side path) as the Bell-button panel. [src/components/AlertSystem.tsx:140] (~450 lines)

10. `delete:` /api/ping + ping.ts — route never fetched; the lib's only importer is the route. Replacement: nothing. [src/app/api/ping/route.ts, src/lib/ping.ts] (~436 lines)

11. `delete:` MarketTable → MarketRow → PriceCell chain — MarketTable is never rendered; MarketRow is used only by MarketTable; PriceCell/SpreadCell/ArbitrageCell only by MarketRow (Bookmaker1on1's "PriceCell" is its own local PriceCellWithFlash). Replacement: nothing. [src/app/components/MarketTable.tsx, src/app/components/MarketRow.tsx, src/app/components/PriceCell.tsx] (~432 lines)

12. `delete:` /api/spread — never fetched (UI "spread" hits are unrelated bet-type strings); contains its own already-dead extractIndividualMarket helper and a GET→POST self-wrapper. Replacement: nothing. [src/app/api/spread/route.ts] (~423 lines)

13. `delete:` price-velocity.ts — velocity/acceleration/arb-formation prediction module whose only importer is its own test. Replacement: nothing. [src/lib/price-velocity.ts, src/lib/price-velocity.test.ts] (~422 lines)

14. `delete:` persistence-score.ts — 6-factor weighted 0–100 arb persistence scorer, only imported by its own test; the persistenceScore field it would feed in telegram-alerts is never populated. Replacement: nothing. [src/lib/persistence-score.ts, src/lib/persistence-score.test.ts] (~412 lines)

15. `delete:` /api/healthz + /api/metrics + health.ts — no internal caller; UI and deploy use the simpler /api/health; health.ts serves only these two routes. **Confirm no external Prometheus/uptime scraper first** (middleware matcher explicitly whitelists /healthz and /metrics). Replacement: nothing. [src/app/api/healthz/route.ts, src/app/api/metrics/route.ts, src/lib/health.ts] (~364 lines)

16. `delete:` version-manager.ts — semver parse/bump/compare, version history, rollback slots, changelog generation, and "API version negotiation" with zero imports anywhere. Replacement: nothing. [src/lib/version-manager.ts] (~332 lines)

17. `delete:` spread-history feature — `saveSpread` is never called anywhere, so HistoricalSpreadChart (itself never imported) reads a permanently empty IndexedDB. Replacement: nothing. [src/app/components/HistoricalSpreadChart.tsx, src/lib/spreadHistory.ts] (~300 lines)

18. `delete:` /api/refresh — never fetched; a stripped-down copy-paste of /api/scan (same chooseBestPmStructure, same Kalshi triple-fallback, same CLOB enrichment). Replacement: /api/scan or /api/saved-markets/refresh. [src/app/api/refresh/route.ts] (~191 lines)

19. `delete:` DateTimePicker.tsx — dynamically imported in page.tsx but never rendered. Replacement: `<input type="datetime-local">` if ever needed. [src/components/DateTimePicker.tsx] (~184 lines)

20. `delete:` /api/lifecycle + lifecycle.ts — never fetched (only mention is a comment in the lib); no UI ever calls sweep/archive/unarchive. Replacement: nothing. [src/app/api/lifecycle/route.ts, src/lib/lifecycle.ts] (~174 lines)

21. `delete:` /api/version — never fetched; its getChangelogRoute export isn't a valid Next.js route handler, so the changelog half is unreachable even if the endpoint were kept. Replacement: nothing. [src/app/api/version/route.ts] (~93 lines)

22. `delete:` /api/ws/prices — never fetched; all EventSource consumers use /api/ws/live-scan (clob-ws lib stays — live-scan uses it). Replacement: nothing. [src/app/api/ws/prices/route.ts] (~83 lines)

23. `delete:` /api/scan-history — never fetched; /api/logs serves the same getScanHistory data with the same name-enrichment. Replacement: /api/logs. [src/app/api/scan-history/route.ts] (~39 lines)

24. `delete:` /api/poller-health — no caller in repo (UI polls /api/health and /api/watcher/health; lib/health reads poller-health.json from disk directly). **Confirm no external monitor uses it.** Replacement: nothing. [src/app/api/poller-health/route.ts] (~29 lines)

25. `delete:` /api/saved-markets/scan-result — never fetched; scans persist results server-side via updateSavedMarketScanResult inside /api/scan already. Replacement: nothing. [src/app/api/saved-markets/scan-result/route.ts] (~20 lines)

## Repo litter (debug leftovers, duplicates, unwired ops)

26. `delete:` API-poking debug one-offs — scripts/test-access.mjs, test-key.mjs, test-match.mjs, test-ph-api.mjs, test-ph-sync.mjs (Jun 7); zero references anywhere. Replacement: nothing. [scripts/] (~179 lines)

27. `delete:` scripts/test_h2h.py — urllib smoke suite from May 15, superseded by the vitest suite; unreferenced. Replacement: nothing. [scripts/test_h2h.py] (~141 lines)

28. `delete:` .colleague-playbook.md — one-time Jun 11 incident-recovery runbook for a page.tsx syntax error fixed the same day. Replacement: nothing. [.colleague-playbook.md] (~138 lines)

29. `delete:` scripts/bug030-{backfill,check,inspect,raw,titles}.mjs — BUG-030 one-time market_title backfill plus its four throwaway diagnostics, already run; unreferenced. Replacement: nothing. [scripts/] (~117 lines)

30. `delete:` analyze_syntax.py — hand-rolled JS brace/paren matcher written for the same Jun 11 incident. Replacement: `npx tsc --noEmit` / `node --check`. [analyze_syntax.py] (~111 lines)

31. `delete:` scripts/data001-category-backfill.mjs — one-time DATA-001 category backfill, shipped and run Jul 3. Replacement: nothing. [scripts/data001-category-backfill.mjs] (~81 lines)

32. `delete:` scripts/pm2-crash-alert.sh — designed for a cron entry that was never installed (crontab empty, /etc/cron.d clean); pm2's restart_delay/min_uptime already governs crash storms. Replacement: nothing. [scripts/pm2-crash-alert.sh] (~102 lines)

33. `delete:` scripts/db-retention.py — retention already runs in production via poll.mjs → /api/prune-scans?days=30; its scan_daily_summary table is written by this script and read by nothing; no cron installs it. Replacement: nothing. [scripts/db-retention.py] (~98 lines)

34. `delete:` scripts/deploy-hooks.sh + the on_restart/on_online/on_stop keys in ecosystem.config.js — PM2 has no such lifecycle-hook options; they're silently ignored, so the script has never executed. Replacement: nothing. [scripts/deploy-hooks.sh, ecosystem.config.js:71] (~70 lines)

35. `delete:` scripts/pre-start.sh — header claims it's called by an ecosystem.config.js `pre_start` hook, but no such key exists in either config (and pm2 has no such option). Replacement: nothing. [scripts/pre-start.sh] (~30 lines)

36. `delete:` scripts/auto-scan.js — 15-min refresh loop "run via Hermes scheduler"; superseded by the pm2 h2h-poller (poll.mjs adaptive refresh); no cron entry on this box. **Confirm the external Hermes job is gone before deleting.** Replacement: nothing. [scripts/auto-scan.js] (~53 lines)

37. `delete:` scripts/logrotate.conf — never installed (/etc/logrotate.d has no h2h-pm2 despite the ecosystem.config.js comment); winston-daily-rotate-file already rotates app logs. Replacement: nothing. [scripts/logrotate.conf] (~18 lines)

38. `native:` scripts/bump-version.sh — replace with `npm version patch|minor|major` (bumps package.json + git tag natively); keep the CHANGELOG line as a habit. [scripts/bump-version.sh] (~101 lines)

39. `delete:` src/__tests__/regression.test.ts — superseded by regression-full.test.ts (same R-numbered cases, maintained through the Jul 3 fee-math fix); fold its two unique parseDepth cases into the full suite. Replacement: regression-full.test.ts. [src/__tests__/regression.test.ts] (~186 lines)

40. `delete:` ecosystem.config.ts — pm2 loads ecosystem.config.js (the live 3-app config, updated Jul 3); the .ts file is the stale May 19 single-app duplicate, referenced nowhere. Replacement: nothing. [ecosystem.config.ts] (~22 lines)

41. `delete:` vite.config.ts — vitest resolves vitest.config.ts first, so this Jun 12 duplicate (with a stale tests/** include) is dead. Replacement: nothing. [vite.config.ts] (~24 lines)

42. `delete:` patches/hermes-dashboard-basic-auth-fix.patch — a "backup" patch for a different project (Hermes dashboard); no patch-package, no postinstall, nothing applies it. Replacement: nothing. [patches/hermes-dashboard-basic-auth-fix.patch] (~28 lines)

43. `delete:` public/test.html — Jun 11 red/blue CSS-cache debug page, still served publicly at /test.html. Replacement: nothing. [public/test.html] (~15 lines)

44. `delete:` necklace.json — 8KB single-scan API response dump parked in the repo root, unreferenced. Replacement: nothing. [necklace.json] (~8KB)

## Dead exports & half-wired UI

45. `delete:` matcher.ts dead exports — normalizeMarketName, buildCaseInsensitiveMap, buildNormalizedMap, findByNormalizedName (matchOutcomes builds its map inline), private calculateCrossOutcomeArbitrage, FeeInputs interface. Replacement: nothing. [src/lib/matcher.ts:374,383,417,450,751,68] (~160 lines)

46. `delete:` Bookmaker1on1 inert controls — thresholds editor (onThresholdChange never passed; editableThresholds never drives colors, so Apply does nothing), auto-refresh controls (interval always 0, timer can never start), REFRESH_PRESETS, platformA/BName/Icon props (only defaults ever used). Replacement: keep only the price board. [src/app/components/Bookmaker1on1.tsx:489] (~160 lines)

47. `delete:` rate-limiter.ts observability/wrapper API — getThrottleSnapshot, getMetrics, resetMetrics, all five metric counters, getLimiter, rateLimitedFetch, isAnyThrottled, getAllThrottleSnapshots, getAllMetrics used only by the module's own tests; production only calls limiter.execute(). Replacement: keep the bucket + 429 retry. [src/lib/rate-limiter.ts:109-146,349-402] (~120 lines)

48. `delete:` page.tsx dead state and imports — unlinkedPairs + UNLINK_UNDO_MS, sortField/sortDirection, lastScanTime, the polling scaffold (pollRef never set → 7 no-op stopPolling calls), manualMatchMsg, rightPanelOpen, overviewCategory, showFavoritesOnly, mfExpiryFilter, overview cache refs, bulkFavorite, frozen hideUnmatched setting, 26 unused lucide icons, unused arb-duration/computeApy/page-shared imports. Replacement: nothing. [src/app/page.tsx:131] (~115 lines)

49. `delete:` page.tsx edit-market modal chain — openEditModal is never called (MarketSidebar gets `onEditMarket={() => {}}`), so editModalOpen/editingMarket/editTitle/editCategory/editExpiry/saveEdit and the modal JSX are unreachable; also drop MarketSidebar's dead onEditMarket/layout/onToggleLayout props. Replacement: nothing. [src/app/page.tsx:490] (~65 lines)

50. `yagni:` page.tsx Save-Market confirmation modal — the Save button opens a modal whose only content is "this will add the pair" + a second Save button. Replacement: call saveMarket() directly. [src/app/page.tsx:1882] (~20 lines)

51. `native:` logger.ts hand-rolled Sentry pipeline — winston Http transport posting to the deprecated /store/ endpoint via regex-parsed DSN, plus Sentry.init with a double-@ts-expect-error Integrations.Winston that doesn't exist in current SDKs. Replacement: @sentry/nextjs auto-instrumentation via its config files; delete sentryTransport, the init block, extractSentryProject/extractSentryKey. [src/lib/logger.ts:54-73,238-251,315-323] (~55 lines)

52. `shrink:` logger.ts exported spread-clone — 40 lines manually re-binding every winston method onto a copied object. Replacement: `Object.assign(rootLogger, { trackError })`. [src/lib/logger.ts:267-307] (~35 lines)

53. `native:` logger.ts createChildLogger — reimplements winston's built-in child loggers with hand-wrapped Stream transports, and is used only by its own test. Replacement: `rootLogger.child(context)` or delete. [src/lib/logger.ts:161-194] (~33 lines)

54. `delete:` error-handler.ts down to clientSafeError — errorToStatus, handleError, errorResponse, withErrorHandler, startTimer, TimedRequest have zero external callers (all 28 route importers use only clientSafeError). Replacement: nothing. [src/lib/error-handler.ts:21-121] (~105 lines)

55. `delete:` EmbeddedBrowserPanel scroll-sync + refresh plumbing — postMessage scroll sync can never work (cross-origin kalshi/polymarket iframes never post "scroll" messages; no injected script exists); DualBrowserPanels' refreshKey is set but never used, so the refreshTrigger/embedRefreshCounter chain from page.tsx is a no-op; onKalshiUrlChange/onPmUrlChange never passed. Replacement: nothing. [src/components/EmbeddedBrowserPanel.tsx:165] (~90 lines)

56. `delete:` MarketFinderPanel unrendered per-row computations — spreadClass, arbPct, arbStrategy, arbClass, spreadTooltip computed for every row and never rendered, plus 5 unused page-shared imports. Replacement: nothing. [src/app/components/MarketFinderPanel.tsx:394] (~45 lines)

57. `delete:` MarketFinderPanel inert spread-threshold slider — dispatches a window CustomEvent ("mf-spread-change") but the only consumer, localThreshold, is initialized once and never updated, so moving the slider changes nothing. Replacement: remove slider + event + page.tsx listener, or wire as a plain onChange prop if the sort matters. [src/app/components/MarketFinderPanel.tsx:220] (~35 lines)

58. `delete:` MarketFinderPanel mount fetch — the hasFetched effect duplicates the parent's viewMode effect (page.tsx:907), causing a double fetch every time the view opens; the comment even admits the parent handles it. Replacement: nothing. [src/app/components/MarketFinderPanel.tsx:76] (~8 lines)

59. `delete:` market-classification.ts unused variants — classifyKalshiMarket, classifyPolymarketMarket, getBetTypeColor, getDomainColor and both color maps never imported; only classifyMarket has one caller, and its groupItemTitle param is unused. Replacement: nothing. [src/lib/market-classification.ts:101-177] (~77 lines)

60. `yagni:` useAppSettings per-category refresh plumbing — categoryOverrides defaults + validation, CategoryOverride, getEffectiveInterval, estimateApiCallsPerHour, legacy refreshInterval referenced by no component. Replacement: nothing. [src/hooks/useAppSettings.ts:9,59,235,279,292] (~70 lines)

61. `delete:` ui/button.tsx — never imported anywhere; sole user of the class-variance-authority dependency. Replacement: nothing (file + dep). [src/components/ui/button.tsx] (~58 lines, −1 dep)

62. `delete:` clob-ws.ts ClobWsService.fetchTokenPrice + fetchAllPrices — "REST fallback" statics never called anywhere (book-seed.ts does its own REST seeding). Replacement: nothing. [src/lib/clob-ws.ts:140-185] (~48 lines)

63. `delete:` use-live-prices.ts dead flash detection — newFlashes is built via the whole "Detect price changes for flash animation" block then never read, returned, or set into state. Replacement: nothing. [src/lib/use-live-prices.ts:115-155] (~40 lines)

64. `delete:` coupling.ts isRecentlyRejected + getRejectionPenalty — never imported; suggestCouplings already filters rejections internally. Also de-export extractKeywords (GenerousCouplingPanel re-implements its own copy). Replacement: nothing. [src/lib/coupling.ts:174-206] (~30 lines)

65. `delete:` correlation.ts correlationMiddleware + withCorrelation — correlationMiddleware takes pages-router NextApiRequest types in an app-router project and is never imported; withCorrelation never imported (src/middleware.ts uses only correlationId). Replacement: nothing. [src/lib/correlation.ts:36-61] (~28 lines)

66. `delete:` arb-duration.ts updateArbDuration — never imported (page.tsx uses syncArbDurations); the lastSeenMs field it maintains is never read. Replacement: nothing. [src/lib/arb-duration.ts:48-72] (~25 lines)

67. `delete:` live-arb-engine.ts legacy wrapper — computeLiveArbitrage + LiveArbInputs, a self-declared backward-compat shim with zero callers. Replacement: nothing. [src/lib/live-arb-engine.ts:9-14,211-223] (~25 lines)

68. `delete:` persistence.ts leftovers — deprecated getScanHistoryFromJson (never imported) and private sleep() (never called). Replacement: nothing. [src/lib/persistence.ts:537,316] (~20 lines)

69. `delete:` predictionhunt route dead code — fetchCategories helper defined but never called, plus unused buildMatches/addSavedMarket/PhV2Market imports. Replacement: nothing. [src/app/api/predictionhunt/markets/route.ts:154] (~16 lines)

70. `delete:` settings.ts write-only schema keys — 'watcher.demoteAfterDays', 'execute.dryRun', 'execute.maxStakePerTrade', 'execute.maxDailyExposure', 'display.defaultSort', 'display.hideUnmatched' are rendered in the Settings UI and stored in the DB but nothing ever reads them (auto-execute reads process.env.H2H_DRY_RUN directly, so the dangerous "Dry run" toggle does nothing). Replacement: nothing — and remove the misleading UI controls. [src/lib/settings.ts:60,76-82] (~10 lines + misleading UI)

71. `delete:` auto-discovery.ts dead scraps (only if #2 is not taken wholesale) — unused imports, never-called ensureDir, never-imported rejectReviewPair, CATEGORIES array duplicating src/lib/categories.ts; de-export calculateConfidence/getDisposition. Replacement: import categories.ts. [src/lib/auto-discovery.ts:1-4,58-64,68-70,465-470] (~20 lines)

72. `delete:` kalshi-ws.ts createKalshiWsService factory — "for isolated test sessions" but no test or code ever calls it. Replacement: nothing. [src/lib/kalshi-ws.ts:312-315] (~4 lines)

## Unused API knobs

73. `yagni:` GET /api/saved-markets fields=basic mode + limit/offset pagination — no caller ever passes them (only bare fetch and ?fields=names exist). Replacement: keep just full and names. [src/app/api/saved-markets/route.ts:23] (~42 lines)

74. `yagni:` GET /api/logs cursor pagination — LogsPanel (the only caller) never passes cursor and ignores nextCursor; it sets limit=500 which the route silently caps at 200 anyway. Replacement: drop cursor/nextCursor. [src/app/api/logs/route.ts:35] (~8 lines)

75. `yagni:` POST /api/telegram-alerts action:'send' branch — comment says "internal use from scan loop" but the scan loop calls sendBatchAlerts via lib import; no HTTP caller ever sends it. Replacement: keep only 'test'. [src/app/api/telegram-alerts/route.ts:48] (~11 lines)

76. `delete:` /api/manual-matches duplicate DELETE ?id= handler — callers only use DELETE /api/manual-matches/[id]. Replacement: nothing. [src/app/api/manual-matches/route.ts:42] (~13 lines)

## Shrinks

77. `shrink:` page-shared.ts localStorage boilerplate — ten near-identical getStoredX/persistX pairs. Replacement: `getStored<T>(key, fallback)` / `persist(key, value)`. [src/app/lib/page-shared.ts:12] (~150 lines)

78. `shrink:` duplicated withTimeout + chooseBestPmStructure + Kalshi event→series-prefix→series triple-fallback across scan/route.ts and refresh-single.ts (and refresh/spread if kept). Replacement: extract once into src/lib (e.g. lib/market-fetch.ts). [src/app/api/scan/route.ts:21] (~90 lines)

79. `shrink:` telegram-alerts.ts formatters — K/PM prices-line, persistence-line, and deep-link blocks copy-pasted verbatim across formatArbMessage/formatSpreadWidenedMessage/formatVanishingMessage. Replacement: one `commonLines(arb)` helper. [src/lib/telegram-alerts.ts:177-197,221-238,261-275] (~50 lines)

80. `shrink:` predictionhunt.ts search mappers — fetchMatchingMarkets and searchPredictionHunt contain identical 40-line event/group/market mapping + maxDays filter blocks; private normalizeTitle is also never called. Replacement: extract `parseSearchEvents(data, maxDays)`. [src/lib/predictionhunt.ts:376-404,498-526,121] (~50 lines)

81. `shrink:` page.tsx market-header chips — eight near-identical chip blocks plus a "Couplings" toggle duplicated verbatim at lines 1426 and 1568. Replacement: map over a config array. [src/app/page.tsx:1474] (~55 lines)

82. `shrink:` useAppSettings applySettings — 75 lines of hand-written per-field if-blocks. Replacement: a declarative `{key: validator}` table looped once. [src/hooks/useAppSettings.ts:171-250] (~40 lines)

83. `shrink:` DualBrowserPanels layout branches — sidebyside and stacked branches render byte-identical panel pairs. Replacement: one block with a conditional wrapper className. [src/components/EmbeddedBrowserPanel.tsx:460] (~30 lines)

84. `shrink:` ThemeProvider — the same apply-theme block (setAttribute + classList add/remove) pasted three times, plus unused `mounted` state. Replacement: one `applyTheme(t)` helper. [src/components/ThemeProvider.tsx:42] (~22 lines)

85. `shrink:` lifecycle.ts previewLifecycleSweep (only if #20 is not taken) — near-verbatim duplicate of runLifecycleSweep. Replacement: `runLifecycleSweep(dryRun = false)`. [src/lib/lifecycle.ts:96-117] (~20 lines)

86. `shrink:` matcher.ts extractBetTypeFromTitle / extractBetTypeFromQuestion — two byte-identical regex chains. Replacement: one `extractBetType(text)`. [src/lib/matcher.ts:255-282] (~15 lines)

87. `yagni:` matcher.ts duplicate ManualMatch interface — identical to the one in manual-matches.ts. Replacement: import it. [src/lib/matcher.ts:197-206] (~10 lines)

88. `stdlib:` MarketSidebar inline scanned-ago IIFE — 12-line hand-rolled relative-time block in a title attribute duplicates getTimeAgo/formatRelativeTime already exported from page-shared. Replacement: call the existing helper. [src/app/components/MarketSidebar.tsx:358] (~12 lines)

## Stdlib / native / deps

89. `stdlib:` nine hand-rolled AbortController + setTimeout + clearTimeout fetch timeouts. Replacement: `fetch(url, { signal: AbortSignal.timeout(ms) })`. [src/lib/kalshi.ts:83-134, src/lib/polymarket.ts:56, src/lib/polymarket-clob.ts:103, src/lib/health.ts:43, src/lib/ping.ts:342] (~45 lines)

90. `stdlib:` uuid + @types/uuid deps for one `uuidv4()` call, plus three hand-rolled `${Date.now()}-${Math.random().toString(36).slice(2,9)}` ids. Replacement: `crypto.randomUUID()`. [src/lib/correlation.ts:1, src/lib/manual-matches.ts:49, src/lib/persistence.ts:382,432, src/lib/decoupled-pairs.ts:45] (~5 lines, −2 deps)

91. `delete:` framer-motion dependency — zero imports anywhere. Replacement: nothing. [package.json:21] (−1 dep)

92. `yagni:` shadcn in runtime dependencies — it's a code-gen CLI, not app code (components.json stays; src/components/ui is real). Replacement: `npx shadcn` when scaffolding. [package.json:27] (−1 dep)

---

**net: −13,500 lines (~37% of src+scripts), −5 deps possible.**

## Out of scope (bugs found along the way — route to a normal review pass)

- page.tsx PUTs/DELETEs `/api/saved-markets/${id}` but no `[id]` route exists — the PUT/DELETE handlers in saved-markets/route.ts expect ?id=/body.id, so edits/deletes from the UI silently 404.
- Bookmaker1on1's `useLivePrices` prop shadows the imported hook of the same name, making line 216 call a boolean — that view likely crashes at runtime.
