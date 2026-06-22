import { db } from "@/db";
import { entries, accounts } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { subtractDecimals, toDecimal, type Decimal } from "./decimal";
import { SYSTEM_ITEMS } from "@/config/constants";

/**
 * The single most important query in the system.
 *
 * Returns the net balance for an account/item combination:
 *   balance = SUM(to_account_id matches) - SUM(from_account_id matches)
 *
 * Works identically for gold grams, ornament pieces, and rupees.
 * This is the ONLY way balances are read — never stored as running totals.
 *
 * @param accountId - UUID of the account
 * @param itemId    - UUID of the item
 * @param asOfDate  - Optional cut-off date (inclusive)
 */
export async function getBalance(
  accountId: string,
  itemId: string,
  asOfDate?: Date,
): Promise<Decimal> {
  const dateFilter = asOfDate
    ? sql`AND created_at <= ${asOfDate.toISOString()}`
    : sql``;

  // Inflows: entries where this account RECEIVED the item
  const [inflowRow] = await db.execute<{ total: string | null }>(
    sql`SELECT COALESCE(SUM(quantity), 0)::text AS total
        FROM ${entries}
        WHERE to_account_id = ${accountId}
          AND item_id = ${itemId}
          ${dateFilter}`,
  );

  // Outflows: entries where this account SENT the item
  const [outflowRow] = await db.execute<{ total: string | null }>(
    sql`SELECT COALESCE(SUM(quantity), 0)::text AS total
        FROM ${entries}
        WHERE from_account_id = ${accountId}
          AND item_id = ${itemId}
          ${dateFilter}`,
  );

  const inflows = inflowRow?.total ?? "0";
  const outflows = outflowRow?.total ?? "0";

  return subtractDecimals(inflows, outflows);
}

/**
 * Batch balance lookup — runs all getBalance calls in parallel via Promise.all.
 * Used in dashboard and stock views.
 */
export async function getBalances(
  accountId: string,
  itemIds: string[],
  asOfDate?: Date,
): Promise<Record<string, Decimal>> {
  const results = await Promise.all(
    itemIds.map(async (itemId) => {
      const balance = await getBalance(accountId, itemId, asOfDate);
      return [itemId, balance] as const;
    }),
  );

  return Object.fromEntries(results);
}

/**
 * Returns the aggregate "Total Pure Balance" and "Total Cash Balance" across the ledger.
 *
 * KEY DESIGN: balancePure uses per-bill rates to avoid the rate-change phantom problem.
 *
 * WRONG: balancePure = totalPure + totalCash / lastRate
 *   — when lastRate changes, previously paid cash is re-valued at the new rate,
 *     creating a phantom balance even when the customer has fully paid.
 *
 * CORRECT: balancePure = Σ(pure_sold_in_bill) - Σ(payment_in_bill / rate_of_bill)
 *   — each payment is divided by the rate at the time of THAT bill, rate-independent.
 */
