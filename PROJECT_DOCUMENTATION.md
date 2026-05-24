# H2H Arbitrage — Produktbeskrivning

## Elevator Pitch
H2H Arbitrage är en webbaserad scanner och dashboard som hittar prisdifferenser (arbitrage) mellan två prediction-markets: **Kalshi** (amerikanska, regulerade) och **Polymarket** (global, crypto-baserad). Användaren matar in ett event från båda plattformarna; appen listar alla matchade utfall med realtidspriser, beräknar ROI%, profit vid given capital, APY% annualiserat över tid till expiry, och visar depth-begränsad max-profit (hur mycket du teoretiskt kan satsa innan priserna rör sig).

---

## Arkitekturöversikt

### Dataflöde (per scan)
```
User URL (Kalshi + PM)
    ↓
Kalshi API ────┐
               ├──▶ Matcher (normalisera namn, fuzzy matcha)
Polymarket API─┘        ↓
               CLOB API (live orderbook)
                        ↓
              Arbitrage Engine (två strategier)
                        ↓
              UI: Scan Panel + Overview Dashboard
                        ↓
              JSON persistence (saved-markets.json)
```

### Kärnmoduler

| Modul | Ansvar |
|-------|--------|
| `kalshi.ts` | Fetch Kalshi markets via event_ticker / series_ticker. Parsar URL till ticker. |
| `polymarket.ts` | Fetch PM event via slug. Parsar JSON-strängar (outcomes, prices). |
| `polymarket-clob.ts` | Fetch live orderbook per conditionId. CLOB = verkliga köp/säljpriser. |
| `matcher.ts` | Matcha names mellan K↔PM. Fuzzy + exact. Beräknar ROIs. |
| `persistence.ts` | JSON-file CRUD för saved markets + lastScanResult. |
| `manual-matches.ts` | JSON-file CRUD för manuella K↔PM-par som auto-missade. |

---

## Kärnaffärslogik

### 1. Prismatchning
- **Exact:** normalisera båda titlar (lowercase, ta bort skiljetecken) → direkt lookup i Map.
- **Fuzzy:** token-baserad Jaccard similarity ≥ 0.4 → bästa matchen per PM-outcome.
- **Filter:** Om PM har >20 Kalshi-kandidater, begränsa via event-titel-nyckelord.

### 2. Arbitrage-beräkning
Givet **kalshi.yesAsk** (pris att köpa YES på Kalshi), **pm.noPrice** (pris att köpa NO på PM), motsvarande **kNo + pYes**:

**Strategi A:** Buy YES Kalshi + NO PM
- Vinst: `1 - (kYesAsk + pNoPrice)` per $1 satsad.
- ROI% = `(1 - (kYesAsk + pNoPrice)) × 100`

**Strategi B:** Buy YES PM + NO Kalshi
- Vinst: `1 - (pYesAsk + kNoAsk)` per $1 satsad.

**APY:** `ROI% × (365 / dagar_till_expiry)`

### 3. Capital-beräkning (depth)
- `capital = min(depthKYes / kYesAsk, depthPNo / pNoPrice)`
- Appen visar: "max $X vid Y% depth" istället för fix $1000.

### 4. CLOB-kritiskt
Polymarket's Gamma-API cachar prices aggressivt. Appen slår alltid upp live CLOB-priser per conditionId för att få best_bid/best_ask/last_trade innan arbitrage beräknas.

---

## UI-hierarki

```
Sidebar (sticky, ~360px)
├── Overview-knapp
├── Kategori-filter (All, Politics, Sports, ...)
├── Sort-by: Name | ROI | Expiry | APY
├── Saved Markets-lista
│   ├── Titel + kategori-badge
│   ├── ROI% badge (grön/röd)
│   ├── APY% badge
│   └── Edit/Delete på hover
└── "Add market"-knapp (alltid synlig underst)

Main Area
├── Scan View ("Single Market")
│   ├── URL-input (Kalshi + PM)
│   ├── Scan-knapp → loading → resultat
│   ├── Result: matchade utfall som expandable rows
│   ├── Kalshi ↔ PM prisjämförelse per rad
│   ├── Arbitrage-badge: "+X% ROI · $Y Profit · ZAPY%"
│   ├── Sparaknapp → sparar till sidebar
│   └── Manual Match UI (om auto missade)
│
├── Overview View
│   ├── Filter-rad: kategori, min-ROI, min-APY, sortering
│   ├── Layout-toggle: Grid ↔ Lista
│   ├── Marknadskort/Tabell-rader
│   │   ├── Namn, ROI%, Profit, APY%, Expiry, Scan-tid
│   │   ├── K-länk · PM-länk · Edit · Delete
│   └── "No markets"-state
```

