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
