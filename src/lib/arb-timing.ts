export type TimingZone = 'America/New_York' | 'UTC';

export interface ArbTimingEpisode {
  first_seen_at: string;
  category?: string | null;
  status: 'open' | 'closed' | string;
  duration_sec?: number | null;
  scan_count: number;
  peak_roi_pct: number;
}

export interface TimingCell {
  day: number;
  hour: number;
  count: number;
}

export interface ArbTimingHeatmap {
  cells: TimingCell[];
  totalEpisodes: number;
  peakCount: number;
  categories: string[];
}

export function isTrustworthyTimingEpisode(
  episode: ArbTimingEpisode,
  nowMs: number = Date.now(),
): boolean {
  if (!Number.isFinite(episode.peak_roi_pct) || episode.peak_roi_pct <= 0) return false;
  if (!Number.isFinite(episode.scan_count) || episode.scan_count < 2) return false;

  if (episode.status === 'closed') {
    return Number.isFinite(episode.duration_sec) && Number(episode.duration_sec) >= 30;
  }

  const firstSeen = Date.parse(episode.first_seen_at);
  return Number.isFinite(firstSeen) && nowMs - firstSeen >= 30_000;
}

function zonedParts(iso: string, timeZone: TimingZone): { day: number; hour: number } | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday ?? '');
  return day >= 0 && Number.isInteger(hour) ? { day, hour } : null;
}

export function buildArbTimingHeatmap(
  episodes: ArbTimingEpisode[],
  options: { timeZone?: TimingZone; category?: string; nowMs?: number } = {},
): ArbTimingHeatmap {
  const timeZone = options.timeZone ?? 'America/New_York';
  const category = options.category?.trim();
  const nowMs = options.nowMs ?? Date.now();
  const counts = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const categories = new Set<string>();
  let totalEpisodes = 0;

  for (const episode of episodes) {
    const normalizedCategory = episode.category?.trim() || 'Uncategorized';
    if (isTrustworthyTimingEpisode(episode, nowMs)) categories.add(normalizedCategory);
    if (category && normalizedCategory !== category) continue;
    if (!isTrustworthyTimingEpisode(episode, nowMs)) continue;
    const parts = zonedParts(episode.first_seen_at, timeZone);
    if (!parts) continue;
    counts[parts.day][parts.hour] += 1;
    totalEpisodes += 1;
  }

  const cells = counts.flatMap((hours, day) => hours.map((count, hour) => ({ day, hour, count })));
  return {
    cells,
    totalEpisodes,
    peakCount: cells.reduce((peak, cell) => Math.max(peak, cell.count), 0),
    categories: [...categories].sort((a, b) => a.localeCompare(b)),
  };
}
