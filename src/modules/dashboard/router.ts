import { router, protectedProcedure } from "@/lib/trpc";
import { z } from "zod";
import { db } from "@/db";
import { entries, entryGroups, notifications } from "@/db/schema";
import { eq, and, gte, lte, count, sql, desc } from "drizzle-orm";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";

// ─── dashboard.getMetrics ─────────────────────────────────────────────────────

const MetricsSchema = z.object({
  range: z.enum(["today", "week", "month", "custom"]),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

async function getDateRange(input: z.infer<typeof MetricsSchema>) {
  const now = new Date();
  if (input.range === "today") {
    const d = now.toISOString().split("T")[0]!;
    return { from: d, to: d };
  }
  if (input.range === "week") {
    const from = new Date(now);
    from.setDate(from.getDate() - 7);
    return { from: from.toISOString().split("T")[0]!, to: now.toISOString().split("T")[0]! };
  }
  if (input.range === "month") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: from.toISOString().split("T")[0]!, to: now.toISOString().split("T")[0]! };
  }
  return {
    from: input.from_date ?? now.toISOString().split("T")[0]!,
    to: input.to_date ?? now.toISOString().split("T")[0]!,
  };
}

async function getMetrics(input: z.infer<typeof MetricsSchema>) {
  const { from, to } = await getDateRange(input);

  const [total_sales, total_purchase, total_stock_sales, total_job_work, total_labour_bill, total_expense] =
    await Promise.all([
      // Total sales (money received from customers)
      db.execute<{ total: string }>(
        sql`SELECT COALESCE(SUM(e.quantity), 0)::text AS total
            FROM ${entries} e
            JOIN ${entryGroups} g ON e.group_id = g.id
            WHERE g.type = 'SALE' AND g.is_deleted = false
              AND e.to_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID}
              AND e.item_id = ${SYSTEM_ITEMS.RUPEE_ITEM_ID}
              AND g.date BETWEEN ${from} AND ${to}`,
      ),
      // Total purchase (gold received)
      db.execute<{ total: string }>(
        sql`SELECT COALESCE(SUM(e.pure_quantity), 0)::text AS total
            FROM ${entries} e
            JOIN ${entryGroups} g ON e.group_id = g.id
            WHERE g.type = 'PURCHASE' AND g.is_deleted = false
              AND e.to_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID}
              AND e.item_id != ${SYSTEM_ITEMS.RUPEE_ITEM_ID}
              AND g.date BETWEEN ${from} AND ${to}`,
      ),
      // Total stock sales (items dispatched)
      db.execute<{ total: string }>(
        sql`SELECT COALESCE(SUM(e.quantity), 0)::text AS total
            FROM ${entries} e
            JOIN ${entryGroups} g ON e.group_id = g.id
            WHERE g.type = 'SALE' AND g.is_deleted = false
              AND e.from_account_id = ${SYSTEM_ACCOUNTS.SHOP_ID}
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

  return {
    range: { from, to },
    total_sales: (total_sales as any)[0]?.total ?? "0",
    total_purchase: (total_purchase as any)[0]?.total ?? "0",
    total_stock_sales: (total_stock_sales as any)[0]?.total ?? "0",
    total_job_work: (total_job_work as any)[0]?.total ?? 0,
    total_labour_bill: (total_labour_bill as any)[0]?.total ?? "0",
    total_expense: (total_expense as any)[0]?.total ?? "0",
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
