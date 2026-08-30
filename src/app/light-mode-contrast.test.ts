import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8');
const logsPanel = readFileSync(`${process.cwd()}/src/app/components/LogsPanel.tsx`, 'utf8');
const dashboardPanel = readFileSync(`${process.cwd()}/src/app/components/DashboardPanel.tsx`, 'utf8');
const lifecycleStatsPanel = readFileSync(`${process.cwd()}/src/app/components/LifecycleStatsPanel.tsx`, 'utf8');
const calculationProvenance = readFileSync(`${process.cwd()}/src/app/components/CalculationProvenance.tsx`, 'utf8');
const lightTheme = css.slice(
  css.indexOf('[data-theme="light"] {'),
  css.indexOf('\n}', css.indexOf('[data-theme="light"] {')) + 2,
);

function token(name: string): string {
  const match = lightTheme.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  expect(match, `missing ${name} in the light theme`).toBeTruthy();
  return match![1];
}

function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const linear = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function composite(foreground: string, background: string, opacity: number): string {
  const fg = channels(foreground);
  const bg = channels(background);
  return `#${fg.map((value, index) => Math.round((value * opacity) + (bg[index] * (1 - opacity))).toString(16).padStart(2, '0')).join('')}`;
}

describe('UI-118 light-mode contrast', () => {
  const textSurfaces = [
    '--surface-workspace',
    '--surface-panel',
    '--surface-raised',
    '--surface-hover',
    '--table-header-surface',
    '--table-row-surface',
    '--table-row-selected',
  ];

  it.each(['--text-primary', '--text-secondary', '--text-muted', '--text-faint'])('%s meets WCAG AA on every text surface', (foreground) => {
    for (const background of textSurfaces) {
      expect(contrast(token(foreground), token(background)), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    '--status-positive',
    '--status-negative',
    '--status-warning',
    '--status-info',
    '--status-stale',
    '--status-blocked',
    '--platform-kalshi',
    '--platform-polymarket',
  ])('%s meets WCAG AA on its 10% tint badges', (foreground) => {
    for (const surface of ['--surface-workspace', '--surface-panel']) {
      const background = composite(token(foreground), token(surface), 0.1);
      expect(contrast(token(foreground), background), `${foreground} on a tinted ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps meaningful boundaries and disabled text readable', () => {
    for (const background of ['--surface-workspace', '--surface-panel', '--surface-raised']) {
      expect(contrast(token('--border-strong'), token(background)), `--border-strong on ${background}`).toBeGreaterThanOrEqual(3);
      const disabledText = composite(token('--text-secondary'), token(background), 0.9);
      expect(contrast(disabledText, token(background)), `disabled secondary text on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('maps legacy dark-palette text utilities to semantic light tokens', () => {
    for (const selector of [
      '.text-\\[\\#8A9BA8\\]',
      '.text-\\[\\#5E6875\\]',
      '.text-\\[\\#5DBE81\\]',
      '.text-\\[\\#ef4444\\]',
      '.text-\\[\\#facc15\\]',
      '.text-amber-400',
      '.text-red-400',
      '.text-blue-400',
      '.text-\\[\\#a78bfa\\]',
      '.text-purple-400',
    ]) {
      expect(css).toContain(`[data-theme="light"] ${selector}`);
    }
    expect(css).toContain('[data-theme="light"] :disabled');
  });

  it('uses theme-aware semantic colors for Logs summary values', () => {
    expect(logsPanel).not.toContain('style={{ color: color || "#FFFFFF" }}');
    expect(logsPanel).toContain('style={{ color: color || "var(--text-primary)" }}');
    expect(logsPanel).toContain('color="var(--status-positive)"');
    expect(logsPanel).toContain('color="var(--status-warning)"');
  });

  it('keeps populated Dashboard details readable in light mode', () => {
    expect(dashboardPanel).toContain('bg-[var(--status-positive)] text-white light-text-white');
    expect(lifecycleStatsPanel).not.toMatch(/color \?\? '#[0-9A-Fa-f]{6}'/);
    expect(calculationProvenance).not.toContain('className="block opacity-70"');
    expect(calculationProvenance).not.toContain('font-mono opacity-75');
  });
});
