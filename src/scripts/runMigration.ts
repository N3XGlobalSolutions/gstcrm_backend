import { db } from "../db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("Adding gst_amount column to entry_groups table if it doesn't exist...");
  try {
    await db.execute(sql`
      ALTER TABLE "entry_groups" ADD COLUMN IF NOT EXISTS "gst_amount" numeric(20, 2) DEFAULT '0';
    `);
    console.log("Migration successful!");
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    process.exit(0);
  }
}

main();
