/**
 * Smart Market Categorization & Bet-Type Taxonomy
 *
 * Classifies prediction markets by:
 * 1. Market Type: binary, multi-outcome, bracket
 * 2. Bet Type: moneyline, spread, total, advance, exact-score, draw, top-n, special
 * 3. Domain: politics, sports, finance, crypto, entertainment, world, science, weather
 *
 * Rule-based classification using title keywords + market structure.
 */

// ─── Types ────────────────────────────────────────────────────────

export type BetType = 'moneyline' | 'spread' | 'total' | 'advance' | 'exact-score' | 'draw' | 'top-n' | 'special';
type MarketType = 'binary' | 'multi-outcome' | 'bracket';
type Domain = 'politics' | 'sports' | 'finance' | 'crypto' | 'entertainment' | 'world' | 'science' | 'weather';

interface MarketClassification {
  marketType: MarketType;
  betType: BetType;
  domain: Domain;
  confidence: number; // 0-1
}

// ─── Bet Type Detection ───────────────────────────────────────────

const BET_TYPE_PATTERNS: { type: BetType; regex: RegExp }[] = [
  { type: 'exact-score', regex: /exact\s*score|correct\s*score/i },
  { type: 'top-n', regex: /top\s*[3-9]|\btop\s+\d|finish\s+in\s+top|podium/i },
  { type: 'advance', regex: /advance|next\s+round|progress/i },
  { type: 'spread', regex: /spread|cover|handicap/i },
  { type: 'total', regex: /\bover\b|\bunder\b/i },
  { type: 'draw', regex: /\bdraw\b|\btie\b/i },
  { type: 'moneyline', regex: /\bwin\b|\bwinner\b|\bchampion\b|will\s+\w+\s+win/i },
];

function detectBetType(title: string): { betType: BetType; confidence: number } {
  for (const { type, regex } of BET_TYPE_PATTERNS) {
    if (regex.test(title)) {
      return { betType: type, confidence: 0.85 };
    }
  }
  return { betType: 'special', confidence: 0.3 };
}

// ─── Domain Detection ──────────────────────────────────────────────

const DOMAIN_PATTERNS: { domain: Domain; regex: RegExp }[] = [
  { domain: 'politics', regex: /election|president|congress|senate|house|governor|\bparty\b|democratic|republican|trump|biden|political|primary|nominee|cabinet/i },
  { domain: 'sports', regex: /match|game|championship|tournament|\bteam\b|\bvs\b|\bcup\b|league|\bNFL\b|\bNBA\b|\bMLB\b|\bNHL\b|soccer|football|basketball|baseball|hockey|tennis|golf|world\s+cup|super\s+bowl|playoff|penalty|corner|kickoff|pitch|matchup|seed|bracket/i },
  { domain: 'finance', regex: /stock|price|\bIPO\b|\bfed\b|rate|\bGDP\b|inflation|economic|index|earnings|close\s+above|close\s+below|s&p|nasdaq|dow|treasury|yield|recession|unemployment|jobless|cpi|\bFOMC\b/i },
  { domain: 'crypto', regex: /bitcoin|ethereum|crypto|\bBTC\b|\bETH\b|token|blockchain|solana|defi|nft|altcoin|stablecoin/i },
  { domain: 'entertainment', regex: /oscar|award|grammy|movie|album|celebrity|nobel|song|\bshow\b|emmy|golden\s+glob|cannes|festival|box\s+office|streaming|netflix|spotify|billboard/i },
  { domain: 'world', regex: /war|conflict|ceasefire|treaty|\bcountry\b|nation|geopolitic|invasion|sanction|nato|eu\b|ukraine|russia|china|israel|gaza|hamas|hezbollah|houthi|iran|taiwan|korea|nuclear/i },
  { domain: 'weather', regex: /temperature|snow|rain|hurricane|weather|fahrenheit|celsius|blizzard|heatwave|tornado|flood|drought|storm|wind|degrees/i },
  { domain: 'science', regex: /space|launch|\bMars\b|climate|research|discovery|moon|orbit|rocket|spacex|nasa|telescope|particle|quantum|gene|crispr|fusion|supercomputer|ai\b|gpt|llm/i },
];

function detectDomain(title: string, customStrike?: Record<string, string>): { domain: Domain; confidence: number } {
  // Check custom_strike for political_party indicator
  if (customStrike && 'political_party' in customStrike) {
    return { domain: 'politics', confidence: 0.95 };
  }

  for (const { domain, regex } of DOMAIN_PATTERNS) {
    if (regex.test(title)) {
      return { domain, confidence: 0.8 };
    }
  }

  return { domain: 'world', confidence: 0.3 };
}

// ─── Market Type Detection ────────────────────────────────────────

function detectMarketType(title: string, outcomeCount?: number): MarketType {
  if (/bracket|tournament/i.test(title)) return 'bracket';
  if (outcomeCount && outcomeCount > 2) return 'multi-outcome';
  return 'binary';
}

// ─── Public API ───────────────────────────────────────────────────

export function classifyMarket(
  title: string,
  outcomeCount?: number,
  groupItemTitle?: string,
): MarketClassification {
  const { betType, confidence: btConf } = detectBetType(title);
  const { domain, confidence: domConf } = detectDomain(title);
  const marketType = detectMarketType(title, outcomeCount);

  return {
    marketType,
    betType,
    domain,
    confidence: Math.min(btConf, domConf),
  };
}

