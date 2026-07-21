import { NextRequest, NextResponse } from 'next/server';
import { getManualMatches, addManualMatch } from '@/lib/manual-matches';
import { clientSafeError } from '@/lib/error-handler';
import { parseJsonObject } from '@/lib/request-json';
import { parseManualMatchInput } from '@/lib/manual-match-request';

export async function GET() {
  try {
    const matches = await getManualMatches();
    return NextResponse.json({ matches }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      }
    });
  } catch (err: any) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const input = parseManualMatchInput(parsed.body);
    if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });
    const match = await addManualMatch(input);
    return NextResponse.json({ match }, { status: 201 });
  } catch (err: any) {
    if (err.message === 'Manual match already exists for this pair') {
      return NextResponse.json({ error: clientSafeError(err) }, { status: 409 });
    }
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
