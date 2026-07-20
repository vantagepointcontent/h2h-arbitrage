import { describe, expect, it } from 'vitest';
import {
  detectPlatformFromUrl,
  getEnabledPlatforms,
  getPlatform,
} from './registry';

describe('platform registry', () => {
  it('registers existing and future platforms without enabling stubs', () => {
    expect(getPlatform('kalshi').enabled).toBe(true);
    expect(getPlatform('polymarket').enabled).toBe(true);
    expect(getPlatform('opinion').enabled).toBe(false);
    expect(getPlatform('ibkr').enabled).toBe(false);
    expect(getEnabledPlatforms().map(p => p.id)).toEqual(['polymarket', 'kalshi']);
  });

  it('detects registered market URLs', () => {
    expect(detectPlatformFromUrl('https://kalshi.com/markets/KXTEST')).toBe('kalshi');
    expect(detectPlatformFromUrl('https://polymarket.com/event/example')).toBe('polymarket');
    expect(detectPlatformFromUrl('https://app.opinion.trade/market/1')).toBe('opinion');
    expect(detectPlatformFromUrl('not-a-market-link')).toBeNull();
  });
});
