import { NextResponse } from "next/server";
import { loadScanConfig, saveScanConfig, ScanConfig, getScanPlanSummary, parseScanConfigTiers } from "@/lib/scan-frequency";
import { parseJsonObject } from "@/lib/request-json";
import { getSavedMarkets } from "@/lib/persistence";

export async function GET() {
  const config = loadScanConfig();
  const markets = await getSavedMarkets();
  const plan = getScanPlanSummary(markets, config.tiers);
  return NextResponse.json({ config, plan });
}

export async function POST(req: Request) {
  const parsed = await parseJsonObject(req);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const tiers = parseScanConfigTiers(parsed.body.tiers);
  if ('error' in tiers) return NextResponse.json({ error: tiers.error }, { status: 400 });

  const newConfig: ScanConfig = {
    tiers: tiers.tiers,
    lastUpdated: new Date().toISOString(),
  };
  saveScanConfig(newConfig);
  return NextResponse.json({ success: true, config: newConfig });
}
