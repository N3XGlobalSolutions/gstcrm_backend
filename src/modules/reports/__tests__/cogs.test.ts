import { describe, it, expect } from "bun:test";
import { computeWeightedAverageCogs, type CostEvent } from "../cogs";

const ALL = { from: null, to: null };

describe("computeWeightedAverageCogs — weighted-average COGS", () => {
  it("canonical case: buy 100g@5000 + 100g@6000, sell 150g@7000 → avg cost 5500", () => {
    const events: CostEvent[] = [
      { kind: "IN", date: "2026-01-01", pure: "100", costRate: "5000" },
      { kind: "IN", date: "2026-01-02", pure: "100", costRate: "6000" },
      { kind: "OUT", date: "2026-01-03", pure: "150", rate: "7000" },
    ];
    const r = computeWeightedAverageCogs(events, ALL);
    expect(r.salesRevenue).toBe("1050000.00"); // 150 × 7000
    expect(r.cogs).toBe("825000.00"); // 150 × 5500 avg
    expect(r.grossMargin).toBe("225000.00");
    expect(r.pureSold).toBe("150.000");
    expect(r.endingAvgCost).toBe("5500.00"); // remaining 50g still at 5500
  });

  it("running average changes mid-stream as new stock arrives", () => {
    const events: CostEvent[] = [
      { kind: "IN", date: "2026-01-01", pure: "100", costRate: "5000" },
      { kind: "OUT", date: "2026-01-02", pure: "50", rate: "6000" }, // COGS @5000
      { kind: "IN", date: "2026-01-03", pure: "100", costRate: "6000" }, // avg → 5666.67
      { kind: "OUT", date: "2026-01-04", pure: "100", rate: "7000" }, // COGS @5666.67
    ];
    const r = computeWeightedAverageCogs(events, ALL);
    // revenue = 50×6000 + 100×7000 = 1,000,000
    expect(r.salesRevenue).toBe("1000000.00");
    // cogs = 50×5000 + 100×(850000/150) = 250000 + 566666.67
    expect(r.cogs).toBe("816666.67");
    expect(r.grossMargin).toBe("183333.33");
  });

  it("reporting window excludes out-of-period sales but keeps their inventory effect", () => {
    const events: CostEvent[] = [
      { kind: "IN", date: "2026-01-01", pure: "100", costRate: "5000" },
      { kind: "OUT", date: "2026-01-15", pure: "40", rate: "7000" }, // Jan — excluded
      { kind: "OUT", date: "2026-02-10", pure: "60", rate: "7000" }, // Feb — counted
    ];
    const r = computeWeightedAverageCogs(events, { from: "2026-02-01", to: "2026-02-28" });
    expect(r.pureSold).toBe("60.000");
    expect(r.salesRevenue).toBe("420000.00"); // 60 × 7000
    expect(r.cogs).toBe("300000.00"); // 60 × 5000 (avg unchanged by the Jan sale)
    expect(r.grossMargin).toBe("120000.00");
  });

  it("same-day purchase is available to a same-day sale", () => {
    const events: CostEvent[] = [
      { kind: "IN", date: "2026-03-01", pure: "100", costRate: "5000" },
      { kind: "OUT", date: "2026-03-01", pure: "50", rate: "7000" },
    ];
    const r = computeWeightedAverageCogs(events, ALL);
    expect(r.cogs).toBe("250000.00"); // 50 × 5000, not 0
    expect(r.grossMargin).toBe("100000.00");
  });

  it("sale with no prior inventory falls back to zero cost (no divide-by-zero)", () => {
    const events: CostEvent[] = [
      { kind: "OUT", date: "2026-04-01", pure: "10", rate: "7000" },
    ];
    const r = computeWeightedAverageCogs(events, ALL);
    expect(r.cogs).toBe("0.00");
    expect(r.salesRevenue).toBe("70000.00");
    expect(r.grossMargin).toBe("70000.00");
  });

  it("all-time window includes everything", () => {
    const events: CostEvent[] = [
      { kind: "IN", date: "2025-12-31", pure: "10", costRate: "5000" },
      { kind: "OUT", date: "2026-06-30", pure: "10", rate: "5500" },
    ];
    const r = computeWeightedAverageCogs(events, ALL);
    expect(r.grossMargin).toBe("5000.00"); // 10 × (5500 − 5000)
  });
});
