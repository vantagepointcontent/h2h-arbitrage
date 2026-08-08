import { NextResponse } from 'next/server';
import { getBotPositionAnalytics } from '@/lib/bot-positions';
import { clientSafeError } from '@/lib/error-handler';

export async function GET(): Promise<NextResponse> {
  try {
    const analytics = await getBotPositionAnalytics();
    return NextResponse.json(
      { success: true, analytics },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (error) {
    return NextResponse.json({ success: false, error: clientSafeError(error) }, { status: 500 });
  }
}
