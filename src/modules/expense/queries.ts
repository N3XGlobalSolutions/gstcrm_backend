// ─── expense/queries.ts ───────────────────────────────────────────────────────
// NOTE: Expenses in this system are stored as entry_groups (type = EXPENSE)
// in the immutable ledger — there is no dedicated expenses table.
// All expense reads should use getBalance / listTransactions from lib.
// This file is retained only for the notification queries used by the
// pre-existing settings module.

import { db } from "@/db";
import { notifications } from "@/db/schema";
import { eq, and, desc, count } from "drizzle-orm";

// ─── Notification queries ─────────────────────────────────────────────────────

export async function findManyNotifications(params: {
  page: number;
  limit: number;
}) {
  const { page, limit } = params;
  const offset = (page - 1) * limit;

  const where = eq(notifications.is_deleted, false);

  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.created_at))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(notifications).where(where),
  ]);

  return { data, total: countRow?.total ?? 0 };
}

export async function findNotificationById(id: string) {
  const [row] = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.is_deleted, false)));
  return row ?? null;
}

export async function softDeleteNotification(id: string) {
  await db
    .update(notifications)
    .set({ is_deleted: true })
    .where(eq(notifications.id, id));
}