---

## Datastruktur

### SavedMarket
```typescript
interface SavedMarket {
  id: string;              // timestamp-random
  kalshiUrl: string;
  polymarketUrl: string;
  eventTitle: string;
  category?: string;       // "Politics" | "Sports" | ...
  createdAt: string;       // ISO
  expiryDate?: string;     // ISO, från PM endDate
  lastScanResult?: {
    bestRoiPct: number;
    bestProfit: number;
    strategy: string;
    outcomeCount: number;
    matchedCount: number;
    kalshiCount: number;
    pmCount: number;
    scannedAt: string;
  } | null;
}
```

### UnifiedOutcome (per skannat utfall)
```typescript
interface UnifiedOutcome {
  artist: string;          // Visningsnamn (möjligtvis "Name A + Name B")
  kalshi: {               // null = ej matchat
    ticker: string;
    yesBid: number; yesAsk: number;
    noBid: number;  noAsk: number;
    lastPrice: number;
    volume24h?: string;
    yesBidDepth?: string; yesAskDepth?: string;
    noBidDepth?: string;  noAskDepth?: string;
  } | null;
  polymarket: {
    marketId: string; conditionId: string;
    yesPrice: number; noPrice: number;
    bestBid: number; bestAsk: number;
    lastTradePrice: number;
    volume?: string; liquidity?: string; askDepth?: number;
  } | null;
  arbitrage: {
    strategy: string;          // "Buy YES Kalshi + NO PM" | "Buy YES PM + NO Kalshi" | "No arb"
    kalshiStake: number;       // $ vid capital=1000 eller depth-limited
    pmStake: number;
    expectedProfit: number;
    roiPct: number;
    apyPct: number;
    buyPlatform: 'kalshi' | 'polymarket' | null;
    buyPrice: number;
    sellPlatform: 'kalshi' | 'polymarket' | null;
    sellPrice: number;
  };
  source: 'auto' | 'manual';   // auto-match vs manuellt par
}
```

---

## Konfiguration

| Miljövariabel | Syfte |
|---------------|-------|
| `PORT` | App-port (default 3000) |
| `NEXT_TELEMETRY_DISABLED` | Sätt till 1 för att stänga av Next.js telemetry |

För CLOB krävs **ingen** API-nyckel — Polymarket's CLOB är publikt.

---

## Begränsningar (nuvarande)

1. **Ingen automation:** Appen scannar bara när användaren klickar "Scan" eller går in på en sparad marknad. Ingen bakgrundspoller.
2. **Ingen transaktionslogik:** Appen visar ARBITRAGE-MÖJLIGHETER men exekverar inga trades. Ingen wallet-integration.
3. **Kalshi auth:** Read-only market data är gratis, men trading kräver API-nyckel (ej implementerat).
4. **Manuell URL-inmatning:** Användare måste kopiera-klistra in båda URL:erna. Ingen event-sökning.
5. **Ingen historiksparning:** `lastScanResult` sparar bara 1 resultat per marknad — ingen tidsstämplad logg.
6. **Capital depth:** `calculateArbitrageMax` existerar men används i vissa kontexter fortfarande inte korrekt (se BUG-rapport).
7. **Enkel likviditet:** PM depth hämtas från `liquidityNum` eller CLOB, men Kalshi depth parsas från strängar som "$10K".
8. **Ingen riskmodell:** Appen visar inte "chansen att eventet inträffar / inte inträffar" utöver priset.

---

## Deploy

```bash
cd ~/h2h-arbitrage
npm ci
npx next build
pm2 restart h2h-arbitrage   # eller: npm start -- --port 3000
```

Appen kräver **Next.js 16.2.6**, **React 19.2**, **Tailwind CSS 4**.

---

*Dokumentation skriven: 2026-01-26*
*Senaste funktionella uppdatering: Grid/Lista-toggle, APY-sortering, sticky sidebar*
