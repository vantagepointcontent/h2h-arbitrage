import { NextRequest } from 'next/server';
import { executeFullScan } from '../src/app/api/scan/scan-execution';

interface RunMessage {
  type: 'run';
  jobId: string;
  request: {
    body: string;
    url?: string;
    headers?: Record<string, string>;
  };
}

async function serializeResponse(response: Response) {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

let started = false;
process.on('message', async (message: RunMessage) => {
  if (started || message?.type !== 'run') return;
  started = true;
  try {
    const request = new NextRequest(message.request.url || 'http://localhost/api/scan', {
      method: 'POST',
      headers: message.request.headers,
      body: message.request.body,
    });
    const response = await executeFullScan(request);
    process.send?.({ type: 'result', jobId: message.jobId, response: await serializeResponse(response) });
    process.disconnect?.();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    process.send?.({ type: 'error', jobId: message.jobId, error: text });
    process.disconnect?.();
  }
});
