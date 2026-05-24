# H2H Arbitrage — Kodgranskning
## Datum: 2026-01-26
## Granskare: Hermes Agent

---

## 🔴 KRITISKA BUGGAR (måste fixas omedelbart)

### BUG 1: depthPNo sätts alltid till 0 i scan/route.ts
**Rad 135:** `const depthPNo = 0;`
**Rad 143:** `calculateArbitrageMax(..., depthPYes, depthPYes)` — both args samma värde.

**Påverkan:** Kapitalberäkningen för strategin "Buy YES PM + NO Kalshi" (där PM Yes köps och Kalshi No köps) blir fel eftersom PM No-likviditet alltid är 0. Detta begränsar arbitrage till bara ena hållet.

**Fix:** Hämta PM No-likviditet från clob tokens eller använd askDepth för NO-sidan.

---

### BUG 2: Legacy `calculateArbitrage` används i stället för `calculateArbitrageMax`
**Matcher.ts rader 422, 467, 576:** `calculateArbitrage(kalshi, pmShape, capital)` kallas med `capital = 1000`.

**Påverkan:** `matchOutcomes` och `applyManualMatches` räknar arbitrage mot en *fix* kaptital på $1000. Användaren ser inkorrekta profit/capital siffror i UI:t. `calculateArbitrageMax` (som beaktar liquidity depth) existerar men används inte i dessa steg.

**Fix:** Byt alla anrop till `calculateArbitrageMax` och skicka in korrekt depth-värden.

---

### BUG 3: getClobPrices noPrice fallback är felaktig
**polymarket-clob.ts rad 71:** `noPrice = noToken?.price ?? clob.best_ask;`

Om `noToken` inte har ett price, fallbacks kod till `clob.best_ask` — men `best_ask` är YES-sidans ask, inte NO-sidans. Borde vara `clob.best_bid` eller `1 - yesPrice`.

---

### BUG 4: duplicate kalshi-objektbyggnad (4 identical blocks)
**matcher.ts** rader 408-420, 453-465, 486-498, samt scan/route.ts rad 132-136.

Samma 7 rader med `parseFloat(...yes_bid_dollars || '0')` upprepas 4 gånger i `matchOutcomes` + ytterligare gång i scan/route.ts. Risk för divergering vid ändring.

**Fix:** Extrahera till funktion `buildKalshiArbShape(km: KalshiMarket)`.

---

## 🟡 MEDELSTORA PROBLEM

### ISSUE 5: `parseFloat(exact.yes_ask_dollars || '1')` ger $1 default
Om Kalshi inte har ask-pris, antas $1 per share. Detta borde snarare vara `0` eller `NaN` — marknaden kan vara illikvid. Även `noAsk` defaults till $1.

### ISSUE 6: `filterPolymarketMarkets` logik är motsägelsefull
**scan/route.ts rader 21-32:**

```
const hasAnyEmpty = markets.some(m => !g || g === '' || g === 'N/A');
if (!hasAnyEmpty) return markets;
return markets.filter(m => !group || group === '' || group === 'N/A');
```

Om *någon* marknad har tom `groupItemTitle`, filtreras BARA marknader med tom `groupItemTitle`. Detta betyder att om en event har både "named binary" (med groupItemTitle) och "unnamed binary" (utan), så behålls bara de utan groupItemTitle — de named binaries försvinner! Detta är antagligen avsiktligt (för att undvika dubletter), men kommentaren bör förklara varför.

### ISSUE 7: `similarity` funktionen är för simpel
`similarity("trump win trump win trump", "trump lose")` ger hög score pga ord "trump" upprepas. Bör vikta med TF-IDF eller i alla fall unika ord.

### ISSUE 8: `fetchKalshiEventMarkets` + `fetchKalshiSeriesMarkets` — ingen retry
Om Kalshi API rate-limits (429) eller timeout, finns ingen retry. Appen bara failar.

---

## 🟢 LINDRIGA PROBLEM / STÄDA

### ISSUE 9: Backups ligger kvar i src/
- `src/app/page.tsx.backup-iteration3-20260523-201046`
- `src/app/page.tsx.20260524092922.bak`
- `src/lib/matcher.ts.backup-iteration3-20260523-201046`

Dessa bör flyttas till `.backups/` (vilket redan finns) och raderas från src.

### ISSUE 10: `page.tsx` är ~1500 rader och behöver splittas
Koden för UI:t bör brytas upp i komponenter: Sidebar, ScanPanel, OverviewPanel, ManualMatchPanel.

### ISSUE 15: Ingen test-ramverk installerat
`package.json` har varken jest, vitest, eller playwright. `npm test` existerar inte.

---

## 📊 SLUTSATS

| Kategori | Antal |
|----------|-------|
| 🔴 Kritiska buggar | 4 |
| 🟡 Medelstora problem | 5 |
| 🟢 Städning/Lindriga | 6 |

**Rekommenderad prioritet:**
1. Fixa BUG 1, 2, 3, 4 (kritiska = pengar på spel)
2. Rensa backups (1 minut)
3. Skriva tester (coverage för matcher + clob + kalshi)
4. Splitta page.tsx (refactor)
5. Addressera medelstora problem
