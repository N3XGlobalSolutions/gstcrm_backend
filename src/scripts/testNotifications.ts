import { db } from "@/db";
import { notifications } from "@/db/schema";
import { and, eq, count, ilike, not } from "drizzle-orm";

async function testNotifications() {
  try {
    const [countRow] = await db
      .select({ total: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.is_read, false),
          eq(notifications.is_deleted, false),
          not(ilike(notifications.message, "%converted%to GST%"))
        )
      );
    console.log("Count query returned:", countRow);
    process.exit(0);
  } catch (err) {
    console.error("Query failed with error:", err);
    process.exit(1);
  }
}

testNotifications();
