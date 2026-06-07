import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { DEFAULT_CONFIG, AdaptiveRefreshConfig } from '@/lib/adaptive-refresh';

const CONFIG_PATH = path.join(process.cwd(), 'src', 'data', 'adaptive-refresh-config.json');

async function readConfig(): Promise<AdaptiveRefreshConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // Normalize: -1 in JSON means Infinity in JS
    if (Array.isArray(parsed.tiers)) {
      parsed.tiers = parsed.tiers.map((t: any) => ({
        ...t,
        maxSeconds: t.maxSeconds === -1 ? Infinity : t.maxSeconds,
      }));
    }
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function writeConfig(config: AdaptiveRefreshConfig): Promise<void> {
  // For JSON serialization, Infinity → -1
  const serializable = {
    ...config,
    tiers: config.tiers.map(t => ({
      ...t,
      maxSeconds: t.maxSeconds === Infinity ? -1 : t.maxSeconds,
    })),
  };
  const dir = path.dirname(CONFIG_PATH);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(serializable, null, 2));
  await fs.rename(tmp, CONFIG_PATH);
}

export async function GET(_: NextRequest): Promise<NextResponse> {
  try {
    const config = await readConfig();
    return NextResponse.json(config);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const current = await readConfig();

    const updated: AdaptiveRefreshConfig = {
      enabled: body.enabled !== undefined ? body.enabled : current.enabled,
      tiers: body.tiers ?? current.tiers,
      globalMultiplier: body.globalMultiplier !== undefined
        ? Math.max(0.1, Math.min(10, Number(body.globalMultiplier)))
        : current.globalMultiplier,
    };

    // Validate tiers if provided
    if (body.tiers) {
      for (const tier of body.tiers) {
        if (!tier.label || typeof tier.maxSeconds === 'undefined' || typeof tier.defaultIntervalSec === 'undefined') {
          return NextResponse.json({ error: 'Each tier must have label, maxSeconds, and defaultIntervalSec' }, { status: 400 });
        }
        if (tier.defaultIntervalSec < 1 || tier.defaultIntervalSec > 3600) {
          return NextResponse.json({ error: `Tier "${tier.label}" interval must be 1-3600 seconds` }, { status: 400 });
        }
      }
    }

    await writeConfig(updated);
    return NextResponse.json(updated);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
