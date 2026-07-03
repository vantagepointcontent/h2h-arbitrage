// WS-105: Watcher health endpoint — reads data/watcher-health.json written by
// the h2h-watcher daemon every 15s. Returns 200 with the health payload, or a
// 'down'/'stalled' status when the file is missing or hasn't been touched
// recently (daemon dead => file goes stale).

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const HEALTH_FILE = path.join(process.cwd(), 'data', 'watcher-health.json');
const STALE_AFTER_MS = 60_000; // 4 missed 15s writes => daemon considered stalled/dead

export async function GET() {
  let raw: string;
  try {
    raw = fs.readFileSync(HEALTH_FILE, 'utf8');
  } catch {
    return NextResponse.json({ status: 'down', error: 'health file missing — watcher not running?' }, { status: 200 });
  }

  let health: Record<string, unknown>;
  try {
    health = JSON.parse(raw);
  } catch {
    return NextResponse.json({ status: 'down', error: 'health file unreadable' }, { status: 200 });
  }

  const ts = typeof health.ts === 'string' ? Date.parse(health.ts) : NaN;
  const ageMs = Number.isFinite(ts) ? Date.now() - ts : null;
  if (ageMs === null || ageMs > STALE_AFTER_MS) {
    return NextResponse.json({ ...health, status: 'stalled', healthFileAgeMs: ageMs }, { status: 200 });
  }

  return NextResponse.json({ ...health, healthFileAgeMs: ageMs });
}
