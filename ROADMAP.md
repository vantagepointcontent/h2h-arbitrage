# H2H Arbitrage — Feature-Roadmap

## Vision
Gå från "manuell scanner" till en **automatisk, intelligent arbitrage-övervakare** som hittar, bevakar, och långsiktigt hjälper dig tjäna pengar — först som beslutsstöd, sedan som halvautomatiserad trading-assistent.

---

## 1. 🤖 Bakgrundsscannare + Notifieringar
**Beskrivning:** Spara marknader skannas automatiskt var 5:e minut. Vid ROI- eller APY-tröskelöverskridande → notis (Slack/Telegram/email).

**Värde:** Du behöver inte klicka på varje marknad. Missa aldrig en 50%+ APY-chans.

**Implementation:**
- Cronjob i h2h-poller (existerar redan!) som itererar saved-markets.
- Threshold-konfig per marknad (global: "Notifiera mig vid ROI > 5% och APY > 50%").
- Telegram/Slack-integrering via Hermes (redan uppsatt).

---

## 2. 📊 Historisk prislogg ("Price Tracker")
**Beskrivning:** För varje sparad marknad, spara varje scan-resultat i en tidsstämplad fil (CSV eller SQLite). Visa grafer: ROI över tid, pris-spread historik.

**Värde:** Identifera mönster. "Den här marknaden brukar ha högst arbitrage på tisdagar." "Spreaden slutade minska 2 dagar före expiry."

**Implementation:**
- SQLite-inkrementell logg i `data/price-history.db`.
- UI: sparkline-graf per marknad i Overview.
- Exportera CSV för extern analys (t.ex. Google Sheets).

---

## 3. 🔎 Event Discovery / Sök
**Beskrivning:** Istället för att kopiera-klistra URL:er, sök efter events. "Trump" → listar alla Kalshi- och Polymarket-events med "trump" i titeln. Klicka för att auto-par.

**Värde:** Dramatiskt snabbare workflow. Upptäck nya events du inte visste fanns.

**Implementation:**
- `GET /api/discover?q=trump` → söker båda plattformar.
- Fuzzy-matning av kalshi event_ticker ↔ PM slug via vår existerande matcher.
- "Suggested Pairs"-lista som rankas efter expected APY.

---

## 4. 💰 Real Capital Simulation & Riskmodell
**Beskrivning:** Istället för fixt $1000, låt användaren mata in sin **riktiga capital** per plattform ($5000 på Kalshi, $10000 på PM). Simulera hur mycket de kan satsa givet deras faktiska balans.

**Värde:** Mer realistiska siffror. Förhindrar överleverage. Visar "du har $X ledigt på Kalshi, detta arbitrage kräver $Y — det funkar!"

**Implementation:**
- Formulär: "Min Kalshi-balance", "Min PM-balance".
- Kalshi: pseudo-balance via öppen-order-summa (read-only API).
- PM: balance kräver wallet-adress (blockchain-läsning, mer komplext).

---

## 5. 📐 Risk-analys: "Expected Value" (EV)
**Beskrivning:** Just nu visar appen arbitrage som om det är riskfritt. Men om en sida har dålig liquidity kan du inte stänga positionen. Lägg till:

- **EV = (Sannolikhet att du kan stänga × Vinst) − (Sannolikhet att fastna × Förlust)**
- Liquidity Rating: "High/Med/Low" per sida.
- "Execution Risk"-badge: "PM-sidan har bara $200 depth — du kanske bara får köpa $50."

**Värde:** Beslutsunderlag för *huruvida* arbitragen är möjlig i praktiken, inte bara teoretiskt.

---

## 6. 🔄 "One-click" Auto-Match-förbättringar
**Beskrivning:** Manual Matching är ett krutch. Förbättra automatiken:

- ML/NLP-baserad entity recognition: "Will Elon Musk..." på båda sidor → Elon Musk.
- Title-normalisering av known patterns: "2024 Presidential Election" ↔ "US Election 2024".
- Användarens historiska manuella matches som träningsdata: "Du matchade SpaceX IPO T70 med pm-xxx → kom ihåg detta för framtida SpaceX-events."

