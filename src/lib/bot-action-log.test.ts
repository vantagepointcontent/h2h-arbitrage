import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-action-log-'));
  fs.mkdirSync(path.join(tempDir, 'data'));
  process.chdir(tempDir);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('bot action log persistence', () => {
  it('stores payloads, filters rows, paginates, and prunes old entries', async () => {
    const log = await import('./bot-action-log');
    await log.appendBotActionLog({ tradeId:'trade-1', trigger:'scan', marketId:'m1', marketTitle:'Market 1', step:'detection', action:'found', responseStatus:'passed', requestPayload:{ roi:3.2 } });
    const second = await log.appendBotActionLog({ tradeId:'trade-1', trigger:'scan', marketId:'m1', marketTitle:'Market 1', step:'criteria', action:'rejected', responseStatus:'failed', errorReason:'depth', timestamp:'2020-01-01T00:00:00.000Z' });

    const failed = await log.getBotActionLogs({ status:'failed' });
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0]).toMatchObject({ id:second, errorReason:'depth', marketId:'m1' });

    const passed = await log.getBotActionLogs({ status:'passed' });
    expect(passed.rows[0].requestPayload).toEqual({ roi:3.2 });
    expect(await log.pruneBotActionLogs(30)).toBe(1);
  });
});
