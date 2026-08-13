import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('standalone position valuer ledger parity', () => {
  it('delegates valuation and settlement to the canonical tested ledger writer', async () => {
    const source = await readFile(path.join(process.cwd(), 'scripts', 'position-valuer.ts'), 'utf8');
    expect(source).toContain("import { pollOpenBotPositions } from '../src/lib/bot-positions'");
    expect(source).toContain('await pollOpenBotPositions()');
    expect(source).not.toContain('UPDATE bot_positions');
    expect(source).not.toContain('calcPolymarketFee');
    expect(source).not.toContain('getClobBidPrices');
  });
});