**Värde:** Mindre manuellt arbete. Snabbare scanning.

**Implementation:**
- Bygg en "match confidence score" + låt ML-modellen tränas på manuella matches.
- Om confidence > 0.9: auto-match. Om 0.7-0.9: föreslå men vänta på godkännande.

---

## 7. 🔔 Larmsystem: "Arbitrage disappeared"
**Beskrivning:** En marknad som hade +10% ROI går till 0%. Notifiera: "Arbitrage försvann — kanske pga ny information (ex: ny poll släpptes)."

**Värde:** Du vet när chansen är förbi, och när du ska leta efter nästa.

**Implementation:**
- Jämför `lastScanResult` med nu current. Om ROI sjunker från >5% till <1% → larm.

---

## 8. 🏦 Paper Trading-simulator
**Beskrivning:** Registrera "virtuella trades": "Jag skulle ha köpt $500 YES Kalshi + $500 NO PM". Spåra vad utfallet skulle blivit.

**Värde:** Validera att arbitrage-matematiken stämmer i praktiken innan du satsar riktiga pengar.

**Implementation:**
- JSON-logg av paper trades: `{ date, market, strategy, capital, buyPrices, sellPrices, realizedPnL }`.
- UI: "Paper PnL-tracker"-flik.

---

## 9. 🤝 Multi-plattform expansion (PredictIt, Betfair, Smarkets)
**Beskrivning:** Inte bara Kalshi ↔ PM. Lägg till PredictIt (USA), Betfair (UK), Smarkets (UK). Skanna ALLA 4 efter samma event.

**Värde:** Större arbitrage-universum. Fler motparter = bättre prices.

**Implementation:**
- Abstrahera `MarketSource`-interface. Varje källa: `fetchMarkets(event)`, `normalizeName(name)`, `getPrices(outcome)`.
- "Best-of-N" arbitrage: köp billigaste Yes + billigaste No från vilket par som helst.

---

## 10. 📱 Mobilapp / PWA
**Beskrivning:** Gör H2H till en installable PWA med push-notifieringar.

**Värde:** Du får notiser när du är på stan och kan scanna snabbt på mobilen.

**Implementation:**
- `next-pwa`-plugin. Manifest.json. Service worker för offline-granskning av saved markets.
- Push-notifieringar via web-push (VAPID-nycklar) ↔ Hermes cron.

---

## Prioritering (MoSCoW)

| Feature | Prioritet | Ansträngning | Värde |
|---------|-----------|--------------|-------|
| 1. Bakgrundsscannare + notiser | **Must** | Låg | **Kritiskt** |
| 3. Event Discovery / Sök | **Must** | Medel | **Kritiskt** |
| 2. Historisk prislogg | **Should** | Medel | **Högt** |
| 5. Risk-analys / EV | **Should** | Medel | **Högt** |
| 4. Real Capital Simulation | **Should** | Medel | **Högt** |
| 7. "Arbitrage disappeared"-larm | **Should** | Låg | **Medel** |
| 6. Auto-match ML | **Could** | Hög | **Högt** |
| 8. Paper Trading | **Could** | Låg | **Medel** |
| 9. Multi-plattform | **Could** | Hög | **Mycket högt** |
| 10. PWA / Mobile | **Could** | Medel | **Medel** |

---

## Kortsiktig roadmap (nästa 2 veckor)

1. **Fixa kvarstående buggar** (depthPNo, calculateArbitrageMax-användning)
2. **Implementera bakgrundsscannare** (Feature 1)
3. **Event Discovery MVP** (Feature 3 — sök + föreslår par)
4. **Paper Trading-registrering** (Feature 8 — simpel JSON-logg)
5. **Risk-analys MVP** (Feature 5 — liquidity badge per sida)

---

*Roadmap skriven: 2026-01-26*
*Utgångspunkt: H2H Arbitrage v0.1.0*
