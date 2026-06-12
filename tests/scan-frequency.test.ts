import { describe, it, expect } from "vitest";
import {
  getTierForMarket,
  isMarketDueForScan,
  sortMarketsByScanPriority,
  getScanPlanSummary,
  DEFAULT_SCAN_CONFIG,
} from "../src/lib/scan-frequency";

describe("scan-frequency", () => {
  describe("getTierForMarket", () => {
    it("returns Hot tier for markets expiring within 7 days", () => {
      const tier = getTierForMarket(
        new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      );
      expect(tier?.label).toBe("Hot");
      expect(tier?.intervalRuns).toBe(1);
    });

    it("returns Warm tier for markets expiring in 8–14 days", () => {
      const tier = getTierForMarket(
        new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      );
      expect(tier?.label).toBe("Warm");
      expect(tier?.intervalRuns).toBe(2);
    });

    it("returns Cool tier for markets expiring in 15–30 days", () => {
      const tier = getTierForMarket(
        new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
      );
      expect(tier?.label).toBe("Cool");
      expect(tier?.intervalRuns).toBe(4);
    });

    it("returns Cold tier for markets expiring after 30 days", () => {
      const tier = getTierForMarket(
        new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      );
      expect(tier?.label).toBe("Cold");
      expect(tier?.intervalRuns).toBe(8);
    });

    it("returns Cold tier for null expiry", () => {
      const tier = getTierForMarket(null);
      expect(tier?.label).toBe("Cold");
    });

    it("returns Hot tier for expired markets", () => {
      const tier = getTierForMarket(
        new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      );
      expect(tier?.label).toBe("Hot");
    });
  });

  describe("isMarketDueForScan", () => {
    it("always due for hot markets", () => {
      expect(
        isMarketDueForScan(
          new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // scanned 1h ago
          0,
        ),
      ).toBe(true);
    });

    it("due if never scanned before", () => {
      expect(isMarketDueForScan(null, null, 0)).toBe(true);
    });

    it("not due for cold markets scanned recently", () => {
      const recently = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
      expect(
        isMarketDueForScan(
          new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
          recently,
          0,
        ),
      ).toBe(false); // cold tier minHours is 4, so 2h ago = not due
    });

    it("due for cold markets after enough time", () => {
      const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(); // 6h ago
      expect(
        isMarketDueForScan(
          new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
          longAgo,
          0,
        ),
      ).toBe(true); // > 4h minHours for cold tier
    });
  });

  describe("sortMarketsByScanPriority", () => {
    it("sorts hot markets before cold", () => {
      const markets = [
        { id: "1", expiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString() }, // cold
        { id: "2", expiryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() },   // hot
      ];
      const sorted = sortMarketsByScanPriority(markets);
      expect(sorted[0].id).toBe("2"); // hot first
      expect(sorted[1].id).toBe("1"); // cold second
    });

    it("sorts by last scanned time within same tier", () => {
      const markets = [
        {
          id: "1",
          expiryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          lastScanResult: { scannedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString() },
        },
        {
          id: "2",
          expiryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          lastScanResult: { scannedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() },
        },
      ];
      const sorted = sortMarketsByScanPriority(markets);
      expect(sorted[0].id).toBe("2"); // scanned 5h ago = more urgent
      expect(sorted[1].id).toBe("1"); // scanned 1h ago
    });
  });

  describe("getScanPlanSummary", () => {
    it("correctly buckets markets by tier", () => {
      const markets = [
        { id: "1", eventTitle: "Hot", expiryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), lastScanResult: null },
        { id: "2", eventTitle: "Warm", expiryDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(), lastScanResult: null },
        { id: "3", eventTitle: "Cool", expiryDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(), lastScanResult: null },
        { id: "4", eventTitle: "Cold", expiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(), lastScanResult: null },
      ];
      const summary = getScanPlanSummary(markets);
      expect(summary.total).toBe(4);
      expect(summary.hot).toBe(1);
      expect(summary.warm).toBe(1);
      expect(summary.cool).toBe(1);
      expect(summary.cold).toBe(1);
    });
  });
});
