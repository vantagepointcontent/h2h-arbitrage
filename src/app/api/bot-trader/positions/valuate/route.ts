import { NextRequest, NextResponse } from 'next/server';
import { pollOpenBotPositions } from '@/lib/bot-positions';
import { clientSafeError } from '@/lib/error-handler';

function authorized(request: NextRequest): boolean {
  const token = process.env.H2H_API_TOKEN;
  return !token || request.headers.get('x-h2h-token') === token;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const result = await pollOpenBotPositions();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json({ success: false, error: clientSafeError(error) }, { status: 500 });
  }
}
