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

  it('filters whole evaluation chains by explicit qualification outcome', async () => {
    const log = await import('./bot-action-log');
    await log.appendBotActionLog({ tradeId:'qualified-1', trigger:'scan', marketId:'m1', marketTitle:'Qualified', step:'detection', action:'Scan found arb', responseStatus:'passed' });
    await log.appendBotActionLog({ tradeId:'qualified-1', trigger:'scan', marketId:'m1', marketTitle:'Qualified', step:'safety-gate', action:'all gates passed', responseStatus:'passed', qualificationOutcome:'qualified' });
    await log.appendBotActionLog({ tradeId:'qualified-1', trigger:'scan', marketId:'m1', marketTitle:'Qualified', step:'execution', action:'later failed', responseStatus:'failed' });
    await log.appendBotActionLog({ tradeId:'dead-1', trigger:'scan', marketId:'m2', marketTitle:'Dead', step:'criteria_check', action:'rejected', responseStatus:'failed', qualificationOutcome:'dead' });
    await log.appendBotActionLog({ tradeId:'positive-but-ineligible', trigger:'scan', marketId:'m3', marketTitle:'Positive but ineligible', step:'criteria_check', action:'positive arb', responseStatus:'passed' });
    await log.appendBotActionLog({ tradeId:'positive-but-ineligible', trigger:'scan', marketId:'m3', marketTitle:'Positive but ineligible', step:'preflight', action:'daily exposure rejected', responseStatus:'failed', qualificationOutcome:'dead' });
    await log.appendBotActionLog({ tradeId:'premature-qualified', trigger:'scan', marketId:'m4', marketTitle:'Premature marker', step:'preflight', action:'legacy qualified marker', responseStatus:'passed', qualificationOutcome:'qualified' });
    await log.appendBotActionLog({ tradeId:'premature-qualified', trigger:'scan', marketId:'m4', marketTitle:'Premature marker', step:'safety-gate', action:'authoritative economics rejected', responseStatus:'failed' });
    await log.appendBotActionLog({ tradeId:'qualified-without-detection', trigger:'legacy', marketId:'m6', marketTitle:'Unclassified qualified marker', step:'safety-gate', action:'qualified marker without classification', responseStatus:'passed', qualificationOutcome:'qualified' });
    await log.appendBotActionLog({ tradeId:'mixed-outcomes', trigger:'scan', marketId:'m5', marketTitle:'Mixed outcomes', step:'detection', action:'Scan found arb', responseStatus:'passed' });
    await log.appendBotActionLog({ tradeId:'mixed-outcomes', trigger:'scan', marketId:'m5', marketTitle:'Mixed outcomes', step:'safety-gate', action:'qualified', responseStatus:'passed', qualificationOutcome:'qualified' });
    await log.appendBotActionLog({ tradeId:'mixed-outcomes', trigger:'scan', marketId:'m5', marketTitle:'Mixed outcomes', step:'preflight', action:'later eligibility rejection', responseStatus:'failed', qualificationOutcome:'dead' });

    const qualified = await log.getBotActionLogs({ qualified: true });
    expect(new Set(qualified.rows.map((row) => row.tradeId))).toEqual(new Set(['qualified-1']));
    expect(qualified.rows.some((row) => row.responseStatus === 'failed')).toBe(true);
    expect(qualified.rows.every((row) => row.positiveArb)).toBe(true);

    const dead = await log.getBotActionLogs({ qualified: false });
    expect(new Set(dead.rows.map((row) => row.tradeId))).toEqual(new Set(['dead-1', 'positive-but-ineligible', 'mixed-outcomes']));
  });

  it('filters positive-arb chains without requiring every qualification gate to pass', async () => {
    const log = await import('./bot-action-log');
    await log.appendBotActionLog({ tradeId:'qualified', trigger:'scan', marketId:'m1', marketTitle:'Qualified', step:'detection', action:'Scan found arb', responseStatus:'passed' });
    await log.appendBotActionLog({ tradeId:'qualified', trigger:'scan', marketId:'m1', marketTitle:'Qualified', step:'safety-gate', action:'all gates passed', responseStatus:'passed', qualificationOutcome:'qualified' });
    await log.appendBotActionLog({ tradeId:'later-rejected', trigger:'scan', marketId:'m2', marketTitle:'Later rejected', step:'detection', action:'Scan found arb', responseStatus:'passed' });
    await log.appendBotActionLog({ tradeId:'later-rejected', trigger:'scan', marketId:'m2', marketTitle:'Later rejected', step:'criteria_check', action:'ROI threshold rejected', responseStatus:'failed', qualificationOutcome:'dead' });
    await log.appendBotActionLog({ tradeId:'unclassified', trigger:'legacy', marketId:'m3', marketTitle:'Unclassified', step:'criteria_check', action:'Legacy row', responseStatus:'failed', qualificationOutcome:'dead' });

    const positive = await log.getBotActionLogs({ positiveArb: true });
    expect(new Set(positive.rows.map((row) => row.tradeId))).toEqual(new Set(['qualified', 'later-rejected']));

    const combined = await log.getBotActionLogs({ positiveArb: true, qualified: true });
    expect(new Set(combined.rows.map((row) => row.tradeId))).toEqual(new Set(['qualified']));
  });

  it('filters before pagination and keeps combined qualification pages identical without gaps', async () => {
    const log = await import('./bot-action-log');
    const appendQualified = async (tradeId: string, marketId: string) => {
      await log.appendBotActionLog({ tradeId, trigger:'scan', marketId, marketTitle:tradeId, step:'detection', action:'Scan found arb', responseStatus:'passed' });
      await log.appendBotActionLog({ tradeId, trigger:'scan', marketId, marketTitle:tradeId, step:'safety-gate', action:'all gates passed', responseStatus:'passed', qualificationOutcome:'qualified' });
    };

    await appendQualified('qualified-older', 'm1');
    await appendQualified('qualified-newer', 'm2');
    await log.appendBotActionLog({ tradeId:'positive-rejected', trigger:'scan', marketId:'m3', marketTitle:'Positive rejected', step:'detection', action:'Scan found arb', responseStatus:'passed' });
    await log.appendBotActionLog({ tradeId:'positive-rejected', trigger:'scan', marketId:'m3', marketTitle:'Positive rejected', step:'preflight', action:'risk rejected', responseStatus:'failed', qualificationOutcome:'dead' });
    for (let index = 0; index < 4; index += 1) {
      await log.appendBotActionLog({ tradeId:`unclassified-${index}`, trigger:'scan', marketId:'excluded', marketTitle:'No arb', step:'criteria_check', action:'No Positive Arb', responseStatus:'failed', qualificationOutcome:'dead' });
    }

    const positiveFirstPage = await log.getBotActionLogs({ positiveArb: true, limit: 2 });
    expect(positiveFirstPage.rows).toHaveLength(2);
    expect(new Set(positiveFirstPage.rows.map((row) => row.tradeId))).toEqual(new Set(['positive-rejected']));
    expect(positiveFirstPage.nextCursor).not.toBeNull();
    const positiveSecondPage = await log.getBotActionLogs({ positiveArb: true, limit: 2, cursor: positiveFirstPage.nextCursor! });
    expect(new Set(positiveSecondPage.rows.map((row) => row.tradeId))).toEqual(new Set(['qualified-newer']));
    expect(positiveSecondPage.nextCursor).not.toBeNull();
    const positiveThirdPage = await log.getBotActionLogs({ positiveArb: true, limit: 2, cursor: positiveSecondPage.nextCursor! });
    expect(new Set(positiveThirdPage.rows.map((row) => row.tradeId))).toEqual(new Set(['qualified-older']));
    expect(positiveThirdPage.nextCursor).toBeNull();
    const positiveIds = [...positiveFirstPage.rows, ...positiveSecondPage.rows, ...positiveThirdPage.rows].map((row) => row.id);
    expect(new Set(positiveIds).size).toBe(positiveIds.length);
    expect(positiveIds).toHaveLength(6);

    const qualifiedFirstPage = await log.getBotActionLogs({ qualified: true, limit: 2 });
    const combinedFirstPage = await log.getBotActionLogs({ qualified: true, positiveArb: true, limit: 2 });
    expect(combinedFirstPage).toEqual(qualifiedFirstPage);
    expect(new Set(combinedFirstPage.rows.map((row) => row.id)).size).toBe(combinedFirstPage.rows.length);
    expect(combinedFirstPage.nextCursor).not.toBeNull();

    const qualifiedSecondPage = await log.getBotActionLogs({ qualified: true, limit: 2, cursor: qualifiedFirstPage.nextCursor! });
    const combinedSecondPage = await log.getBotActionLogs({ qualified: true, positiveArb: true, limit: 2, cursor: combinedFirstPage.nextCursor! });
    expect(combinedSecondPage).toEqual(qualifiedSecondPage);
    const combinedIds = [...combinedFirstPage.rows, ...combinedSecondPage.rows].map((row) => row.id);
    expect(new Set(combinedIds).size).toBe(combinedIds.length);
    expect(combinedIds).toHaveLength(4);
  });
});
