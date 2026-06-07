import { normalizeName } from './matcher';

// ─── Types ───────────────────────────────────────────────────────────────

export interface CouplingCandidate {
  kalshiTicker: string;
  kalshiTitle: string;
  pmConditionId: string;
  pmTitle: string;
  confidence: number; // 0-100
  scoreBreakdown: {
    keywordSimilarity: number;   // 0-1
    expiryProximity: number;     // 0-1
    categoryOverlap: number;     // 0-1
  };
}

export interface CouplingRejection {
  kalshiTicker: string;
  pmConditionId: string;
  rejectedAt: string;
  reason?: string;
}

// ─── Scoring constants ───────────────────────────────────────────────────

// Weight factors for composite score
const WEIGHT_KEYWORD = 0.50;
const WEIGHT_EXPIRY = 0.25;
const WEIGHT_CATEGORY = 0.25;

// Minimum confidence threshold to show a suggestion
const MIN_CONFIDENCE = 30;

// Maximum number of suggestions to return
const MAX_SUGGESTIONS = 5;

// Rejection cooldown period (24 hours in ms)
const REJECTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ─── Keyword extraction ──────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'or', 'vs', 'at', 'in', 'on', 'by', 'to', 'of', 'for',
  'a', 'an', 'will', 'be', 'has', 'is', 'are', 'was', 'were', 'that',
  'this', 'these', 'those', 'it', 'not', 'but', 'with', 'from',
]);

/** Extract meaningful keywords from a title */
export function extractKeywords(title: string): string[] {
  return normalizeName(title)
    .split(' ')
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
}

// ─── Similarity functions ────────────────────────────────────────────────

/**
 * Compute keyword overlap score between two titles.
 * Uses Jaccard-like similarity on significant keywords.
 */
function keywordSimilarity(a: string, b: string): number {
  const kwA = extractKeywords(a);
  const kwB = extractKeywords(b);
  const setA = new Set(kwA);
  const setB = new Set(kwB);

  if (setA.size === 0 && setB.size === 0) return 0;
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const w of setA) {
    if (setB.has(w)) shared++;
  }
  const union = new Set([...kwA, ...kwB]).size;
  return union > 0 ? shared / union : 0;
}

/**
 * Compute expiry proximity score.
 * Returns 1 if same expiry, decaying based on temporal distance.
 */
function expiryProximity(expA: string | null | undefined, expB: string | null | undefined): number {
  if (!expA || !expB) return 0.5; // Neutral if one missing

  const dateA = new Date(expA).getTime();
  const dateB = new Date(expB).getTime();
  const diffDays = Math.abs(dateA - dateB) / (1000 * 60 * 60 * 24);

  if (diffDays === 0) return 1;
  // Exponential decay: 1 day apart = 0.8, 7 days = 0.4, 30+ days ≈ 0
  return Math.exp(-diffDays / 7);
}

/**
 * Compute category overlap score.
 * Same category = 1, different = 0.
 */
function categoryOverlap(catA: string | undefined, catB: string | undefined): number {
  if (!catA || !catB) return 0.5;
  return catA.toLowerCase() === catB.toLowerCase() ? 1 : 0;
}

// ─── Coupling engine ──────────────────────────────────────────────────────

export interface UnmatchedMarket {
  platform: 'kalshi' | 'polymarket';
  title: string;
  identifier: string; // ticker for kalshi, conditionId for polymarket
  expiryDate?: string;
  category?: string;
}

/**
 * Generate coupling suggestions for unmatched markets.
 * Scores all pairwise combinations and returns top candidates.
 */
export function suggestCouplings(
  kalshiMarkets: UnmatchedMarket[],
  pmMarkets: UnmatchedMarket[],
  rejections: CouplingRejection[] = [],
): CouplingCandidate[] {
  const now = Date.now();
  const activeRejections = rejections.filter(r => {
    const age = now - new Date(r.rejectedAt).getTime();
    return age < REJECTION_COOLDOWN_MS;
  });

  const candidates: CouplingCandidate[] = [];

  for (const km of kalshiMarkets) {
    for (const pm of pmMarkets) {
      // Skip recently rejected pairs
      const wasRejected = activeRejections.some(
        r => r.kalshiTicker === km.identifier && r.pmConditionId === pm.identifier,
      );
      if (wasRejected) continue;

      const kwScore = keywordSimilarity(km.title, pm.title);
      const expScore = expiryProximity(km.expiryDate, pm.expiryDate);
      const catScore = categoryOverlap(km.category, pm.category);

      // Composite score with weighted average
      const rawScore =
        kwScore * WEIGHT_KEYWORD +
        expScore * WEIGHT_EXPIRY +
        catScore * WEIGHT_CATEGORY;

      // Convert to 0-100 confidence scale
      const confidence = Math.round(rawScore * 100);

      if (confidence >= MIN_CONFIDENCE) {
        candidates.push({
          kalshiTicker: km.identifier,
          kalshiTitle: km.title,
          pmConditionId: pm.identifier,
          pmTitle: pm.title,
          confidence,
          scoreBreakdown: {
            keywordSimilarity: Math.round(kwScore * 100) / 100,
            expiryProximity: Math.round(expScore * 100) / 100,
            categoryOverlap: Math.round(catScore * 100) / 100,
          },
        });
      }
    }
  }

  // Sort by confidence descending, return top N
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates.slice(0, MAX_SUGGESTIONS);
}

/**
 * Check if a pair was recently rejected.
 */
export function isRecentlyRejected(
  kalshiTicker: string,
  pmConditionId: string,
  rejections: CouplingRejection[],
): boolean {
  const now = Date.now();
  return rejections.some(
    r => r.kalshiTicker === kalshiTicker &&
         r.pmConditionId === pmConditionId &&
         (now - new Date(r.rejectedAt).getTime()) < REJECTION_COOLDOWN_MS,
  );
}

/**
 * Get the penalty factor for a previously rejected pair.
 * Returns a multiplier (0-1) that decreases suggestion score based on rejection history.
 * More rejections = stronger penalty.
 */
export function getRejectionPenalty(
  kalshiTicker: string,
  pmConditionId: string,
  rejections: CouplingRejection[],
): number {
  const rejectionCount = rejections.filter(
    r => r.kalshiTicker === kalshiTicker && r.pmConditionId === pmConditionId,
  ).length;

  // Each rejection reduces confidence by 10%, minimum 0.1
  return Math.max(0.1, 1 - rejectionCount * 0.1);
}
