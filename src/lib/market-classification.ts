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

export type MarketType = 'binary' | 'multi-outcome' | 'bracket';
export type BetType = 'moneyline' | 'spread' | 'total' | 'advance' | 'exact-score' | 'draw' | 'top-n' | 'special';
export type Domain = 'politics' | 'sports' | 'finance' | 'crypto' | 'entertainment' | 'world' | 'science' | 'weather';

export interface MarketClassification {
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

export function classifyKalshiMarket(km: {
  title?: string;
  ticker?: string;
  yes_sub_title?: string;
  custom_strike?: Record<string, string>;
}): MarketClassification {
  const title = km.title || km.ticker || '';
  const { betType, confidence: btConf } = detectBetType(title);
  const { domain, confidence: domConf } = detectDomain(title, km.custom_strike);
  const marketType = detectMarketType(title);

  return {
    marketType,
    betType,
    domain,
    confidence: Math.min(btConf, domConf),
  };
}

export function classifyPolymarketMarket(pm: {
  question?: string;
  groupItemTitle?: string;
  outcomes?: string;
  slug?: string;
}): MarketClassification {
  const title = pm.question || pm.slug || '';
  let outcomeCount: number | undefined;
  if (pm.outcomes) {
    try {
      outcomeCount = JSON.parse(pm.outcomes).length;
    } catch {
      // ignore parse error
    }
  }
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

// ─── Badge Colors ─────────────────────────────────────────────────

const BET_TYPE_COLORS: Record<BetType, string> = {
  moneyline: '#5DBE81',
  spread: '#facc15',
  total: '#a855f7',
  advance: '#3b82f6',
  'exact-score': '#ef4444',
  draw: '#8A9BA8',
  'top-n': '#f97316',
  special: '#5E6875',
};

const DOMAIN_COLORS: Record<Domain, string> = {
  politics: '#3b82f6',
  sports: '#5DBE81',
  finance: '#facc15',
  crypto: '#a855f7',
  entertainment: '#f97316',
  world: '#ef4444',
  science: '#3b82f6',
  weather: '#06b6d4',
};

export function getBetTypeColor(betType: BetType): string {
  return BET_TYPE_COLORS[betType] || '#5E6875';
}

export function getDomainColor(domain: Domain): string {
  return DOMAIN_COLORS[domain] || '#5E6875';
}