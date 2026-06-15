import { NextRequest, NextResponse } from 'next/server';
import { updateSavedMarketScanResult, LastScanResult } from '@/lib/persistence';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, lastScanResult, expiryDate } = body as { id: string; lastScanResult: LastScanResult; expiryDate?: string | null };

    if (!id || !lastScanResult) {
      return NextResponse.json({ error: 'Missing id or lastScanResult' }, { status: 400 });
    }

    await updateSavedMarketScanResult(id, lastScanResult, expiryDate);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[scan-result-save-error]', err);
    return NextResponse.json({ error: err.message || 'Failed to save scan result' }, { status: 500 });
  }
}
