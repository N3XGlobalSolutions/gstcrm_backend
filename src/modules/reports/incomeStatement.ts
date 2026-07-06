/**
 * Period Net-Profit Income Statement.
 *
 *   Sales revenue (net of discount)
 *   − COGS (weighted-average cost of the pure gold sold)
 *   = Gross gold margin
 *   + Labour / making income (net labour-bill cash + value of gold retained from goldsmiths)
 *   − Operating expenses
 *   = Net profit
 *
 * Cost basis: perpetual weighted-average via `computeWeightedAverageCogs`, built
 * from PURCHASE + OPENING inflows into the SHOP. Opening stock (no rate) is seeded
 * at the earliest purchase rate. GST is excluded (pass-through); TDS/TCS are
 * surfaced separately, not deducted. Wastage grams sold are costed at v1 (accepted).
 */
import { db } from "@/db";
import { toDecimal } from "@/lib/decimal";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import { resolveDateRange, type DateRangeInput } from "@/lib/dateRange";
import { computeWeightedAverageCogs, type CostEvent } from "./cogs";
import { sql } from "drizzle-orm";

const SHOP = SYSTEM_ACCOUNTS.SHOP_ID;
const RUPEE = SYSTEM_ITEMS.RUPEE_ITEM_ID;

/** Inclusive `entry_groups.date` filter; null bounds mean unbounded. */
function periodSql(from: string | null, to: string | null) {
  if (from && to) return sql`AND g.date BETWEEN ${from} AND ${to}`;
  if (from) return sql`AND g.date >= ${from}`;
  if (to) return sql`AND g.date <= ${to}`;
  return sql``;
}

/**
 * Map the ledger into cost events for the COGS engine.
 * IN  = PURCHASE/OPENING gold/ornament flowing INTO the shop, at its cost rate.
 * OUT = SALE gold/ornament flowing OUT of the shop, at its sale rate.
 * Opening stock (null rate) is seeded at the earliest purchase rate.
 * The full history is returned (not period-filtered) so the running average is
 * correct; the engine tallies revenue/COGS only for in-window sales.
 */
