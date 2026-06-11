/**
 * Auto-scan all saved markets every 15 minutes
 * Runs as a cron job via Hermes scheduler
 */
const BASE_URL = process.env.APP_URL || "http://100.86.7.30:3000";

async function autoScanAll() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting auto-scan of all saved markets...`);

  try {
    // 1. Fetch all saved markets
    const marketsRes = await fetch(`${BASE_URL}/api/saved-markets`);
    if (!marketsRes.ok) throw new Error(`Failed to fetch saved markets: ${marketsRes.status}`);
    const markets = await marketsRes.json();

    console.log(`[${timestamp}] Found ${markets.length} saved markets`);

    // 2. Scan each market sequentially (to avoid rate limiting)
    let successCount = 0;
    let failCount = 0;

    for (const market of markets) {
      try {
        const scanRes = await fetch(`${BASE_URL}/api/scan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kalshiUrl: market.kalshiUrl,
            polymarketUrl: market.polymarketUrl,
          }),
        });

        if (!scanRes.ok) {
          console.error(`[${timestamp}] Scan failed for ${market.id}: ${scanRes.status}`);
          failCount++;
          continue;
        }

        const result = await scanRes.json();
        successCount++;

        // Log summary
        const bestRoi = result.outcomes
          ?.filter((o) => o.arbitrage?.expectedProfit > 0)
          ?.sort((a, b) => b.arbitrage.roiPct - a.arbitrage.roiPct)[0];

        if (bestRoi) {
          console.log(
            `[${timestamp}] ✅ ${market.eventTitle}: +${bestRoi.arbitrage.roiPct}% ROI, $${(bestRoi.arbitrage.expectedProfit / 100).toFixed(2)} profit`
          );
        } else {
          console.log(`[${timestamp}] ⚪ ${market.eventTitle}: No arb found`);
        }
      } catch (err) {
        console.error(`[${timestamp}] ❌ Error scanning ${market.id}: ${err.message}`);
        failCount++;
      }

      // Small delay between scans to be nice to the APIs
      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log(`[${timestamp}] Auto-scan complete: ${successCount} succeeded, ${failCount} failed`);
  } catch (err) {
    console.error(`[${timestamp}] Auto-scan CRITICAL ERROR: ${err.message}`);
    process.exit(1);
  }
}

autoScanAll();
