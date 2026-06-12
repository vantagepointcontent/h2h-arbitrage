import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Shared mock data ──────────────────────────────────────────────

const MOCK_KALSHI_MARKETS = [
  {
    ticker: "KX-DEMO-26JUN01",
    event_ticker: "KX-DEMO",
    title: "Will X happen?",
    yes_bid_dollars: "0.44",
    yes_ask_dollars: "0.45",
    no_bid_dollars: "0.54",
    no_ask_dollars: "0.55",
    last_price_dollars: "0.50",
    volume_24h_fp: "1000",
    yes_ask_depth: "5000",
    no_ask_depth: "5000",
  },
];

const MOCK_PM_EVENT = {
  id: "evt-123",
  title: "Demo Event",
  slug: "demo-event",
  description: "A test event",
  active: true,
  closed: false,
  markets: [
    {
      id: "m1",
      conditionId: "cond-abc-123",
      question: "Will X happen?",
      slug: "demo-event-x",
      outcomes: "[\"Yes\",\"No\"]",
      outcomePrices: "[\"0.58\",\"0.42\"]",
      bestBid: 0.57,
      bestAsk: 0.59,
      lastTradePrice: 0.58,
      groupItemTitle: "X",
      volume: "5000",
      liquidity: "10000",
      liquidityNum: 10000,
      active: true,
      closed: false,
    },
  ],
  endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

const VALID_KALSHI_URL = "https://kalshi.com/markets/KX-DEMO/demo/kx-demo-26jun01";
const VALID_POLYMARKET_URL = "https://polymarket.com/event/demo-event";
const INVALID_KALSHI_URL = "not-a-valid-url";
const INVALID_POLYMARKET_URL = "also-invalid";

// ─── Module mocks ──────────────────────────────────────────────────

vi.mock("@/lib/kalshi", () => ({
  extractKalshiEventTicker: vi.fn((url: string) => {
    const match = url.match(/kalshi\.com\/markets\/([^\/]+)/);
    if (!match) return null;
    const firstSegment = match[1].toUpperCase();
    const deeper = url.match(/kalshi\.com\/markets\/[^\/]+\/[^\/]+\/([A-Z0-9-]+)/i);
    if (deeper) {
      const deepTicker = deeper[1].toUpperCase();
      if (deepTicker.length > firstSegment.length) return deepTicker;
    }
    return firstSegment;
  }),
  fetchKalshiEventMarkets: vi.fn(async () => MOCK_KALSHI_MARKETS),
  fetchKalshiSeriesMarkets: vi.fn(async () => MOCK_KALSHI_MARKETS),
}));

vi.mock("@/lib/polymarket", () => ({
  extractPolymarketSlug: vi.fn((url: string) => {
    const match = url.match(/polymarket\.com\/(?:event|(?:sports(?:\/[^/]+)+))\/([^\/\s\?\#]+)/);
    return match ? match[1] : null;
  }),
  fetchPolymarketEvent: vi.fn(async () => MOCK_PM_EVENT),
}));

vi.mock("@/lib/polymarket-clob", () => ({
  fetchClobMarkets: vi.fn(async () => new Map()),
  getClobPrices: vi.fn(async () => null),
}));

vi.mock("@/lib/matcher", () => ({
  matchOutcomes: vi.fn(() => [
    {
      artist: "X",
      kalshi: {
        ticker: "KX-DEMO-26JUN01",
        event_ticker: "KX-DEMO",
        title: "Will X happen?",
        yes_bid_dollars: "0.44",
        yes_ask_dollars: "0.45",
        no_bid_dollars: "0.54",
        no_ask_dollars: "0.55",
        last_price_dollars: "0.50",
        volume_24h_fp: "1000",
        yesAskDepth: "5000",
        noAskDepth: "5000",
        yesAsk: 0.45,
        noAsk: 0.55,
        yesBid: 0.44,
        noBid: 0.54,
      },
      polymarket: {
        marketId: "m1",
        conditionId: "cond-abc-123",
        question: "Will X happen?",
        slug: "demo-event-x",
        yesPrice: 0.58,
        noPrice: 0.42,
        bestBid: 0.57,
        bestAsk: 0.59,
        lastTradePrice: 0.58,
        groupItemTitle: "X",
        askDepth: 10000,
        noAskDepth: 10000,
      },
    },
  ]),
  calculateArbitrageMax: vi.fn(() => ({
    strategy: "Buy YES Kalshi + NO PM",
    kalshiStake: 95,
    pmStake: 42,
    expectedProfit: 8.05,
    roiPct: 8.5,
    maxCapital: 10000,
    buyPlatform: "kalshi",
    buyPrice: 0.45,
    sellPlatform: "polymarket",
    sellPrice: 0.58,
  })),
  parseDepth: vi.fn((val: string | null) => {
    if (!val) return 0;
    if (val === "Infinity") return Infinity;
    const num = parseFloat(val);
    if (isNaN(num)) return 0;
    if (val.toUpperCase().endsWith("K")) return num * 1000;
    if (val.toUpperCase().endsWith("M")) return num * 1_000_000;
    if (val.toUpperCase().endsWith("B")) return num * 1_000_000_000;
    return num;
  }),
  computeApy: vi.fn((roiPct: number, expiryDate: string | null) => {
    if (!expiryDate) return 0;
    const days = (new Date(expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (days <= 0) return 0;
    return roiPct * (365 / days);
  }),
  applyManualMatches: vi.fn((outcomes) => outcomes),
}));

vi.mock("@/lib/manual-matches", () => ({
  getManualMatches: vi.fn(async () => []),
}));

vi.mock("@/lib/persistence", () => ({
  getSavedMarkets: vi.fn(async () => []),
  addSavedMarket: vi.fn(async (m) => ({
    id: "market-1",
    kalshiUrl: m.kalshiUrl,
    polymarketUrl: m.polymarketUrl,
    eventTitle: m.eventTitle,
    category: m.category,
    expiryDate: m.expiryDate,
    createdAt: new Date().toISOString(),
    lastScanResult: null,
  })),
  updateSavedMarketScanResult: vi.fn(async () => {}),
  appendScanHistory: vi.fn(async () => {}),
  deleteSavedMarket: vi.fn(async () => true),
  updateSavedMarket: vi.fn(async () => true),
  saveScanResult: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("@/lib/scan-frequency", () => ({
  loadScanConfig: vi.fn(() => ({
    tiers: [
      { label: "Hot", maxDays: 7, intervalMs: 5 * 60 * 1000 },
      { label: "Warm", maxDays: 30, intervalMs: 15 * 60 * 1000 },
      { label: "Cold", maxDays: 365, intervalMs: 60 * 60 * 1000 },
    ],
    lastUpdated: new Date().toISOString(),
  })),
  saveScanConfig: vi.fn(() => {}),
  getScanPlanSummary: vi.fn(() => ({
    hot: 0,
    warm: 0,
    cold: 0,
    total: 0,
    dueNow: { hot: 0, warm: 0, cold: 0 },
  })),
  sortMarketsByScanPriority: vi.fn((markets) => markets),
  isMarketDueForScan: vi.fn(() => true),
}));

vi.mock("@/lib/rate-limiter", () => ({
  rateLimiters: {
    kalshi: { execute: vi.fn((fn) => fn()) },
    gamma: { execute: vi.fn((fn) => fn()) },
    clob: { execute: vi.fn((fn) => fn()) },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    trackError: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import mocks so we can reset/reconfigure them
import {
  fetchKalshiEventMarkets,
  fetchKalshiSeriesMarkets,
  extractKalshiEventTicker,
} from "@/lib/kalshi";
import { fetchPolymarketEvent, extractPolymarketSlug } from "@/lib/polymarket";
import { fetchClobMarkets, getClobPrices } from "@/lib/polymarket-clob";
import {
  matchOutcomes,
  calculateArbitrageMax,
  parseDepth,
  computeApy,
  applyManualMatches,
} from "@/lib/matcher";
import { getManualMatches } from "@/lib/manual-matches";
import {
  getSavedMarkets,
  addSavedMarket,
  deleteSavedMarket,
  updateSavedMarket,
  saveScanResult,
  updateSavedMarketScanResult,
  appendScanHistory,
} from "@/lib/persistence";
import {
  loadScanConfig,
  saveScanConfig,
  getScanPlanSummary,
} from "@/lib/scan-frequency";

// Import route handlers AFTER mocks are registered
import { POST as scanPost } from "../src/app/api/scan/route";
import { POST as refreshPost } from "../src/app/api/refresh/route";
import {
  GET as savedGet,
  POST as savedPost,
  DELETE as savedDelete,
} from "../src/app/api/saved-markets/route";
import {
  GET as configGet,
  POST as configPost,
} from "../src/app/api/scan-config/route";

// ─── Helper: build a minimal NextRequest-like object ───────────────

function makeRequest(
  body: unknown,
  url = "http://localhost:3000/api/test",
): any {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(url = "http://localhost:3000/api/test"): any {
  return new Request(url, { method: "GET" });
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("/api/scan (POST)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with outcomes for valid URLs", async () => {
    (fetchKalshiEventMarkets as any).mockResolvedValue(MOCK_KALSHI_MARKETS);
    (fetchPolymarketEvent as any).mockResolvedValue(MOCK_PM_EVENT);
    (fetchClobMarkets as any).mockResolvedValue(new Map());
    (getClobPrices as any).mockResolvedValue(null);

    const req = makeRequest({
      kalshiUrl: VALID_KALSHI_URL,
      polymarketUrl: VALID_POLYMARKET_URL,
    });
    const res = await scanPost(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eventTitle).toBe("Demo Event");
    expect(body.kalshiEventTicker).toBeTruthy();
    expect(body.pmEventSlug).toBe("demo-event");
    expect(Array.isArray(body.outcomes)).toBe(true);
    expect(body.kalshiCount).toBeGreaterThanOrEqual(0);
    expect(body.pmCount).toBeGreaterThanOrEqual(0);
    expect(body.matchedCount).toBeGreaterThanOrEqual(0);
    expect(body.unmatchedKalshi).toBeDefined();
    expect(body.unmatchedPolymarket).toBeDefined();
    expect(body._ts).toBeDefined();
  });

  it("returns 400 for invalid Kalshi URL", async () => {
    const req = makeRequest({
      kalshiUrl: INVALID_KALSHI_URL,
      polymarketUrl: VALID_POLYMARKET_URL,
    });
    const res = await scanPost(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid Kalshi URL");
  });

  it("returns 400 for invalid Polymarket URL", async () => {
    // Override extractKalshiEventTicker to return a valid ticker
    (extractKalshiEventTicker as any).mockReturnValue("KX-DEMO");

    const req = makeRequest({
      kalshiUrl: VALID_KALSHI_URL,
      polymarketUrl: INVALID_POLYMARKET_URL,
    });
    const res = await scanPost(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid Polymarket URL");
  });

  it("returns 504 when Kalshi API times out", async () => {
    const timeoutErr = new Error(
      "Kalshi event markets timed out after 15000ms",
    );
    (fetchKalshiEventMarkets as any).mockRejectedValue(timeoutErr);
    (fetchKalshiSeriesMarkets as any).mockRejectedValue(
      new Error("Kalshi series markets timed out after 15000ms"),
    );

    const req = makeRequest({
      kalshiUrl: VALID_KALSHI_URL,
      polymarketUrl: VALID_POLYMARKET_URL,
    });
    const res = await scanPost(req);

    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error).toContain("timed out");
  });

  it("returns 504 when Polymarket API times out", async () => {
    (fetchKalshiEventMarkets as any).mockResolvedValue(MOCK_KALSHI_MARKETS);
    const timeoutErr = new Error(
      "Polymarket event timed out after 15000ms",
    );
    (fetchPolymarketEvent as any).mockRejectedValue(timeoutErr);

    const req = makeRequest({
      kalshiUrl: VALID_KALSHI_URL,
      polymarketUrl: VALID_POLYMARKET_URL,
    });
    const res = await scanPost(req);

    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error).toContain("timed out");
  });

  it("returns 404 when Polymarket event not found", async () => {
    (fetchKalshiEventMarkets as any).mockResolvedValue(MOCK_KALSHI_MARKETS);
    (fetchPolymarketEvent as any).mockResolvedValue(null);

    const req = makeRequest({
      kalshiUrl: VALID_KALSHI_URL,
      polymarketUrl: VALID_POLYMARKET_URL,
    });
    const res = await scanPost(req);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/api/scan", {
      method: "POST",
      body: "not-json",
    });
    // Force json parsing failure
    Object.defineProperty(req, "json", {
      value: async () => {
        throw new SyntaxError("Unexpected token");
      },
      writable: false,
    });

    const res = await scanPost(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON body");
  });
});

describe("/api/refresh (POST)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with scan summary for valid URLs", async () => {
    (fetchKalshiEventMarkets as any).mockResolvedValue(MOCK_KALSHI_MARKETS);
    (fetchPolymarketEvent as any).mockResolvedValue(MOCK_PM_EVENT);
    (fetchClobMarkets as any).mockResolvedValue(new Map());

    const req = makeRequest({
      kalshiUrl: VALID_KALSHI_URL,
      polymarketUrl: VALID_POLYMARKET_URL,
    });
    const res = await refreshPost(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eventTitle).toBe("Demo Event");
    expect(body.pmEventSlug).toBe("demo-event");
    expect(body.kalshiCount).toBeGreaterThanOrEqual(0);
    expect(body.pmCount).toBeGreaterThanOrEqual(0);
    expect(body.matchedCount).toBeGreaterThanOrEqual(0);
    expect(body.bestRoiPct).toBeDefined();
    expect(body.bestProfit).toBeDefined();
    expect(body.strategy).toBeDefined();
    expect(body.allArbs).toBeDefined();
    expect(body.scannedAt).toBeDefined();
    expect(body._ts).toBeDefined();
  });

  it("returns 400 for invalid Kalshi URL", async () => {
    (extractKalshiEventTicker as any).mockReturnValueOnce(null);
    const req = makeRequest({
      kalshiUrl: INVALID_KALSHI_URL,
      polymarketUrl: VALID_POLYMARKET_URL,
    });
    const res = await refreshPost(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid Kalshi URL");
  });

  it("returns 400 for invalid Polymarket URL", async () => {
    (extractKalshiEventTicker as any).mockReturnValue("KX-DEMO");

    const req = makeRequest({
      kalshiUrl: VALID_KALSHI_URL,
      polymarketUrl: INVALID_POLYMARKET_URL,
    });
    const res = await refreshPost(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid Polymarket URL");
  });

  it("returns 504 on timeout", async () => {
    const timeoutErr = new Error(
      "Kalshi event markets timed out after 15000ms",
    );
    (fetchKalshiEventMarkets as any).mockRejectedValue(timeoutErr);
    (fetchKalshiSeriesMarkets as any).mockRejectedValue(timeoutErr);

    const req = makeRequest({
      kalshiUrl: VALID_KALSHI_URL,
      polymarketUrl: VALID_POLYMARKET_URL,
    });
    const res = await refreshPost(req);

    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error).toContain("timed out");
  });

  it("returns 404 when Polymarket event not found", async () => {
    (fetchKalshiEventMarkets as any).mockResolvedValue(MOCK_KALSHI_MARKETS);
    (fetchPolymarketEvent as any).mockResolvedValue(null);

    const req = makeRequest({
      kalshiUrl: VALID_KALSHI_URL,
      polymarketUrl: VALID_POLYMARKET_URL,
    });
    const res = await refreshPost(req);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/api/refresh", {
      method: "POST",
      body: "bad-body",
    });
    Object.defineProperty(req, "json", {
      value: async () => {
        throw new SyntaxError("Unexpected token");
      },
      writable: false,
    });

    const res = await refreshPost(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON body");
  });
});

describe("/api/saved-markets", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET — list saved markets", () => {
    it("returns 200 with markets array", async () => {
      const mockMarkets = [
        {
          id: "m1",
          kalshiUrl: "https://kalshi.com/markets/A/a/b",
          polymarketUrl: "https://polymarket.com/event/x",
          eventTitle: "Test Market",
          createdAt: "2025-01-01T00:00:00Z",
        },
      ];
      (getSavedMarkets as any).mockResolvedValue(mockMarkets);

      const res = await savedGet();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.markets).toEqual(mockMarkets);
    });

    it("returns empty array when no markets saved", async () => {
      (getSavedMarkets as any).mockResolvedValue([]);

      const res = await savedGet();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.markets).toEqual([]);
    });
  });

  describe("POST — create saved market", () => {
    it("creates market and returns 201", async () => {
      const mockCreated = {
        id: "market-1",
        kalshiUrl: VALID_KALSHI_URL,
        polymarketUrl: VALID_POLYMARKET_URL,
        eventTitle: "New Market",
        createdAt: expect.any(String),
      };
      (addSavedMarket as any).mockResolvedValue(mockCreated);

      const req = makeRequest({
        kalshiUrl: VALID_KALSHI_URL,
        polymarketUrl: VALID_POLYMARKET_URL,
        eventTitle: "New Market",
      });
      const res = await savedPost(req);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.market.id).toBe("market-1");
      expect(body.market.kalshiUrl).toBe(VALID_KALSHI_URL);
      expect(body.market.polymarketUrl).toBe(VALID_POLYMARKET_URL);
    });

    it("returns 400 when kalshiUrl is missing", async () => {
      const req = makeRequest({
        polymarketUrl: VALID_POLYMARKET_URL,
      });
      const res = await savedPost(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Missing kalshiUrl");
    });

    it("returns 400 when polymarketUrl is missing", async () => {
      const req = makeRequest({
        kalshiUrl: VALID_KALSHI_URL,
      });
      const res = await savedPost(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Missing");
    });

    it("persists scanResult if provided", async () => {
      (addSavedMarket as any).mockResolvedValue({
        id: "market-1",
        kalshiUrl: VALID_KALSHI_URL,
        polymarketUrl: VALID_POLYMARKET_URL,
        eventTitle: "With Scan Result",
        createdAt: "2025-01-01T00:00:00Z",
      });
      (saveScanResult as any).mockResolvedValue({ id: 1 });

      const req = makeRequest({
        kalshiUrl: VALID_KALSHI_URL,
        polymarketUrl: VALID_POLYMARKET_URL,
        eventTitle: "With Scan Result",
        scanResult: {
          bestRoiPct: 12.5,
          bestProfit: 125,
          strategy: "Buy YES Kalshi + NO PM",
          outcomeCount: 3,
          matchedCount: 2,
          kalshiCount: 2,
          pmCount: 2,
          scannedAt: new Date().toISOString(),
        },
      });
      const res = await savedPost(req);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.market.id).toBe("market-1");
      expect(body.scanResultId).toBe(1);
    });
  });

  describe("DELETE — remove saved market", () => {
    it("removes market and returns success", async () => {
      (deleteSavedMarket as any).mockResolvedValue(true);

      const req = new Request(
        "http://localhost:3000/api/saved-markets?id=m1",
        { method: "DELETE" },
      ) as any;
      const res = await savedDelete(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it("returns 400 when id is missing", async () => {
      const req = new Request("http://localhost:3000/api/saved-markets", {
        method: "DELETE",
      }) as any;
      const res = await savedDelete(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Missing id");
    });

    it("returns success=false when market not found", async () => {
      (deleteSavedMarket as any).mockResolvedValue(false);

      const req = new Request(
        "http://localhost:3000/api/saved-markets?id=nonexistent",
        { method: "DELETE" },
      ) as any;
      const res = await savedDelete(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(false);
    });
  });
});

describe("/api/scan-config", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET — read config", () => {
    it("returns 200 with config and scan plan", async () => {
      const mockConfig = {
        tiers: [
          { label: "Hot", maxDays: 7, intervalMs: 300000 },
          { label: "Warm", maxDays: 30, intervalMs: 900000 },
          { label: "Cold", maxDays: 365, intervalMs: 3600000 },
        ],
        lastUpdated: "2025-06-01T00:00:00Z",
      };
      const mockPlan = {
        hot: 2,
        warm: 3,
        cold: 1,
        total: 6,
        dueNow: { hot: 1, warm: 2, cold: 0 },
      };
      (loadScanConfig as any).mockReturnValue(mockConfig);
      (getSavedMarkets as any).mockResolvedValue([]);
      (getScanPlanSummary as any).mockReturnValue(mockPlan);

      const res = await configGet();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config).toEqual(mockConfig);
      expect(body.plan).toEqual(mockPlan);
    });
  });

  describe("POST — save config", () => {
    it("saves new config and returns 200", async () => {
      const newTiers = [
        { label: "Hot", maxDays: 5, intervalMs: 2 * 60 * 1000 },
        { label: "Warm", maxDays: 21, intervalMs: 10 * 60 * 1000 },
        { label: "Cold", maxDays: 365, intervalMs: 30 * 60 * 1000 },
      ];

      const req = makeRequest({ tiers: newTiers });
      const res = await configPost(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.config.tiers).toEqual(newTiers);
      expect(body.config.lastUpdated).toBeDefined();
      expect(saveScanConfig).toHaveBeenCalled();
    });

    it("calls saveScanConfig with correct structure", async () => {
      const tiers = [
        { label: "Custom", maxDays: 14, intervalMs: 60000 },
      ];

      const req = makeRequest({ tiers });
      await configPost(req);

      expect(saveScanConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          tiers,
          lastUpdated: expect.any(String),
        }),
      );
    });
  });
});
