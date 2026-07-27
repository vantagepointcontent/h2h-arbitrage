import { describe, expect, it } from 'vitest';
import { parseBoundedInteger, parseOptionalBoundedText } from './request-query';

describe('parseBoundedInteger', () => {
  it.each([
    [null, 30], ['', 30], ['15', 15], ['0', 1], ['999', 365], ['abc', 30], ['1.5', 30], ['-2', 30], ['999999999999999999999', 30],
  ])('parses %s safely', (value, expected) => {
    expect(parseBoundedInteger(value, 30, 1, 365)).toBe(expected);
  });

  it.each([
    [null, 200], ['250', 250], ['0', 1], ['1001', 1000], ['1.5', 200], ['-1', 200], ['Infinity', 200],
  ])('enforces the execution-history limit for %s', (value, expected) => {
    expect(parseBoundedInteger(value, 200, 1, 1000)).toBe(expected);
  });
});

describe('parseOptionalBoundedText', () => {
  it.each([
    [null, undefined], ['', undefined], ['   ', undefined], ['  Sports  ', 'Sports'], ['x'.repeat(200), 'x'.repeat(200)], ['x'.repeat(201), undefined],
  ])('normalizes optional bounded text %j', (value, expected) => {
    expect(parseOptionalBoundedText(value)).toBe(expected);
  });
});
