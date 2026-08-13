import { NextResponse } from 'next/server';
import { addBundledMatch, getBundledMatches } from '@/lib/bundled-match-store';
import { parseBundledMatchInput } from '@/lib/bundled-match-request';
import { parseJsonObject } from '@/lib/request-json';
import { clientSafeError } from '@/lib/error-handler';

export async function GET() {
  try {
    return NextResponse.json({ matches: await getBundledMatches() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: clientSafeError(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const input = parseBundledMatchInput(parsed.body);
    if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });
    return NextResponse.json({ match: await addBundledMatch(input) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: clientSafeError(error) }, { status: 500 });
  }
}
