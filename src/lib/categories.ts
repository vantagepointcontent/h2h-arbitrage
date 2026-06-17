export const CATEGORIES = [
  'sports', 'politics', 'election', 'entertainment', 'economics',
  'crypto', 'science', 'technology', 'weather', 'international',
] as const;

export type CategoryName = typeof CATEGORIES[number];
