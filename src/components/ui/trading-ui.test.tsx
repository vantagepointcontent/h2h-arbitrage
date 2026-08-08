// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Button } from './button';
import { DataTable } from './data-table';
import { EmptyState } from './empty-state';
import { Metric } from './metric';
import { SegmentedControl } from './segmented-control';
import { Skeleton } from './skeleton';
import { StatusBadge } from './status-badge';

describe('EdgeFinder trading UI foundation', () => {
  it('defines semantic trading tokens and density primitives for both themes', () => {
    const css = readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8');
    for (const token of [
      '--surface-workspace', '--surface-panel', '--surface-raised', '--text-primary',
      '--text-secondary', '--border-subtle', '--status-positive', '--status-negative',
      '--status-warning', '--status-info', '--status-stale', '--status-blocked',
      '--platform-kalshi', '--platform-polymarket', '--density-row-compact',
      '--density-row-standard', '--density-row-interactive',
    ]) expect(css).toContain(token);
    expect(css.match(/--status-positive:/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('renders reusable states and tabular trading metrics', () => {
    render(<>
      <Button loading>Refresh</Button>
      <SegmentedControl ariaLabel="View" value="table" options={[{ value: 'table', label: 'Table' }, { value: 'grid', label: 'Grid' }]} onChange={() => {}} />
      <StatusBadge tone="stale">Stale</StatusBadge>
      <Metric label="Net ROI" value="2.41%" tone="positive" />
      <DataTable aria-label="Prices"><tbody><tr><td>52.4¢</td></tr></tbody></DataTable>
      <EmptyState title="No positions" description="Open positions appear here." />
      <Skeleton aria-label="Loading metrics" />
    </>);

    expect(screen.getByRole('button', { name: /Refresh/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('group', { name: 'View' })).toBeTruthy();
    expect(screen.getByText('2.41%').className).toContain('tabular-nums');
    expect(screen.getByRole('table', { name: 'Prices' }).className).toContain('tabular-nums');
    expect(screen.getByText('No positions')).toBeTruthy();
    expect(screen.getByLabelText('Loading metrics')).toBeTruthy();
  });
});
