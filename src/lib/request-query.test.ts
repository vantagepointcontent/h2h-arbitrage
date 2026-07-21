import { describe, expect, it } from 'vitest';
import { parseBoundedInteger } from './request-query';

describe('parseBoundedInteger', () => {
  it.each([
    [null, 30], ['', 30], ['15', 15], ['0', 1], ['999', 365], ['abc', 30], ['1.5', 30], ['-2', 30], ['999999999999999999999', 30],
  ])('parses %s safely', (value, expected) => {
    expect(parseBoundedInteger(value, 30, 1, 365)).toBe(expected);
  });
});
