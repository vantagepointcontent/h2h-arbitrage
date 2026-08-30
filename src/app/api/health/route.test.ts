import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');

describe('health route runtime freshness', () => {
  it('waits for each incoming request instead of serving a prerendered deployment identity', () => {
    expect(route).toContain("import { connection, NextResponse } from 'next/server'");
    expect(route).toContain('export async function GET() {\n  await connection();');
    expect(route).toContain("'Cache-Control': 'no-store, no-cache, must-revalidate'");
  });
});
