// ─── expense/service.ts ───────────────────────────────────────────────────────
// NOTE: Expense CRUD (create/update/delete) is handled by the transactions
// module at src/modules/transactions/expense/ which uses the immutable ledger.
// This legacy file retains only notification helpers used by the settings router.

import { db } from "@/db";
import { AppError } from "@/types/errors";
import { v4 as uuidv4 } from "uuid";
import { generateEntryNo } from "@/lib/entryNoGenerator";
import * as q from "./queries";
import type {
  ListNotificationsInput,
  CreateNotificationInput,
  DeleteNotificationInput,
} from "./schema";

// ─── Notification ─────────────────────────────────────────────────────────────

export async function listNotifications(input: ListNotificationsInput) {
  return q.findManyNotifications(input);
}

export async function createNotification(
  input: CreateNotificationInput,
  userId: string,
) {
  const entry_no = await generateEntryNo(db, "notifications");
  const id = uuidv4();
  const [row] = await db
    .insert((await import("@/db/schema")).notifications)
    .values({ id, entry_no, message: input.message, created_by: userId })
    .returning();
  return row!;
}

export async function deleteNotification(input: DeleteNotificationInput) {
  const existing = await q.findNotificationById(input.id);
  if (!existing) throw new AppError("NOT_FOUND", "Notification not found.");
  await q.softDeleteNotification(input.id);
  return { success: true };
}
