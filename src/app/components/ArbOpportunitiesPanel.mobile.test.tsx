import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ArbOpportunitiesPanel mobile layout', () => {
  it('keeps arb actions touch-sized and lets the header and drawer reflow on narrow screens', () => {
    const source = readFileSync(new URL('./ArbOpportunitiesPanel.tsx', import.meta.url), 'utf8');

    expect(source).toContain('flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4');
    expect(source).toContain('w-full text-[10px] text-[#5E6875] sm:ml-auto sm:w-auto');
    expect(source).toContain('inline-flex min-h-11 items-center gap-1 rounded');
    expect(source).toContain('min-h-11 px-3 py-2 rounded text-[10px] font-bold');
    expect(source).toContain('min-h-11 w-20 rounded');
    expect(source).toContain('hidden flex-1 cursor-default sm:block');
    expect(source).toContain('min-h-11 min-w-11 rounded p-2');
  });
});