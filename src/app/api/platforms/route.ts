/**
 * GET /api/platforms — list all registered platforms.
 *
 * Returns the platform registry (minus credential keys for security).
 * Frontend uses this to populate platform selectors, show/hide platforms
 * in settings, and detect which platforms are operational.
 *
 * Response shape:
 *   { platforms: [{ id, name, shortName, iconPath, color, enabled, adapterReady, ... }] }
 */

import { NextResponse } from 'next/server';
import { getAllPlatforms } from '@/lib/platforms/registry';

export const dynamic = 'force-dynamic';

export async function GET() {
  const platforms = getAllPlatforms().map(p => ({
    id: p.id,
    name: p.name,
    shortName: p.shortName,
    iconPath: p.iconPath,
    color: p.color,
    enabled: p.enabled,
    adapterReady: p.adapterReady,
    dataFormat: p.dataFormat,
    feeModel: p.feeModel,
    supportsWebSocket: p.supportsWebSocket,
    sortOrder: p.sortOrder,
    // Deliberately exclude credentialKeys for security
  }));

  return NextResponse.json({ platforms });
}