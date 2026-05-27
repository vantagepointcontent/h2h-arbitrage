import { promises as fs } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

const HEALTH_FILE = path.join(process.cwd(), 'data', 'poller-health.json');

export async function GET() {
  try {
    const raw = await fs.readFile(HEALTH_FILE, 'utf-8');
    const health = JSON.parse(raw);
    return NextResponse.json({
      ...health,
      now: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  } catch (err: unknown) {
    const isNotFound = typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
    return NextResponse.json({
      status: isNotFound ? 'not_started' : 'error',
      error: isNotFound ? 'Poller health file has not been created yet' : (err instanceof Error ? err.message : String(err)),
      path: HEALTH_FILE,
      now: new Date().toISOString(),
    }, { status: isNotFound ? 200 : 500 });
  }
}
