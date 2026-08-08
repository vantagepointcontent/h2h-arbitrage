export type OpportunityRiskState = "executable" | "thin" | "stale" | "blocked";
export type OpportunityPersistence = "new" | "durable" | "fading" | "unknown";

export interface OpportunitySource {
  artist: string;
  kalshi?: {
    ticker?: string;
    yesAsk: number;
    noAsk: number;
    yesAskDepth?: string;
    noAskDepth?: string;
  } | null;
  polymarket?: {
    conditionId?: string;
    yesPrice: number;
    noPrice: number;
    askDepth?: number;
    noAskDepth?: number;
  } | null;
  arbitrage: {
    strategy: string;
    expectedProfit: number;
    roiPct: number;
    apyPct?: number;
    kalshiStake?: number;
    pmStake?: number;
    maxCapital?: number;
    suspicious?: boolean;
    fees?: {
      kalshiFee: number;
      pmFee: number;
      worstCaseNetProfit: number;
    };
  };
  persistence?: OpportunityPersistence;
  persistenceMinutes?: number;
}

export interface OpportunityViewModel {
  id: string;
  marketId?: string;
  marketTitle: string;
  outcome: string;
  strategy: string;
  netProfit: number;
  netRoiPct: number;
  requiredCapital: number;
  maxFillableStake: number;
  dataAgeMs: number | null;
  persistence: OpportunityPersistence;
  persistenceMinutes: number | null;
  riskState: OpportunityRiskState;
  blockers: string[];
  rankScore: number;
  source: OpportunitySource;
}

export type OpportunityFilter =
  | "all"
  | "executable"
  | "durable"
  | "new"
  | "fading"
  | "thin"
  | "stale"
  | "needs-matching";

const STALE_AFTER_MS = 90_000;
const THIN_STAKE = 100;

function stableId(source: OpportunitySource, marketId?: string): string {
  return [marketId ?? "market", source.artist, source.arbitrage.strategy, source.kalshi?.ticker ?? "k", source.polymarket?.conditionId ?? "p"].join("::");
}

export function buildOpportunityViewModel(
  source: OpportunitySource,
  context: { marketId?: string; marketTitle?: string; scannedAt?: string | null; now?: number } = {},
): OpportunityViewModel {
  const now = context.now ?? Date.now();
  const scannedTime = context.scannedAt ? Date.parse(context.scannedAt) : Number.NaN;
  const dataAgeMs = Number.isFinite(scannedTime) ? Math.max(0, now - scannedTime) : null;
  const requiredCapital = Math.max(0, (source.arbitrage.kalshiStake ?? 0) + (source.arbitrage.pmStake ?? 0));
  const maxFillableStake = Math.max(0, source.arbitrage.maxCapital ?? requiredCapital);
  const netProfit = source.arbitrage.fees?.worstCaseNetProfit ?? source.arbitrage.expectedProfit;
  const blockers: string[] = [];

  if (!source.kalshi?.ticker) blockers.push("Kalshi match missing");
  if (!source.polymarket?.conditionId) blockers.push("Polymarket match missing");
  if (source.arbitrage.suspicious) blockers.push("Suspicious pricing");
  if (requiredCapital <= 0) blockers.push("Executable stakes unavailable");

  const isStale = dataAgeMs == null || dataAgeMs > STALE_AFTER_MS;
  const isThin = maxFillableStake < THIN_STAKE;
  const riskState: OpportunityRiskState = blockers.length > 0
    ? "blocked"
    : isStale
      ? "stale"
      : isThin
        ? "thin"
        : "executable";

  // Start with executable net dollars. ROI rewards capital efficiency, while
  // stale, thin, and blocked data receive explicit deterministic penalties.
  const qualityMultiplier = riskState === "blocked" ? 0.05 : riskState === "stale" ? 0.25 : riskState === "thin" ? 0.55 : 1;
  const persistenceMultiplier = source.persistence === "durable" ? 1.15 : source.persistence === "fading" ? 0.7 : 1;
  const rankScore = Math.max(0, netProfit) * (1 + Math.max(0, source.arbitrage.roiPct) / 100) * qualityMultiplier * persistenceMultiplier;

  return {
    id: stableId(source, context.marketId),
    marketId: context.marketId,
    marketTitle: context.marketTitle ?? context.marketId ?? "Current market",
    outcome: source.artist,
    strategy: source.arbitrage.strategy,
    netProfit,
    netRoiPct: source.arbitrage.roiPct,
    requiredCapital,
    maxFillableStake,
    dataAgeMs,
    persistence: source.persistence ?? "unknown",
    persistenceMinutes: source.persistenceMinutes ?? null,
    riskState,
    blockers,
    rankScore,
    source,
  };
}

export function rankOpportunities(opportunities: OpportunityViewModel[]): OpportunityViewModel[] {
  return [...opportunities].sort((a, b) => b.rankScore - a.rankScore || b.netProfit - a.netProfit || b.netRoiPct - a.netRoiPct);
}

export function filterOpportunities(opportunities: OpportunityViewModel[], filter: OpportunityFilter): OpportunityViewModel[] {
  if (filter === "all") return opportunities;
  if (filter === "needs-matching") return opportunities.filter((item) => item.blockers.some((blocker) => blocker.includes("match missing")));
  if (filter === "thin" || filter === "stale" || filter === "executable") return opportunities.filter((item) => item.riskState === filter);
  return opportunities.filter((item) => item.persistence === filter);
}
