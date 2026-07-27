export interface ArbAlert {
  key: string;
  targetRoiPct: number;
}

export const ARB_ALERTS_STORAGE_KEY = "h2h-arb-alerts";

export function parseArbAlerts(raw: string | null): Record<string, ArbAlert> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => {
        if (!value || typeof value !== "object") return [];
        const targetRoiPct = (value as { targetRoiPct?: unknown }).targetRoiPct;
        return typeof targetRoiPct === "number" && Number.isFinite(targetRoiPct) && targetRoiPct > 0
          ? [[key, { key, targetRoiPct } satisfies ArbAlert]]
          : [];
      }),
    );
  } catch {
    return {};
  }
}

export function serializeArbAlerts(alerts: Record<string, ArbAlert>): string {
  return JSON.stringify(alerts);
}

export function isAlertThresholdHit(roiPct: number, alert: ArbAlert | undefined): boolean {
  return Boolean(alert && Number.isFinite(roiPct) && roiPct >= alert.targetRoiPct);
}

export function makeArbAlertKey(input: {
  artist: string;
  strategy: string;
  kalshiTicker?: string;
  pmConditionId?: string;
}): string {
  return [input.kalshiTicker ?? "", input.pmConditionId ?? "", input.strategy, input.artist]
    .map(part => encodeURIComponent(part))
    .join(":");
}
