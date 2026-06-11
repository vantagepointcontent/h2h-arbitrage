# Victor's Overnight Checklist — 2025-06-10

## ✅ AVKLARAT

### 1. Pollern scannar alla marknader var 15:e minut
- `adaptive-refresh-config.json`: alla marknader → 900s
- `poll.mjs`: `DEFAULT_TIERS` bypassar adaptive med `Infinity`
- Pollern restartad och online

### 2. Refresh-knapp scannar alla marknader (bulk scan)
- Fixad: `scanAllMarkets()` anropar `/api/scan` (istället för saknad `/api/refresh`)
- Fixad: data-parsning av `allOutcomes` och `bestArb`

### 3. Auto-scan var 10:e sekund i Scan-vyn
- `useEffect` med `setInterval(10000)` kör `handleScanWithUrls`
- Endast aktiv när `viewMode === "scan"` och `activeMarketId` finns

### 4. Pris-blinkning vid ändring
- `previousPricesRef` + `priceChanges` state
- Signifikant ändring (>0.01) triggar `flash-green`/`flash-red`
- Reset efter 3 sekunder

### 5. Depth-bars → $-värden
- Kalshi: visar `yesAskDepth` / `noAskDepth` (sträng, t.ex. "$1.2K")
- Polymarket: visar `$1,234` från `askDepth` / `noAskDepth`

### 6. `lastScanResult` interface fixad
- `persistence.ts`: tillagt `bestApyPct` och `totalStake`
- `page.tsx`: `LastScanResult` + `liveResult` interfaces uppdaterade

### 7. Scan/Refresh API:er fixade
- `/api/scan/route.ts`: `bestApyPct` + `totalStake` tillagt i scanResult
- `/api/saved-markets/refresh/route.ts`: samma fixar

### 8. Build + restart
- `tsc --noEmit`: 0 fel
- `next build`: 0 fel, 2 varningar
- Server igång på `100.86.7.30:3000`

---

## ⏳ KVAR ATT VERIFIERA (kräver live-marknadstest)

### A. Är Kalshi `yesAsk` verkligen köp-priset?
- `buildKalshiArbShape`: `yesAsk = parseFloat(km.yes_ask_dollars)`
- `yes_ask_dollars` kommer från Kalshi API — ska vara ask
- BEHÖVER TEST: Jämför med kalshi.com/markets för en sparad marknad

### B. Är Polymarket `yesPrice` verkligen köp-priset?
- `buildPmArbShape`: använder `bestAsk` för YES, `noPrice` för NO
- För neg-risk: använder CLOB `outcomePrices` direkt
- För standard: `yesPrice = bestAsk`, `noPrice = 1 - bestBid`
- BEHÖVER TEST: Jämför med polymarket.com/event/...

### C. Profit-kalkylering — är depth = 0 orsaken till $0.02?
- `calculateArbitrageMax`: `capital = min(depthK/kPrice, depthP/pPrice)`
- Om `depthKYes = 0` eller `depthPNo = 0` → `capital = 0` → `profit = 0`
- `parseDepth("$0")` returnerar `0`, vilket kan orsaka 0 profit
- BEHÖVER TEST: Logga `depthKYes`, `depthPNo` från API-svaret

### D. Sidan laddar långsamt vid markadsöppning
- BEHÖVER PROFILERA: Kolla network-tab för vilka anrop som tar tid
- Couplings-request? Manual-matches? Saved-markets?

---

## 📝 VIKTIGT FÖR VICTOR

När du vaknar — gör en **hard refresh** och testa:

1. **Klicka på en sparad marknad** → öppna DevTools → Network
2. Se `/api/scan` anrop var 10:e sekund
3. Kolla `allOutcomes` i svaret → jämför priser med kalshi.com och polymarket.com
4. Om priserna skiljer sig → skicka screenshot på:
   - EdgeFinder pris
   - Kalshi/Polymarket pris för samma outcome
   - DevTools network-tab med API-svaret

Om allt ser rätt ut → är vi klara!
Om inte → finns mer att gräva i.
