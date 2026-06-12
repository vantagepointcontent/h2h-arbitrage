import { NextResponse } from "next/server";
import { loadScanConfig, saveScanConfig, ScanConfig, getScanPlanSummary, sortMarketsByScanPriority, isMarketDueForScan } from "@/lib/scan-frequency";
import { getSavedMarkets } from "@/lib/persistence";

export async function GET() {
  const config = loadScanConfig();
  const markets = await getSavedMarkets();
  const plan = getScanPlanSummary(markets, config.tiers);
  return NextResponse.json({ config, plan });
}

export async function POST(req: Request) {
  const body = await req.json();
  const newConfig: ScanConfig = {
    tiers: body.tiers,
    lastUpdated: new Date().toISOString(),
  };
  saveScanConfig(newConfig);
  return NextResponse.json({ success: true, config: newConfig });
}
