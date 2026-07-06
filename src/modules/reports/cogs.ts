/**
 * Weighted-average Cost of Goods Sold (COGS) engine.
 *
 * Perpetual weighted-average method: we maintain a running inventory of pure
 * grams and their total ₹ cost. Each purchase/opening inflow adds pure grams at
 * its cost rate and updates the average; each sale consumes pure grams at the
 * average cost AT THAT MOMENT. This is the standard, robust cost basis for a
 * fungible commodity like gold and needs only the per-bill (or per-lot) rate.
 *
 * Design: the math is a PURE function (`computeWeightedAverageCogs`) with no DB
 * access, so it is fully unit-testable. A thin DB layer (added separately) maps
 * ledger entries into `CostEvent`s and resolves the opening-stock cost seed.
 *
 * Reporting window: the running average is built from the ENTIRE history in
 * chronological order (so a sale is costed against everything bought before it),
 * but revenue/COGS are only TALLIED for sales whose date falls in [from, to].
 * `from`/`to` = null means unbounded on that side (all-time).
 */
import { Decimal, toDecimal } from "@/lib/decimal";

/** A gold/ornament inflow (purchase or opening) valued at a ₹/pure-gram cost. */
export interface CostInEvent {
  kind: "IN";
  date: string; // YYYY-MM-DD (entry_groups.date)
  pure: string; // pure grams added to inventory
  costRate: string; // ₹ per pure gram (cost)
}

/** A gold/ornament outflow (sale) valued at a ₹/pure-gram sale rate. */
export interface CostOutEvent {
  kind: "OUT";
  date: string; // YYYY-MM-DD
  pure: string; // pure grams sold
  rate: string; // ₹ per pure gram (sale price)
}

export type CostEvent = CostInEvent | CostOutEvent;

export interface CogsResult {
  /** Σ (in-window sale pure × sale rate), rupees, 2dp. Gross of discounts. */
  salesRevenue: string;
  /** Σ (in-window sale pure × avg cost at time of sale), rupees, 2dp. */
  cogs: string;
  /** salesRevenue − cogs, rupees, 2dp. */
  grossMargin: string;
  /** Σ in-window sale pure grams, 3dp. */
  pureSold: string;
  /** Weighted-average cost per pure gram after processing all events, 2dp. */
  endingAvgCost: string;
}

/**
 * Compute perpetual weighted-average COGS and gross margin for a reporting window.
 *
 * Inventory is allowed to go negative (the ledger permits oversells for
 * goldsmith/job-work flows); when inventory is ≤ 0 the last known positive
 * average cost is used as the fallback so COGS never divides by zero.
 */
export function computeWeightedAverageCogs(
  events: CostEvent[],
  window: { from: string | null; to: string | null },
): CogsResult {
  // Stable chronological order. On the same date, process inflows before sales
  // so a same-day purchase is available to that day's sale.
  const ordered = [...events].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "IN" ? -1 : 1;
    return 0;
  });

  let invPure = toDecimal("0"); // pure grams currently in inventory
  let invCost = toDecimal("0"); // ₹ cost of that inventory
  let lastAvg = toDecimal("0"); // fallback avg cost when inventory ≤ 0

  let revenue = toDecimal("0");
  let cogs = toDecimal("0");
  let pureSold = toDecimal("0");

  const inWindow = (date: string) =>
    (window.from === null || date >= window.from) &&
    (window.to === null || date <= window.to);

  for (const ev of ordered) {
    if (ev.kind === "IN") {
      const pure = toDecimal(ev.pure);
      invPure = invPure.plus(pure);
      invCost = invCost.plus(pure.mul(toDecimal(ev.costRate)));
      if (invPure.gt(0)) lastAvg = invCost.div(invPure);
    } else {
      const s = toDecimal(ev.pure);
      const avg = invPure.gt(0) ? invCost.div(invPure) : lastAvg;
      const lineCogs = s.mul(avg);

      invPure = invPure.minus(s);
      invCost = invCost.minus(lineCogs);
      if (invPure.gt(0)) lastAvg = invCost.div(invPure);

      if (inWindow(ev.date)) {
        revenue = revenue.plus(s.mul(toDecimal(ev.rate)));
        cogs = cogs.plus(lineCogs);
        pureSold = pureSold.plus(s);
      }
    }
  }

  const endingAvg: Decimal = invPure.gt(0) ? invCost.div(invPure) : lastAvg;

  return {
    salesRevenue: revenue.toFixed(2),
    cogs: cogs.toFixed(2),
    grossMargin: revenue.minus(cogs).toFixed(2),
    pureSold: pureSold.toFixed(3),
    endingAvgCost: endingAvg.toFixed(2),
  };
}
