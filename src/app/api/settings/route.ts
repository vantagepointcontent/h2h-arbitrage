import { NextRequest, NextResponse } from 'next/server';
import { getAllSettings, setSettings, resetSetting } from '@/lib/settings';
import { clientSafeError } from '@/lib/error-handler';
import { parseJsonObject } from '@/lib/request-json';

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

/** GET /api/settings — all settings with resolved values + sources. */
export async function GET() {
  try {
    const settings = await getAllSettings();
    return NextResponse.json({ settings }, { headers: NO_CACHE });
  } catch (err: unknown) {
    console.error('[settings-get-error]', err);
    return NextResponse.json({ error: clientSafeError(err, 'Failed to load settings') }, { status: 500 });
  }
}

/**
 * POST /api/settings
 * Body: { values: { "alerts.minRoiPct": 2, ... } }  — set overrides (all-or-nothing)
 *   or: { reset: "alerts.minRoiPct" }               — remove a DB override
 * Token-protected by middleware (x-h2h-token) like all non-GET API calls.
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const body = parsed.body;

    if (typeof body.reset === 'string') {
      await resetSetting(body.reset);
      const settings = await getAllSettings();
      return NextResponse.json({ success: true, settings }, { headers: NO_CACHE });
    }

    if (!body?.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
      return NextResponse.json({ error: 'Body must be { values: { key: value } } or { reset: key }' }, { status: 400 });
    }

    const result = await setSettings(body.values as Record<string, unknown>);
    if (!result.ok) {
      return NextResponse.json({ error: 'Validation failed', details: result.errors }, { status: 400 });
    }

    const settings = await getAllSettings();
    return NextResponse.json({ success: true, settings }, { headers: NO_CACHE });
  } catch (err: unknown) {
    console.error('[settings-post-error]', err);
    return NextResponse.json({ error: clientSafeError(err, 'Failed to save settings') }, { status: 500 });
  }
}
