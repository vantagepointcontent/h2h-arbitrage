import { NextResponse } from 'next/server';
import { deleteBundledMatch, updateBundledMatch } from '@/lib/bundled-match-store';
import { parseBundledMatchInput } from '@/lib/bundled-match-request';
import { parseJsonObject } from '@/lib/request-json';
import { parseResourceId } from '@/lib/resource-id';
import { clientSafeError } from '@/lib/error-handler';

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = parseResourceId((await params).id);
    if (!id) return NextResponse.json({ error: 'Missing or invalid id' }, { status: 400 });
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const input = parseBundledMatchInput(parsed.body);
    if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });
    return NextResponse.json({ match: await updateBundledMatch(id, input) });
  } catch (error) {
    if (error instanceof Error && error.message === 'Bundled match not found') return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: clientSafeError(error) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = parseResourceId((await params).id);
    if (!id) return NextResponse.json({ error: 'Missing or invalid id' }, { status: 400 });
    return NextResponse.json({ success: await deleteBundledMatch(id) });
  } catch (error) {
    return NextResponse.json({ error: clientSafeError(error) }, { status: 500 });
  }
}
