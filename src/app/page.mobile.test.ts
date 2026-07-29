import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('scan controls mobile layout', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/app/page.tsx'), 'utf8');

  it('stacks the scan controls before the small breakpoint', () => {
    expect(source).toContain('flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:flex-wrap');
  });

  it('gives scan actions and the capital input a 44px touch target', () => {
    expect(source).toContain('flex min-h-11 items-center justify-center gap-2 px-5 py-2.5');
    expect(source).toContain('flex min-h-11 items-center justify-center gap-2 px-4 py-2.5');
    expect(source).toContain('className="h-11 w-24');
    expect(source).toContain('flex min-h-11 items-center justify-center gap-1.5 px-2.5 py-1.5');
  });

  it('keeps match-mode buttons touch friendly when the controls reflow', () => {
    expect(source).toContain('flex flex-col items-stretch gap-2 mb-4 sm:flex-row sm:items-center');
    expect((source.match(/min-h-11 px-3 py-1 rounded-md text-xs font-medium transition-colors/g) ?? []).length).toBe(2);
  });
});