async function getCostEvents(): Promise<CostEvent[]> {
  const rows = await db.execute<{
    type: string;
    date: string;
    group_rate: string | null;
    entry_rate: string | null;
    pure: string | null;
    from_acc: string;
    to_acc: string;
  }>(sql`
    SELECT g.type AS type, g.date::text AS date,
           g.rate_per_gram::text AS group_rate, e.rate::text AS entry_rate,
           e.pure_quantity::text AS pure,
           e.from_account_id AS from_acc, e.to_account_id AS to_acc
    FROM entries e
    JOIN entry_groups g ON e.group_id = g.id
    JOIN items i ON e.item_id = i.id
    WHERE g.is_deleted = false
      AND g.type IN ('PURCHASE', 'OPENING', 'SALE')
      AND i.type IN ('GOLD', 'ORNAMENT')
  `);

  // Seed = earliest purchase's rate_per_gram (Q1 default for opening-stock cost).
  const purchaseRates = rows
    .filter((r) => r.type === "PURCHASE" && r.group_rate && Number(r.group_rate) > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const seed = purchaseRates[0]?.group_rate ?? "0";

  const events: CostEvent[] = [];
  for (const r of rows) {
    const pure = r.pure ?? "0";
    if ((r.type === "PURCHASE" || r.type === "OPENING") && r.to_acc === SHOP) {
      const costRate = r.entry_rate ?? r.group_rate ?? seed ?? "0";
      events.push({ kind: "IN", date: r.date, pure, costRate });
    } else if (r.type === "SALE" && r.from_acc === SHOP) {
      const rate = r.entry_rate ?? r.group_rate ?? "0";
      events.push({ kind: "OUT", date: r.date, pure, rate });
    }
  }
  return events;
}

export type IncomeStatementInput = DateRangeInput;

export async function getIncomeStatement(input: IncomeStatementInput) {
  const { from, to } = resolveDateRange(input);
  const period = periodSql(from, to);

  const events = await getCostEvents();
  const cogs = computeWeightedAverageCogs(events, { from, to });

  const [discountRow, labourRow, expenseRow, taxRow] = await Promise.all([
    // Sale discounts given in-period (RUPEE 'Discount' lines on SALE groups).
    db.execute<{ total: string | null }>(sql`
      SELECT COALESCE(SUM(e.quantity), 0)::text AS total
      FROM entries e JOIN entry_groups g ON e.group_id = g.id
      WHERE g.is_deleted = false AND g.type = 'SALE'
        AND e.item_id = ${RUPEE} AND e.remarks ILIKE 'Discount' ${period}`),

    // Labour/making income = net labour-bill cash to shop + value of net gold
    // retained from goldsmiths (net pure into shop × that bill's rate_per_gram).
    db.execute<{ cash_net: string | null; gold_gain_pure: string | null; gold_gain_value: string | null }>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN e.item_id = ${RUPEE} AND e.to_account_id = ${SHOP} THEN e.quantity
                          WHEN e.item_id = ${RUPEE} AND e.from_account_id = ${SHOP} THEN -e.quantity
                          ELSE 0 END), 0)::text AS cash_net,
        COALESCE(SUM(CASE WHEN e.item_id != ${RUPEE} AND e.to_account_id = ${SHOP} THEN e.pure_quantity
                          WHEN e.item_id != ${RUPEE} AND e.from_account_id = ${SHOP} THEN -e.pure_quantity
                          ELSE 0 END), 0)::text AS gold_gain_pure,
        COALESCE(SUM(CASE WHEN e.item_id != ${RUPEE} AND e.to_account_id = ${SHOP} THEN e.pure_quantity * COALESCE(g.rate_per_gram, 0)
                          WHEN e.item_id != ${RUPEE} AND e.from_account_id = ${SHOP} THEN -e.pure_quantity * COALESCE(g.rate_per_gram, 0)
                          ELSE 0 END), 0)::text AS gold_gain_value
      FROM entries e JOIN entry_groups g ON e.group_id = g.id
      WHERE g.is_deleted = false AND g.type = 'LABOUR_BILL' ${period}`),

    // Operating expenses (RUPEE lines on EXPENSE groups).
    db.execute<{ total: string | null }>(sql`
      SELECT COALESCE(SUM(e.quantity), 0)::text AS total
      FROM entries e JOIN entry_groups g ON e.group_id = g.id
      WHERE g.is_deleted = false AND g.type = 'EXPENSE' AND e.item_id = ${RUPEE} ${period}`),

    // Taxes (context only — NOT deducted from net profit).
    db.execute<{ tds: string | null; tcs: string | null; gst: string | null }>(sql`
      SELECT COALESCE(SUM(g.tds_amount), 0)::text AS tds,
             COALESCE(SUM(g.tcs_amount), 0)::text AS tcs,
             COALESCE(SUM(g.gst_amount), 0)::text AS gst
      FROM entry_groups g
      WHERE g.is_deleted = false
        AND g.type IN ('SALE', 'PURCHASE', 'LABOUR_BILL') ${period}`),
  ]);

  const grossRevenue = toDecimal(cogs.salesRevenue);
  const saleDiscounts = toDecimal(discountRow[0]?.total ?? "0");
  const netRevenue = grossRevenue.minus(saleDiscounts);
  const cogsVal = toDecimal(cogs.cogs);
  const grossMargin = netRevenue.minus(cogsVal);

  const labourCashNet = toDecimal(labourRow[0]?.cash_net ?? "0");
  const labourGoldGainPure = toDecimal(labourRow[0]?.gold_gain_pure ?? "0");
  const labourGoldGainValue = toDecimal(labourRow[0]?.gold_gain_value ?? "0");
  const labourIncome = labourCashNet.plus(labourGoldGainValue);

  const operatingExpenses = toDecimal(expenseRow[0]?.total ?? "0");
  const netProfit = grossMargin.plus(labourIncome).minus(operatingExpenses);

  return {
    range: { from, to },
    // Revenue → gross margin
    sales_revenue_gross: grossRevenue.toFixed(2),
    sale_discounts: saleDiscounts.toFixed(2),
    sales_revenue_net: netRevenue.toFixed(2),
    cogs: cogsVal.toFixed(2),
    gross_margin: grossMargin.toFixed(2),
    pure_sold: cogs.pureSold,
    ending_avg_cost: cogs.endingAvgCost,
    // Labour / making income (with breakdown)
    labour_income: labourIncome.toFixed(2),
    labour_cash_net: labourCashNet.toFixed(2),
    labour_gold_gain_pure: labourGoldGainPure.toFixed(3),
    labour_gold_gain_value: labourGoldGainValue.toFixed(2),
    // Expenses → net profit
    operating_expenses: operatingExpenses.toFixed(2),
    net_profit: netProfit.toFixed(2),
    // Taxes — shown separately, NOT in net profit
    tds_total: toDecimal(taxRow[0]?.tds ?? "0").toFixed(2),
    tcs_total: toDecimal(taxRow[0]?.tcs ?? "0").toFixed(2),
    gst_total: toDecimal(taxRow[0]?.gst ?? "0").toFixed(2),
  };
}
