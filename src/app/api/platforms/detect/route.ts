/**
 * GET /api/platforms/detect?url=<url> — detect which platform a URL belongs to.
 *
 * Used by the coupling UI when a user enters a market link — the system
 * auto-detects which platform it belongs to and returns the platform config.
 *
 * Response shape:
 *   { platform: { id, name, shortName, iconPath, color, ... } | null }
 */

import { NextRequest, NextResponse } from 'next/server';
import { detectPlatformFromUrl, getPlatformOrNull } from '@/lib/platforms/registry';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  const platformId = detectPlatformFromUrl(url);
  if (!platformId) {
    return NextResponse.json({ platform: null });
  }

  const config = getPlatformOrNull(platformId);
  if (!config) {
    return NextResponse.json({ platform: null });
  }

  return NextResponse.json({
    platform: {
      id: config.id,
      name: config.name,
      shortName: config.shortName,
      iconPath: config.iconPath,
      color: config.color,
      enabled: config.enabled,
      adapterReady: config.adapterReady,
      dataFormat: config.dataFormat,
      feeModel: config.feeModel,
      supportsWebSocket: config.supportsWebSocket,
      sortOrder: config.sortOrder,
    },
  });
}