export async function getAggregateBalances(
  accountId: string,
  asOfDate?: Date,
  excludeGroupId?: string,
): Promise<{ totalPure: Decimal; totalCash: Decimal; balancePure: Decimal }> {
  const dateFilter = asOfDate
    ? sql`AND e.created_at <= ${asOfDate.toISOString()}`
    : sql``;
    
  const excludeFilter = excludeGroupId
    ? sql`AND e.group_id != ${excludeGroupId}`
    : sql``;

  // Shared aliases for clarity — entries 'e', entry_groups 'g'
  const cashItemId = SYSTEM_ITEMS.RUPEE_ITEM_ID;

  // 1. Total Pure Balance = SUM(inflow pure_quantity) - SUM(outflow pure_quantity)
  const [pureInflow] = await db.execute<{ total: string | null }>(
    sql`SELECT COALESCE(SUM(e.pure_quantity), 0)::text AS total
        FROM entries e
        WHERE e.to_account_id = ${accountId}
          ${dateFilter}
          ${excludeFilter}`,
  );
  
  const [pureOutflow] = await db.execute<{ total: string | null }>(
    sql`SELECT COALESCE(SUM(e.pure_quantity), 0)::text AS total
        FROM entries e
        WHERE e.from_account_id = ${accountId}
          ${dateFilter}
          ${excludeFilter}`,
  );

  // 2. Total Cash Balance (kept for backward compatibility — raw RUPEE net flow)
  const [cashInflow] = await db.execute<{ total: string | null }>(
    sql`SELECT COALESCE(SUM(e.quantity), 0)::text AS total
        FROM entries e
        WHERE e.to_account_id = ${accountId}
          AND e.item_id = ${cashItemId}
          ${dateFilter}
          ${excludeFilter}`,
  );
  
  const [cashOutflow] = await db.execute<{ total: string | null }>(
    sql`SELECT COALESCE(SUM(e.quantity), 0)::text AS total
        FROM entries e
        WHERE e.from_account_id = ${accountId}
          AND e.item_id = ${cashItemId}
          ${dateFilter}
          ${excludeFilter}`,
  );

  // 3. Rate-stable payment pure equivalent:
  //    For each RUPEE payment from the customer that belongs to a bill WITH a rate,
  //    divide the payment by that bill's rate. This makes the balance independent of
  //    any future rate change.
  //    Formula: Σ(payment_amount / rate_of_bill) - Σ(refund_amount / rate_of_bill)
  const [paymentPureRow] = await db.execute<{ total: string | null }>(
    sql`SELECT COALESCE(SUM(
          CASE
            WHEN e.from_account_id = ${accountId}
              THEN e.quantity / NULLIF(g.rate_per_gram::numeric, 0)
            WHEN e.to_account_id = ${accountId}
              THEN -(e.quantity / NULLIF(g.rate_per_gram::numeric, 0))
            ELSE 0
          END
        ), 0)::text AS total
        FROM entries e
        INNER JOIN entry_groups g ON e.group_id = g.id
        WHERE (e.from_account_id = ${accountId} OR e.to_account_id = ${accountId})
          AND e.item_id = ${cashItemId}
          AND g.rate_per_gram IS NOT NULL
          AND g.rate_per_gram::numeric > 0
          ${dateFilter}
          ${excludeFilter}`,
  );

  // 4. Cash flows from OPENING entries (no rate_per_gram) — e.g. opening_cash_balance
  //    These cannot be converted per-bill, so they are kept as raw cash amounts.
  //    They will be divided by lastRate in the service layer for display.
  const [cashNoRateRow] = await db.execute<{ total: string | null }>(
    sql`SELECT COALESCE(SUM(
          CASE
            WHEN e.to_account_id = ${accountId}   THEN  e.quantity
            WHEN e.from_account_id = ${accountId} THEN -e.quantity
            ELSE 0
          END
        ), 0)::text AS total
        FROM entries e
        INNER JOIN entry_groups g ON e.group_id = g.id
        WHERE (e.from_account_id = ${accountId} OR e.to_account_id = ${accountId})
          AND e.item_id = ${cashItemId}
          AND (g.rate_per_gram IS NULL OR g.rate_per_gram::numeric = 0)
          ${dateFilter}
          ${excludeFilter}`,
  );

  const pureBalance = subtractDecimals(pureInflow?.total ?? "0", pureOutflow?.total ?? "0");
  const cashBalance = subtractDecimals(cashInflow?.total ?? "0", cashOutflow?.total ?? "0");
  const paymentPure = toDecimal(paymentPureRow?.total ?? "0");
  const cashNoRate = toDecimal(cashNoRateRow?.total ?? "0");

  // balancePure = pure received − (payments converted at bill rate) + opening_cash_no_rate
  // The cashNoRate term is handled by the caller dividing it by lastRate.
  // We expose it as a separate field so the caller can apply lastRate correctly.
  // For the common case (no opening cash balance): cashNoRate = 0 → balancePure = pureBalance − paymentPure
  const balancePureBeforeCash = pureBalance.minus(paymentPure);

  return {
    totalPure: pureBalance,
    totalCash: cashBalance,
    balancePure: balancePureBeforeCash, // rate-stable, excludes opening cash (handled in service)
    // internal: expose cashNoRate via totalCash for the service layer to handle opening_cash_balance
  };
}

export interface LotBalance {
  lot_id: string;
  quantity: Decimal;
  purity: Decimal | null;
  average_touch: Decimal | null;
  pure_quantity: Decimal | null;
  created_at: Date;
}

/**
 * Retrieves unconsumed (active) stock grouped by their assigned lot_id.
 * It strictly filters out any lots that have been fully issued. 
 */
export async function getLotBalances(
  accountId: string,
  itemId: string,
  asOfDate?: Date,
): Promise<LotBalance[]> {
  const dateFilter = asOfDate
    ? sql`AND created_at <= ${asOfDate.toISOString()}`
    : sql``;

  const result = await db.execute<{
    lot_id: string;
    net_quantity: string;
    purity: string | null;
    average_touch: string | null;
    net_pure_quantity: string | null;
    created_at: Date;
  }>(sql`
    SELECT 
      lot_id,
      SUM(CASE WHEN to_account_id = ${accountId} THEN quantity ELSE -quantity END)::text AS net_quantity,
      MAX(purity)::text AS purity,
      MAX(average_touch)::text AS average_touch,
      SUM(CASE WHEN to_account_id = ${accountId} THEN pure_quantity ELSE -pure_quantity END)::text AS net_pure_quantity,
      MIN(created_at) AS created_at
    FROM ${entries}
    WHERE item_id = ${itemId}
      AND lot_id IS NOT NULL
      AND (to_account_id = ${accountId} OR from_account_id = ${accountId})
      ${dateFilter}
    GROUP BY lot_id
    HAVING SUM(CASE WHEN to_account_id = ${accountId} THEN quantity ELSE -quantity END) != 0
    ORDER BY MIN(created_at) ASC
  `);

  return result.map((row) => ({
    lot_id: row.lot_id,
    quantity: toDecimal(row.net_quantity),
    purity: row.purity ? toDecimal(row.purity) : null,
    average_touch: row.average_touch ? toDecimal(row.average_touch) : null,
    pure_quantity: row.net_pure_quantity ? toDecimal(row.net_pure_quantity) : null,
    created_at: new Date(row.created_at),
  }));
}
