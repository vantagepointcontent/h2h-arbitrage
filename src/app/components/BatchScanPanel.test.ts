import { describe, expect, it } from 'vitest';
import { parseBatchScanInput } from './BatchScanPanel';

const k1 = 'https://kalshi.com/markets/kxatp/mens-tournament-winner/kxatp-26montre';
const p1 = 'https://polymarket.com/event/atp-winner';
const k2 = 'https://kalshi.com/markets/kxkftour/korn-ferry-tour/kxkftour-pibcpbw26';
const p2 = 'https://polymarket.com/event/kft-winner';

describe('parseBatchScanInput', () => {
  it('pairs newline-separated links and accepts either platform order', () => {
    expect(parseBatchScanInput(`${k1}\n${p1}\n\n${p2}\n${k2}`)).toEqual({
      pairs: [
        { kalshiUrl: k1, polymarketUrl: p1 },
        { kalshiUrl: k2, polymarketUrl: p2 },
      ],
      errors: [],
    });
  });

  it('accepts comma-separated links', () => {
    expect(parseBatchScanInput(`${k1}, ${p1}, ${p2}, ${k2}`).pairs).toHaveLength(2);
  });

  it('reports an odd final link and same-platform pairs without shifting later pairs', () => {
    const parsed = parseBatchScanInput(`${k1}\n${k2}\n${p1}`);
    expect(parsed.pairs).toEqual([]);
    expect(parsed.errors).toEqual([
      'Pair 1 must contain one Kalshi link and one Polymarket link.',
      'Pair 2 is incomplete: add one more link.',
    ]);
  });
});
