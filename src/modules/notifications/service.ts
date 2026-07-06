import { db } from "@/db";
import { notifications } from "@/db/schema";
import { generateEntryNo } from "@/lib/entryNoGenerator";

/**
 * Creates a system notification in the database.
 * Supports running within an active transaction if a transaction client (tx) is passed as dbInstance.
 */
export async function createSystemNotification(
  dbInstance: typeof db | any,
  message: string,
  createdByUserId: string
) {
  const entry_no = await generateEntryNo(dbInstance, "notifications");
  const [row] = await dbInstance
    .insert(notifications)
    .values({
      entry_no,
      message,
      created_by: createdByUserId,
      is_read: false,
    })
    .returning();
  return row!;
}

/**
 * Fire a "bill edited" notification for the super admin (the notifications list
 * is super-admin-only at read time). Best-effort: a failure here is logged but
 * never blocks the edit that already committed.
 */
export async function notifyBillEdited(
  billLabel: string,
  billNo: number | null | undefined,
  user: { id: string; username: string },
) {
  try {
    await createSystemNotification(
      db,
      `${billLabel} #${billNo ?? "-"} was edited by ${user.username}`,
      user.id,
    );
  } catch (err) {
    console.error(`Failed to create edit notification for ${billLabel}`, err);
  }
}
