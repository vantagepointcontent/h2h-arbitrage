import { NextRequest, NextResponse } from 'next/server';
import { getBotPositionAnalytics } from '@/lib/bot-positions';
import { clientSafeError } from '@/lib/error-handler';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const method = request.nextUrl.searchParams.get('method') ?? 'all';
    const mode = request.nextUrl.searchParams.get('mode') ?? 'all';
    if (!['all', 'roi', 'apy', 'hybrid', 'legacy'].includes(method)
      || !['all', 'paper', 'production'].includes(mode)) {
      return NextResponse.json({ success: false, error: 'Invalid analytics filter' }, { status: 400 });
    }
    const analytics = await getBotPositionAnalytics({
      method: method as 'all' | 'roi' | 'apy' | 'hybrid' | 'legacy',
      mode: mode as 'all' | 'paper' | 'production',
    });
    return NextResponse.json(
      { success: true, analytics },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (error) {
    return NextResponse.json({ success: false, error: clientSafeError(error) }, { status: 500 });
  }
}
