import { describe, it, expect } from "vitest";
import {
  getTierForMarket,
  isMarketDueForScan,
  sortMarketsByScanPriority,
  getScanPlanSummary,
  DEFAULT_TIERS,
} from "../src/lib/scan-frequency";

describe("scan-frequency", () => {
  const TIERS = DEFAULT_TIERS;

  describe("getTierForMarket", () => {
    it("returns Hot tier for markets expiring within 7 days", () => {
      const tier = getTierForMarket(
        new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        TIERS,
      );
      expect(tier?.label).toBe("Hot");
      expect(tier?.intervalMs).toBe(5 * 60 * 1000);
    });

    it("returns Warm tier for markets expiring in 8–30 days", () => {
      const tier = getTierForMarket(
        new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        TIERS,
      );
      expect(tier?.label).toBe("Warm");
      expect(tier?.intervalMs).toBe(15 * 60 * 1000);
    });

    it("returns Cold tier for markets expiring after 30 days", () => {
      const tier = getTierForMarket(
        new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        TIERS,
      );
      expect(tier?.label).toBe("Cold");
      expect(tier?.intervalMs).toBe(60 * 60 * 1000);
    });

    it("returns Cold tier for null expiry", () => {
      const tier = getTierForMarket(null, TIERS);
      expect(tier?.label).toBe("Cold");
    });

    it("returns null for expired markets", () => {
      const tier = getTierForMarket(
        new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        TIERS,
      );
      expect(tier).toBeNull();
    });
  });

  describe("isMarketDueForScan", () => {
    it("is due for hot markets scanned 10 min ago", () => {
      expect(
        isMarketDueForScan(
          {
            expiryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
            lastScannedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
          },
          TIERS,
        ),
      ).toBe(true); // hot = 5 min interval
    });

    it("is due if never scanned", () => {
      expect(
        isMarketDueForScan(
          { expiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString() },
          TIERS,
        ),
      ).toBe(true);
    });

    it("is NOT due for cold markets scanned 30 min ago", () => {
      expect(
        isMarketDueForScan(
          {
            expiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
            lastScannedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
          },
          TIERS,
        ),
      ).toBe(false); // cold = 60 min interval
    });

    it("IS due for cold markets scanned 2 hours ago", () => {
      expect(
        isMarketDueForScan(
          {
            expiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
            lastScannedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
          },
          TIERS,
        ),
      ).toBe(true); // > 60 min interval
    });
  });

  describe("sortMarketsByScanPriority", () => {
    it("sorts hot markets before cold", () => {
      const markets = [
        { id: "1", expiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString() }, // cold
        { id: "2", expiryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() },   // hot
      ];
      const sorted = sortMarketsByScanPriority(markets, TIERS);
      expect(sorted[0].id).toBe("2"); // hot first
      expect(sorted[1].id).toBe("1"); // cold second
    });

    it("sorts by last scanned time within same tier", () => {
      const markets = [
        {
          id: "1",
          expiryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          lastScannedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        },
        {
          id: "2",
          expiryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          lastScannedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        },
      ];
      const sorted = sortMarketsByScanPriority(markets, TIERS);
      expect(sorted[0].id).toBe("2"); // scanned 5h ago = more urgent
      expect(sorted[1].id).toBe("1"); // scanned 1h ago
    });
  });

  describe("getScanPlanSummary", () => {
    it("correctly buckets markets by tier", () => {
      const markets = [
        { id: "1", expiryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), lastScannedAt: null },
        { id: "2", expiryDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(), lastScannedAt: null },
        { id: "3", expiryDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(), lastScannedAt: null },
        { id: "4", expiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(), lastScannedAt: null },
      ];
      const summary = getScanPlanSummary(markets, TIERS);
      expect(summary.total).toBe(4);
      expect(summary.hot).toBe(1);
      expect(summary.warm).toBe(2); // 10d + 20d
      expect(summary.cold).toBe(1); // 60d
      expect(summary.dueNow.hot).toBe(1);
      expect(summary.dueNow.warm).toBe(2); // 10d + 20d
      expect(summary.dueNow.cold).toBe(1); // 60d
    });

    it("expired markets are excluded", () => {
      const markets = [
        { id: "1", expiryDate: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() },
        { id: "2", expiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString() },
      ];
      const summary = getScanPlanSummary(markets, TIERS);
      expect(summary.total).toBe(2);
      expect(summary.hot).toBe(0);
      expect(summary.warm).toBe(0);
      expect(summary.cold).toBe(1);
    });
  });
});
