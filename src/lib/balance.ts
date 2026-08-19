import { db } from "@/db";
import { entries, accounts } from "@/db/schema";
import { eq, and, or, sql, inArray, lte, isNotNull } from "drizzle-orm";
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
): Promise<{ totalPure: Decimal; totalCash: Decimal; balancePure: Decimal; goldCashOut: Decimal; goldCashIn: Decimal; pureNoRate: Decimal }> {
  const dateFilter = asOfDate
    ? sql`AND e.created_at <= ${asOfDate.toISOString()}`
    : sql``;
    
  const excludeFilter = excludeGroupId
    ? sql`AND e.group_id != ${excludeGroupId}`
    : sql``;

  const cashItemId = SYSTEM_ITEMS.RUPEE_ITEM_ID;

  const [row] = await db.execute<{
    pure_inflow: string | null;
    pure_outflow: string | null;
    cash_inflow: string | null;
    cash_outflow: string | null;
    payment_pure: string | null;
    cash_no_rate: string | null;
    gold_cash_out: string | null;
    gold_cash_in: string | null;
    pure_no_rate: string | null;
  }>(sql`
    SELECT
      SUM(CASE WHEN e.to_account_id = ${accountId} THEN e.pure_quantity ELSE 0 END)::text AS pure_inflow,
      SUM(CASE WHEN e.from_account_id = ${accountId} THEN e.pure_quantity ELSE 0 END)::text AS pure_outflow,
      
      SUM(CASE WHEN e.to_account_id = ${accountId} AND e.item_id = ${cashItemId} THEN e.quantity ELSE 0 END)::text AS cash_inflow,
      SUM(CASE WHEN e.from_account_id = ${accountId} AND e.item_id = ${cashItemId} THEN e.quantity ELSE 0 END)::text AS cash_outflow,

      SUM(CASE 
        WHEN e.item_id = ${cashItemId} AND g.rate_per_gram IS NOT NULL AND g.rate_per_gram::numeric > 0 THEN
          CASE
            WHEN e.from_account_id = ${accountId} THEN e.quantity / g.rate_per_gram::numeric
            WHEN e.to_account_id = ${accountId} THEN -(e.quantity / g.rate_per_gram::numeric)
            ELSE 0
          END
        ELSE 0
      END)::text AS payment_pure,

      SUM(CASE
        WHEN e.item_id = ${cashItemId} AND (g.rate_per_gram IS NULL OR g.rate_per_gram::numeric = 0) THEN
          CASE
            WHEN e.to_account_id = ${accountId} THEN e.quantity
            WHEN e.from_account_id = ${accountId} THEN -e.quantity
            ELSE 0
          END
        ELSE 0
      END)::text AS cash_no_rate,

      -- Sum of (pure × rate) for all gold entries FROM this account (gold sold/sent by account).
      -- For a purchase supplier: (goldCashOut − goldCashIn) − totalCash = cash still owed by the shop.
      -- Uses the per-ENTRY rate (e.rate) so a bill with different rates per item reconciles to
      -- the exact per-row cash the bill was paid against. Falling back to the group rate collapses
      -- custom rates into a rounded average, which re-multiplied leaves a few-paise phantom.
      SUM(CASE
        WHEN e.from_account_id = ${accountId}
          AND e.item_id != ${cashItemId}
          AND COALESCE(e.rate, g.rate_per_gram::numeric) IS NOT NULL
          AND COALESCE(e.rate, g.rate_per_gram::numeric) > 0
        THEN e.pure_quantity * COALESCE(e.rate, g.rate_per_gram::numeric)
        ELSE 0
      END)::text AS gold_cash_out,

      -- Mirror of gold_cash_out for gold entries TO this account (gold received by account).
      -- Reversals swap from/to, so subtracting goldCashIn cancels a reversed bill's gold
      -- value — keeping the cash-owed figure correct after a bill is edited/reversed.
      SUM(CASE
        WHEN e.to_account_id = ${accountId}
          AND e.item_id != ${cashItemId}
          AND COALESCE(e.rate, g.rate_per_gram::numeric) IS NOT NULL
          AND COALESCE(e.rate, g.rate_per_gram::numeric) > 0
        THEN e.pure_quantity * COALESCE(e.rate, g.rate_per_gram::numeric)
        ELSE 0
      END)::text AS gold_cash_in,

      -- Net pure grams from RATE-LESS entries (opening pure balances have no rate).
      -- These carry forward as grams directly — they have no cash equivalent and must
      -- never be folded into the cash-first balance (which is rated-gold + cash only).
      SUM(CASE
        WHEN COALESCE(e.rate, g.rate_per_gram::numeric) IS NULL
          OR COALESCE(e.rate, g.rate_per_gram::numeric) = 0 THEN
          CASE
            WHEN e.to_account_id = ${accountId} THEN e.pure_quantity
            WHEN e.from_account_id = ${accountId} THEN -e.pure_quantity
            ELSE 0
          END
        ELSE 0
      END)::text AS pure_no_rate
    FROM entries e
    LEFT JOIN entry_groups g ON e.group_id = g.id
    WHERE (e.to_account_id = ${accountId} OR e.from_account_id = ${accountId})
      ${dateFilter}
      ${excludeFilter}
  `);

  const pureInflow = row?.pure_inflow ?? "0";
  const pureOutflow = row?.pure_outflow ?? "0";
  const cashInflow = row?.cash_inflow ?? "0";
  const cashOutflow = row?.cash_outflow ?? "0";
  const paymentPure = toDecimal(row?.payment_pure ?? "0");
  const goldCashOut = toDecimal(row?.gold_cash_out ?? "0");
  const goldCashIn = toDecimal(row?.gold_cash_in ?? "0");
  const pureNoRate = toDecimal(row?.pure_no_rate ?? "0");

  const pureBalance = subtractDecimals(pureInflow, pureOutflow);
  const cashBalance = subtractDecimals(cashInflow, cashOutflow);

  return {
    totalPure: pureBalance,
    totalCash: cashBalance,
    // Pure Gold balance is strictly net pure gold grams — 100% separate from cash.
    balancePure: pureBalance,
    goldCashOut,
    goldCashIn,
    pureNoRate,
  };
}

