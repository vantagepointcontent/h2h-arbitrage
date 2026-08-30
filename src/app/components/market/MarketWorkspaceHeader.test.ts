import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const header = readFileSync(new URL('./MarketWorkspaceHeader.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../../page.tsx', import.meta.url), 'utf8');

describe('UI-041 market workspace behavior', () => {
  it('explains all decision metrics with plain-English tooltips', () => {
    expect(header).toContain('Highest net ROI % across all matched outcomes');
    expect(header).toContain('Highest expected dollar profit across all matched outcomes');
    expect(header).toContain('Maximum dollar stake that can be filled');
    expect(header).toContain("priceAgeMetric('Kalshi'");
    expect(header).toContain("priceAgeMetric('Polymarket'");
    expect(header).toContain('title={description} aria-label={description}');
  });

  it('exposes Couplings as a tab action rather than a menu action', () => {
    expect(header).toContain('["couplings","Couplings"]');
    expect(header).toContain('id === "couplings" ? props.onCouplings()');
    expect(header).not.toContain("'Couplings',props.onCouplings");
  });

  it('defaults to prices and renders an explicit zero-opportunity state', () => {
    expect(page).toContain('useState<MarketWorkspaceTab>("prices")');
    expect(page).toContain('matched outcomes but 0 positive arbs at current executable prices');
  });
});
