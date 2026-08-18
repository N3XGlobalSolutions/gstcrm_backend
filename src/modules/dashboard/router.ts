import { router, protectedProcedure } from "@/lib/trpc";
import { z } from "zod";
import { db } from "@/db";
import { entries, entryGroups, notifications } from "@/db/schema";
import { eq, and, gte, lte, count, sql, desc } from "drizzle-orm";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";
import { resolveDateRange } from "@/lib/dateRange";

// ─── dashboard.getMetrics ─────────────────────────────────────────────────────

const MetricsSchema = z.object({
  range: z.enum(["today", "week", "month", "custom"]),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

async function getMetrics(input: z.infer<typeof MetricsSchema>) {
  // dashboard only uses today/week/month/custom, which always resolve to
  // concrete dates (never null), so the non-null assertion is safe here.
  const { from, to } = resolveDateRange(input) as { from: string; to: string };

  const [total_sales, total_purchase, total_stock_sales, total_job_work, total_labour_bill, total_expense] =
    await Promise.all([
      // Total sales (monetary value in ₹ of items sold). Gold-mode items value at
      // pure × rate; Cash-mode items carry pure_quantity = 0 with their cash value
      // recorded separately as a "Cash Sale Charge" MONEY entry (see createSale) —
      // both must be summed or cash-mode bills silently drop out of this total.
      db.execute<{ total: string }>(
        sql`SELECT COALESCE(SUM(
              CASE
                WHEN e.item_id != ${SYSTEM_ITEMS.RUPEE_ITEM_ID} THEN e.pure_quantity * COALESCE(e.rate, g.rate_per_gram, 0)
                WHEN e.item_id = ${SYSTEM_ITEMS.RUPEE_ITEM_ID} AND e.remarks = 'Cash Sale Charge' THEN e.quantity
                ELSE 0
              END
            ), 0)::text AS total
            FROM ${entries} e
            JOIN ${entryGroups} g ON e.group_id = g.id
            WHERE g.type = 'SALE' AND g.is_deleted = false
              AND e.from_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID}
              AND g.date BETWEEN ${from} AND ${to}`,
      ),
      // Total purchase (gold received, in pure grams). Computed as quantity × purity
      // directly rather than SUM(pure_quantity) — a Cash-mode purchase (see
      // createPurchase) deliberately zeroes pure_quantity on its item entries (the
      // gold balance isn't affected, only cash is), but the physical gold weight and
      // purity are still recorded, so quantity × purity still gives the true pure
      // content received regardless of which mode the bill was entered in.
      db.execute<{ total: string }>(
        sql`SELECT COALESCE(SUM(e.quantity * COALESCE(e.purity, 0) / 100), 0)::text AS total
            FROM ${entries} e
            JOIN ${entryGroups} g ON e.group_id = g.id
            WHERE g.type = 'PURCHASE' AND g.is_deleted = false
              AND e.to_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID}
              AND e.item_id != ${SYSTEM_ITEMS.RUPEE_ITEM_ID}
              AND g.date BETWEEN ${from} AND ${to}`,
      ),
      // Total stock sales (gold/ornament grams dispatched). Must exclude RUPEE_ITEM_ID —
      // without this filter, a Cash-mode sale's "Cash Sale Charge" MONEY entry (whose
      // quantity is a rupee amount, not grams) gets summed straight into this gram total.
      db.execute<{ total: string }>(
        sql`SELECT COALESCE(SUM(e.quantity), 0)::text AS total
            FROM ${entries} e
            JOIN ${entryGroups} g ON e.group_id = g.id
            WHERE g.type = 'SALE' AND g.is_deleted = false
              AND e.from_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID}
              AND e.item_id != ${SYSTEM_ITEMS.RUPEE_ITEM_ID}
              AND g.date BETWEEN ${from} AND ${to}`,
      ),
      // Total job work count
      db.select({ total: count() }).from(entryGroups).where(
        and(eq(entryGroups.type, "JOB_WORK"), eq(entryGroups.is_deleted, false),
            gte(entryGroups.date, from), lte(entryGroups.date, to)),
      ),
      // Total labour bill (pure)
      db.execute<{ total: string }>(
        sql`SELECT COALESCE(SUM(e.pure_quantity), 0)::text AS total
            FROM ${entries} e
            JOIN ${entryGroups} g ON e.group_id = g.id
            WHERE g.type = 'LABOUR_BILL' AND g.is_deleted = false
              AND g.date BETWEEN ${from} AND ${to}`,
      ),
      // Total expense
      db.execute<{ total: string }>(
        sql`SELECT COALESCE(SUM(e.quantity), 0)::text AS total
            FROM ${entries} e
            JOIN ${entryGroups} g ON e.group_id = g.id
            WHERE g.type = 'EXPENSE' AND g.is_deleted = false
              AND e.item_id = ${SYSTEM_ITEMS.RUPEE_ITEM_ID}
              AND g.date BETWEEN ${from} AND ${to}`,
      ),
    ]);

  // Apply system-wide precision rules at the API boundary:
  // Cash amounts → 2dp | Gold weights (pure grams) → 3dp
  const fmt2 = (raw: string | undefined) =>
    parseFloat(raw ?? '0').toFixed(2);
  const fmt3 = (raw: string | undefined) =>
    parseFloat(raw ?? '0').toFixed(3);

  return {
    range: { from, to },
    total_sales:       fmt2((total_sales      as any)[0]?.total),   // cash ₹ → 2dp
    total_purchase:    fmt3((total_purchase   as any)[0]?.total),   // gold pure grams → 3dp
    total_stock_sales: fmt3((total_stock_sales as any)[0]?.total),  // gold grams dispatched → 3dp
    total_job_work:    (total_job_work as any)[0]?.total ?? 0,      // count — no rounding
    total_labour_bill: fmt3((total_labour_bill as any)[0]?.total),  // pure grams → 3dp
    total_expense:     fmt2((total_expense    as any)[0]?.total),   // cash ₹ → 2dp
  };
}

// ─── dashboard.getNotifications ───────────────────────────────────────────────

async function getNotifications() {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.is_deleted, false))
    .orderBy(desc(notifications.created_at))
    .limit(5);
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const dashboardRouter = router({
  getMetrics: protectedProcedure.input(MetricsSchema).query(async ({ input }) => getMetrics(input)),
  getNotifications: protectedProcedure.query(async () => getNotifications()),
});
