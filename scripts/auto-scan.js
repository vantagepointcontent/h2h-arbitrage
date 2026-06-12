/**
 * Auto-scan all saved markets every 15 minutes
 * Uses /api/saved-markets/refresh endpoint (saves to DB)
 * Runs as a cron job via Hermes scheduler
 */
const BASE_URL = process.env.APP_URL || "http://100.86.7.30:3000";

async function autoScanAll() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting auto-scan of all saved markets...`);

  try {
    const scanRes = await fetch(`${BASE_URL}/api/saved-markets/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!scanRes.ok) {
      throw new Error(`Refresh endpoint returned ${scanRes.status}: ${await scanRes.text()}`);
    }

    const results = await scanRes.json();

    const total = results.length;
    const succeeded = results.filter(r => !r.error).length;
    const failed = total - succeeded;
    const withArb = results.filter(r => r.bestRoiPct > 0).length;

    console.log(`[${timestamp}] Auto-scan complete: ${succeeded}/${total} succeeded, ${failed} failed, ${withArb} with arbitrage`);

    // Log top 5 opportunities
    const top5 = results
      .filter(r => r.bestRoiPct > 0)
      .sort((a, b) => b.bestRoiPct - a.bestRoiPct)
      .slice(0, 5);

    for (const r of top5) {
      console.log(
        `[${timestamp}] ✅ ${r.eventTitle}: +${r.bestRoiPct.toFixed(2)}% ROI, $${r.bestProfit.toFixed(2)} profit`
      );
    }

    if (failed > 0) {
      const errors = results.filter(r => r.error).map(r => `${r.eventTitle}: ${r.error}`).join("; ");
      console.error(`[${timestamp}] ❌ Failures: ${errors}`);
    }
  } catch (err) {
    console.error(`[${timestamp}] Auto-scan CRITICAL ERROR: ${err.message}`);
    process.exit(1);
  }
}

autoScanAll();
