/**
 * AUTO-002: Market lifecycle auto-retirement.
 *
 * Archives saved markets that are no longer worth polling:
 *   • expired  — expiryDate + lifecycle.expiryGraceHours in the past
 *   • dead     — zero matched outcomes for lifecycle.deadMarketDays
 *                (based on last_matched_at; markets never matched use createdAt)
 *
 * Archived markets are excluded from getSavedMarkets() (and thus the JSON
 * mirror the poller reads), so polling budget is reclaimed automatically.
 * They remain in SQLite and can be restored via unarchiveSavedMarket().
 *
 * The sweep runs hourly from the auto-discovery scheduler tick and can be
 * triggered manually via POST /api/lifecycle {action:'sweep'}.
 */
import { getSavedMarkets, archiveSavedMarket, SavedMarket } from './persistence';
import { getSetting } from './settings';

export interface SweepResult {
  checked: number;
  archivedExpired: number;
  archivedDead: number;
  skippedFavorites: number;
  archived: { id: string; eventTitle: string; reason: string }[];
  enabled: boolean;
}

function classify(
  m: SavedMarket,
  now: number,
  graceMs: number,
  deadMs: number,
  protectFavorites: boolean,
): 'expired' | 'dead' | 'favorite-skip' | null {
  const isExpired = (() => {
    if (!m.expiryDate) return false;
    const exp = Date.parse(m.expiryDate);
    return Number.isFinite(exp) && now > exp + graceMs;
  })();

  const isDead = (() => {
    // Reference point: last matched scan, else creation time.
    const ref = Date.parse(m.lastMatchedAt || m.createdAt || '');
    if (!Number.isFinite(ref)) return false;
    // Only call it dead if we HAVE scanned it and it shows zero matches.
    const scanned = !!m.lastScanResult?.scannedAt;
    const zeroMatched = (m.lastScanResult?.matchedCount ?? 0) === 0;
    return scanned && zeroMatched && now - ref > deadMs;
  })();

  if (!isExpired && !isDead) return null;
  if (protectFavorites && m.favorite) return 'favorite-skip';
  return isExpired ? 'expired' : 'dead';
}

/** Run one lifecycle sweep. Safe to call repeatedly (idempotent). */
export async function runLifecycleSweep(): Promise<SweepResult> {
  const result: SweepResult = {
    checked: 0, archivedExpired: 0, archivedDead: 0,
    skippedFavorites: 0, archived: [], enabled: true,
  };

  const enabled = await getSetting<boolean>('lifecycle.enabled');
  if (!enabled) {
    result.enabled = false;
    return result;
  }
  const graceMs = (await getSetting<number>('lifecycle.expiryGraceHours')) * 3600_000;
  const deadMs = (await getSetting<number>('lifecycle.deadMarketDays')) * 86_400_000;
  const protectFavorites = await getSetting<boolean>('lifecycle.protectFavorites');

  const markets = await getSavedMarkets(); // active only
  result.checked = markets.length;
  const now = Date.now();

  for (const m of markets) {
    const verdict = classify(m, now, graceMs, deadMs, protectFavorites);
    if (!verdict) continue;
    if (verdict === 'favorite-skip') { result.skippedFavorites++; continue; }
    const ok = await archiveSavedMarket(m.id, verdict);
    if (ok) {
      if (verdict === 'expired') result.archivedExpired++;
      else result.archivedDead++;
      result.archived.push({ id: m.id, eventTitle: m.eventTitle, reason: verdict });
      console.log(`[lifecycle] Archived "${m.eventTitle}" (${verdict})`);
    }
  }

  if (result.archived.length > 0) {
    console.log(`[lifecycle] Sweep done: ${result.archivedExpired} expired, ${result.archivedDead} dead archived (of ${result.checked} active)`);
  }
  return result;
}

/** Dry-run: report what WOULD be archived without touching the DB. */
export async function previewLifecycleSweep(): Promise<SweepResult> {
  const result: SweepResult = {
    checked: 0, archivedExpired: 0, archivedDead: 0,
    skippedFavorites: 0, archived: [], enabled: true,
  };
  const graceMs = (await getSetting<number>('lifecycle.expiryGraceHours')) * 3600_000;
  const deadMs = (await getSetting<number>('lifecycle.deadMarketDays')) * 86_400_000;
  const protectFavorites = await getSetting<boolean>('lifecycle.protectFavorites');
  result.enabled = await getSetting<boolean>('lifecycle.enabled');

  const markets = await getSavedMarkets();
  result.checked = markets.length;
  const now = Date.now();
  for (const m of markets) {
    const verdict = classify(m, now, graceMs, deadMs, protectFavorites);
    if (!verdict) continue;
    if (verdict === 'favorite-skip') { result.skippedFavorites++; continue; }
    if (verdict === 'expired') result.archivedExpired++; else result.archivedDead++;
    result.archived.push({ id: m.id, eventTitle: m.eventTitle, reason: verdict });
  }
  return result;
}