export async function getBatchAggregateBalances(
  tuples: { id: string; accountId: string; createdAt: Date; excludeGroupId: string }[]
): Promise<Record<string, { totalPure: Decimal; totalCash: Decimal; balancePure: Decimal; goldCashOut: Decimal; goldCashIn: Decimal }>> {
  if (tuples.length === 0) return {};

  const cashItemId = SYSTEM_ITEMS.RUPEE_ITEM_ID;

  // Build: VALUES (id1, acc1, date1, excl1), (id2, acc2, date2, excl2), ...
  const valuesChunks = tuples.map(
    (t) => sql`(${t.id}::text, ${t.accountId}::uuid, ${t.createdAt.toISOString()}::timestamp, ${t.excludeGroupId}::uuid)`
  );
  
  const query = sql`
    WITH params(id, account_id, created_at, exclude_group_id) AS (
      VALUES ${sql.join(valuesChunks, sql`, `)}
    )
    SELECT 
      p.id,
      SUM(CASE WHEN e.to_account_id = p.account_id AND e.created_at <= p.created_at AND e.group_id != p.exclude_group_id THEN e.pure_quantity ELSE 0 END)::text AS pure_inflow,
      SUM(CASE WHEN e.from_account_id = p.account_id AND e.created_at <= p.created_at AND e.group_id != p.exclude_group_id THEN e.pure_quantity ELSE 0 END)::text AS pure_outflow,
      SUM(CASE WHEN e.to_account_id = p.account_id AND e.item_id = ${cashItemId} AND e.created_at <= p.created_at AND e.group_id != p.exclude_group_id THEN e.quantity ELSE 0 END)::text AS cash_inflow,
      SUM(CASE WHEN e.from_account_id = p.account_id AND e.item_id = ${cashItemId} AND e.created_at <= p.created_at AND e.group_id != p.exclude_group_id THEN e.quantity ELSE 0 END)::text AS cash_outflow,
      SUM(CASE 
        WHEN e.item_id = ${cashItemId} 
          AND (e.from_account_id = p.account_id OR e.to_account_id = p.account_id)
          AND e.created_at <= p.created_at 
          AND e.group_id != p.exclude_group_id
          AND g.rate_per_gram IS NOT NULL 
          AND g.rate_per_gram::numeric > 0 
        THEN
          CASE
            WHEN e.from_account_id = p.account_id THEN e.quantity / g.rate_per_gram::numeric
            WHEN e.to_account_id = p.account_id THEN -(e.quantity / g.rate_per_gram::numeric)
            ELSE 0
          END
        ELSE 0
      END)::text AS payment_pure,
      -- Σ(pure × rate) for gold entries FROM account: total cash value of gold sold by this account.
      -- goldCashOut − cashInflow = cash still owed to the supplier by the shop. Uses the per-ENTRY
      -- rate so per-item custom rates reconcile exactly (see single-query note above).
      SUM(CASE
        WHEN e.from_account_id = p.account_id
          AND e.item_id != ${cashItemId}
          AND e.created_at <= p.created_at
          AND e.group_id != p.exclude_group_id
          AND COALESCE(e.rate, g.rate_per_gram::numeric) IS NOT NULL
          AND COALESCE(e.rate, g.rate_per_gram::numeric) > 0
        THEN e.pure_quantity * COALESCE(e.rate, g.rate_per_gram::numeric)
        ELSE 0
      END)::text AS gold_cash_out,
      -- Mirror for gold entries TO account. Subtracting goldCashIn cancels a reversed
      -- bill's gold value (reversal swaps from/to), keeping edited-bill openings correct.
      SUM(CASE
        WHEN e.to_account_id = p.account_id
          AND e.item_id != ${cashItemId}
          AND e.created_at <= p.created_at
          AND e.group_id != p.exclude_group_id
          AND COALESCE(e.rate, g.rate_per_gram::numeric) IS NOT NULL
          AND COALESCE(e.rate, g.rate_per_gram::numeric) > 0
        THEN e.pure_quantity * COALESCE(e.rate, g.rate_per_gram::numeric)
        ELSE 0
      END)::text AS gold_cash_in
    FROM params p
    LEFT JOIN entries e ON (e.to_account_id = p.account_id OR e.from_account_id = p.account_id)
    LEFT JOIN entry_groups g ON e.group_id = g.id
    GROUP BY p.id;
  `;

  const rows = await db.execute<{
    id: string;
    pure_inflow: string | null;
    pure_outflow: string | null;
    cash_inflow: string | null;
    cash_outflow: string | null;
    payment_pure: string | null;
    gold_cash_out: string | null;
    gold_cash_in: string | null;
  }>(query);

  const results: Record<string, { totalPure: Decimal; totalCash: Decimal; balancePure: Decimal; goldCashOut: Decimal; goldCashIn: Decimal }> = {};

  for (const row of rows) {
    const pureInflow = row.pure_inflow ?? "0";
    const pureOutflow = row.pure_outflow ?? "0";
    const cashInflow = row.cash_inflow ?? "0";
    const cashOutflow = row.cash_outflow ?? "0";
    const paymentPure = toDecimal(row.payment_pure ?? "0");
    const goldCashOut = toDecimal(row.gold_cash_out ?? "0");
    const goldCashIn = toDecimal(row.gold_cash_in ?? "0");

    const pureBalance = subtractDecimals(pureInflow, pureOutflow);
    const cashBalance = subtractDecimals(cashInflow, cashOutflow);

    results[row.id] = {
      totalPure: pureBalance,
      totalCash: cashBalance,
      balancePure: pureBalance,
      goldCashOut,
      goldCashIn,
    };
  }

  // Ensure any input tuples that somehow got skipped or returned null are defaulted
  for (const t of tuples) {
    if (!results[t.id]) {
      results[t.id] = {
        totalPure: toDecimal("0"),
        totalCash: toDecimal("0"),
        balancePure: toDecimal("0"),
        goldCashOut: toDecimal("0"),
        goldCashIn: toDecimal("0"),
      };
    }
  }

  return results;
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
      -- Physical stock composition (quantity × purity), not the ledger's stored
      -- pure_quantity — same fix as getAccountLotBalances above, see its comment.
      SUM(CASE WHEN to_account_id = ${accountId} THEN quantity * COALESCE(purity, 0) / 100 ELSE -(quantity * COALESCE(purity, 0) / 100) END)::text AS net_pure_quantity,
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

export interface AccountLotBalance {
  item_id: string;
  lot_id: string;
  quantity: Decimal;
  purity: Decimal | null;
  average_touch: Decimal | null;
  pure_quantity: Decimal | null;
  created_at: Date;
}

export async function getAccountLotBalances(
  accountId: string,
  itemIds?: string[],
  asOfDate?: Date,
): Promise<AccountLotBalance[]> {
  const query = db
    .select({
      item_id: entries.item_id,
      lot_id: entries.lot_id,
      net_quantity: sql`SUM(CASE WHEN ${entries.to_account_id} = ${accountId} THEN ${entries.quantity} ELSE -${entries.quantity} END)::text`,
      purity: sql`MAX(${entries.purity})::text`,
      average_touch: sql`MAX(${entries.average_touch})::text`,
      // Physical stock composition (quantity × purity), NOT the ledger's stored
      // pure_quantity — cash-mode Sale/Purchase/Labour Bill entries deliberately
      // zero pure_quantity (that's correct for the CUSTOMER's cash ledger, not for
      // what physically sits in the shop's stock). Reading pure_quantity directly
      // here understated stock pure content by however much moved via cash-mode
      // bills, occasionally into negative territory (same bug class already fixed
      // for the dashboard's Total Purchase metric — see dashboard/router.ts).
      net_pure_quantity: sql`SUM(CASE WHEN ${entries.to_account_id} = ${accountId} THEN ${entries.quantity} * COALESCE(${entries.purity}, 0) / 100 ELSE -(${entries.quantity} * COALESCE(${entries.purity}, 0) / 100) END)::text`,
      created_at: sql`MIN(${entries.created_at})`,
    })
    .from(entries)
    .where(
      and(
        isNotNull(entries.lot_id),
        or(
          eq(entries.to_account_id, accountId),
          eq(entries.from_account_id, accountId),
        ),
        itemIds && itemIds.length > 0 ? inArray(entries.item_id, itemIds) : undefined,
        asOfDate ? lte(entries.created_at, asOfDate) : undefined,
      )
    )
    .groupBy(entries.item_id, entries.lot_id)
    .having(
      sql`SUM(CASE WHEN ${entries.to_account_id} = ${accountId} THEN ${entries.quantity} ELSE -${entries.quantity} END) != 0`
    )
    .orderBy(sql`MIN(${entries.created_at})`);

  const result = await query;

  return result.map((row) => ({
    item_id: row.item_id!,
    lot_id: row.lot_id!,
    quantity: toDecimal(row.net_quantity as string),
    purity: row.purity ? toDecimal(row.purity as string) : null,
    average_touch: row.average_touch ? toDecimal(row.average_touch as string) : null,
    pure_quantity: row.net_pure_quantity ? toDecimal(row.net_pure_quantity as string) : null,
    created_at: new Date(row.created_at as string | Date),
  }));
}

export interface GoldsmithLotBalance {
  account_id: string;
  item_id: string;
  lot_id: string;
  quantity: Decimal;
  purity: Decimal | null;
  average_touch: Decimal | null;
  pure_quantity: Decimal | null;
  created_at: Date;
}

export async function getAllGoldsmithsLotBalances(
  itemIds?: string[],
  asOfDate?: Date,
): Promise<GoldsmithLotBalance[]> {
  const query = db
    .select({
      account_id: accounts.id,
      item_id: entries.item_id,
      lot_id: entries.lot_id,
      net_quantity: sql`SUM(CASE WHEN ${entries.to_account_id} = ${accounts.id} THEN ${entries.quantity} ELSE -${entries.quantity} END)::text`,
      purity: sql`MAX(${entries.purity})::text`,
      average_touch: sql`MAX(${entries.average_touch})::text`,
      net_pure_quantity: sql`SUM(CASE WHEN ${entries.to_account_id} = ${accounts.id} THEN ${entries.pure_quantity} ELSE -${entries.pure_quantity} END)::text`,
      created_at: sql`MIN(${entries.created_at})`,
    })
    .from(entries)
    .innerJoin(
      accounts,
      or(
        eq(entries.to_account_id, accounts.id),
        eq(entries.from_account_id, accounts.id)
      )
    )
    .where(
      and(
        isNotNull(entries.lot_id),
        or(
          eq(accounts.type, "GOLDSMITH"),
          eq(accounts.customer_type, "GOLD_SMITH")
        ),
        eq(accounts.is_deleted, false),
        itemIds && itemIds.length > 0 ? inArray(entries.item_id, itemIds) : undefined,
        asOfDate ? lte(entries.created_at, asOfDate) : undefined,
      )
    )
    .groupBy(accounts.id, entries.item_id, entries.lot_id)
    .having(
      sql`SUM(CASE WHEN ${entries.to_account_id} = ${accounts.id} THEN ${entries.quantity} ELSE -${entries.quantity} END) != 0`
    )
    .orderBy(sql`MIN(${entries.created_at})`);

  const result = await query;

  return result.map((row) => ({
    account_id: row.account_id,
    item_id: row.item_id!,
    lot_id: row.lot_id!,
    quantity: toDecimal(row.net_quantity as string),
    purity: row.purity ? toDecimal(row.purity as string) : null,
    average_touch: row.average_touch ? toDecimal(row.average_touch as string) : null,
    pure_quantity: row.net_pure_quantity ? toDecimal(row.net_pure_quantity as string) : null,
    created_at: new Date(row.created_at as string | Date),
  }));
}

// ─── Pooled Item Balance (no lot grouping) ────────────────────────────────────
// Used for pooled-stock mode: groups by item_id only, so all purchases of the
// same item type are merged into a single running total.

export interface AccountItemBalance {
  item_id: string;
  quantity: Decimal;
  purity: Decimal | null;
  average_touch: Decimal | null;
  pure_quantity: Decimal | null;
  created_at: Date;
}

/**
 * Returns net stock balance grouped by item_id only (no lot_id grouping).
 * All purchases of "92 Pure Gold" become one pool regardless of when they were bought.
 * lot_id is still stored in entries for audit — this query simply ignores it.
 */
export async function getAccountItemBalances(
  accountId: string,
  itemIds?: string[],
  asOfDate?: Date,
): Promise<AccountItemBalance[]> {
  const query = db
    .select({
      item_id: entries.item_id,
      net_quantity: sql`SUM(CASE WHEN ${entries.to_account_id} = ${accountId} THEN ${entries.quantity} ELSE -${entries.quantity} END)::text`,
      purity: sql`MAX(${entries.purity})::text`,
      average_touch: sql`MAX(${entries.average_touch})::text`,
      // Physical stock composition (quantity × purity), not the ledger's stored
      // pure_quantity — same fix as getAccountLotBalances above, see its comment.
      net_pure_quantity: sql`SUM(CASE WHEN ${entries.to_account_id} = ${accountId} THEN ${entries.quantity} * COALESCE(${entries.purity}, 0) / 100 ELSE -(${entries.quantity} * COALESCE(${entries.purity}, 0) / 100) END)::text`,
      created_at: sql`MIN(${entries.created_at})`,
    })
    .from(entries)
    .where(
      and(
        or(
          eq(entries.to_account_id, accountId),
          eq(entries.from_account_id, accountId),
        ),
        itemIds && itemIds.length > 0 ? inArray(entries.item_id, itemIds) : undefined,
        asOfDate ? lte(entries.created_at, asOfDate) : undefined,
      )
    )
    .groupBy(entries.item_id)
    .having(
      sql`SUM(CASE WHEN ${entries.to_account_id} = ${accountId} THEN ${entries.quantity} ELSE -${entries.quantity} END) != 0`
    )
    .orderBy(sql`MIN(${entries.created_at})`);

  const result = await query;

  return result.map((row) => ({
    item_id: row.item_id!,
    quantity: toDecimal(row.net_quantity as string),
    purity: row.purity ? toDecimal(row.purity as string) : null,
    average_touch: row.average_touch ? toDecimal(row.average_touch as string) : null,
    pure_quantity: row.net_pure_quantity ? toDecimal(row.net_pure_quantity as string) : null,
    created_at: new Date(row.created_at as string | Date),
  }));
}

