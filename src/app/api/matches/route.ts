import { NextRequest, NextResponse } from 'next/server';
import { clientSafeError } from '@/lib/error-handler';
import {
  getMatchedPairs,
  getSavedMarkets,
  queryMarketCatalog,
  type MarketCatalogRow,
  type MatchedPair,
} from '@/lib/persistence';
import {
  DEFAULT_MATCHER_OPTIONS,
  matchCrossPlatformMarkets,
  type MatcherOptions,
} from '@/lib/cross-platform-matcher';
import { buildUnsavedMarketMatches } from '@/lib/marketfinder-matches';
import { parseBoundedInteger } from '@/lib/request-query';
import { parseJsonObject } from '@/lib/request-json';

const MATCH_STATUSES = new Set<MatchedPair['status']>([
  'auto_queued',
  'pending_review',
  'approved',
  'rejected',
]);

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get('status');
    const limit = parseBoundedInteger(searchParams.get('limit'), 200, 1, 1000);
    const notSaved = searchParams.get('notSaved') === 'true';

    let status: MatchedPair['status'] | MatchedPair['status'][] | undefined;
    if (statusParam) {
      const statuses = statusParam.split(',');
      if (statuses.some(value => !MATCH_STATUSES.has(value as MatchedPair['status']))) {
        return NextResponse.json(
          { error: 'Invalid status. Use auto_queued, pending_review, approved, or rejected.' },
          { status: 400 },
        );
      }
      status = statuses.length === 1
        ? statuses[0] as MatchedPair['status']
        : statuses as MatchedPair['status'][];
    }

    const pairs = await getMatchedPairs(status, notSaved ? 5000 : limit);
    if (notSaved) {
      const loadCatalog = async (platform: 'kalshi' | 'polymarket'): Promise<MarketCatalogRow[]> => {
        const rows: MarketCatalogRow[] = [];
        let cursor: number | null = 0;
        do {
          const page = await queryMarketCatalog({ platform, includeStale: false, limit: 10000, cursor });
          rows.push(...page.rows);
          cursor = page.nextCursor;
        } while (cursor !== null);
        return rows;
      };
      const [savedMarkets, kalshiCatalog, polymarketCatalog] = await Promise.all([
        getSavedMarkets(),
        loadCatalog('kalshi'),
        loadCatalog('polymarket'),
      ]);
      const matches = buildUnsavedMarketMatches(
        pairs,
        savedMarkets,
        [...kalshiCatalog, ...polymarketCatalog],
      );
      return NextResponse.json({ matches: matches.slice(0, limit) });
    }
    return NextResponse.json({ pairs });
  } catch (err: unknown) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonObject(request);
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const body = parsed.body;
    if (body.action !== 'run') {
      return NextResponse.json({ error: 'Invalid action. Use "run".' }, { status: 400 });
    }

    const options: MatcherOptions = {};
    const percentageFields = ['candidateThreshold', 'autoQueueThreshold', 'reviewThreshold'] as const;
    for (const field of percentageFields) {
      const value = body[field];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        return NextResponse.json({ error: `${field} must be a finite number between 0 and 100.` }, { status: 400 });
      }
      options[field] = value;
    }

    const integerFields = [
      ['maxVerifications', 1, 5000],
      ['maxExpiryDays', 1, 3650],
    ] as const;
    for (const [field, min, max] of integerFields) {
      const value = body[field];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
        return NextResponse.json({ error: `${field} must be an integer between ${min} and ${max}.` }, { status: 400 });
      }
      options[field] = value;
    }

    const effectiveAutoQueue = options.autoQueueThreshold ?? DEFAULT_MATCHER_OPTIONS.autoQueueThreshold;
    const effectiveReview = options.reviewThreshold ?? DEFAULT_MATCHER_OPTIONS.reviewThreshold;
    if (effectiveAutoQueue < effectiveReview) {
      return NextResponse.json({ error: 'autoQueueThreshold must be greater than or equal to reviewThreshold.' }, { status: 400 });
    }

    const result = await matchCrossPlatformMarkets(options);
    return NextResponse.json({ result });
  } catch (err: unknown) {
    return NextResponse.json({ error: clientSafeError(err) }, { status: 500 });
  }
}
