import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

describe('manual-only execution boundary', () => {
  it('keeps scheduled refresh and poller paths disconnected from BotTrader and executeArb', () => {
    const automatedSources = [
      read('src/lib/refresh-job.ts'),
      read('scripts/poll.mjs'),
    ].join('\n');

    expect(automatedSources).not.toMatch(/runBotTraderOn|executeArb|\/api\/execute/);
    expect(read('src/app/api/execute/route.ts')).toContain('await executeArb(effective)');
  });
});
