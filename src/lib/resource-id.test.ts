import { describe, expect, it } from 'vitest';
import { parseResourceId } from './resource-id';

describe('parseResourceId', () => {
  it.each([[null, null], ['', null], ['  ', null], ['x'.repeat(201), null], [' market-1 ', 'market-1']])('parses %s', (value, expected) => {
    expect(parseResourceId(value)).toBe(expected);
  });
});
