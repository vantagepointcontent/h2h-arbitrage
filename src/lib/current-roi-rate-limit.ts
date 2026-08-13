import { CurrentPriceRateLimiter, type CurrentPriceRateLimitResult } from './current-price-rate-limit';

const currentRoiRateLimiter = new CurrentPriceRateLimiter();

export function consumeCurrentRoiGlobalRateLimit(): CurrentPriceRateLimitResult {
  return currentRoiRateLimiter.consume('current-roi');
}

export function resetCurrentRoiRateLimitForTests(): void {
  currentRoiRateLimiter.reset();
}
