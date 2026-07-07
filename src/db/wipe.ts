import { db } from "@/db";
import { sql } from "drizzle-orm";

async function wipe() {
  console.log("🧹 Wiping all database tables...");

  const tables = [
    "entries",
    "entry_groups",
    "labour_bill_cycles",
    "gst_sales_history",
    "gst_purchase_history",
    "items",
    "accounts",
    "user_form_permissions",
    "user_activity_permissions",
    "print_templates",
    "company_details",
    "tax_master",
    "notifications",
    "auth_audit",
    "refresh_tokens",
    "app_users",
  ];

  for (const table of tables) {
    try {
      await db.execute(sql.raw(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`));
      console.log(`✅ Table truncated: ${table}`);
    } catch (error: any) {
      console.warn(`⚠️ Could not truncate table ${table}:`, error.message);
    }
  }

  console.log("🧹 Wipe completed.");
  process.exit(0);
}

wipe().catch((err) => {
  console.error("❌ Wipe failed:", err);
  process.exit(1);
});
