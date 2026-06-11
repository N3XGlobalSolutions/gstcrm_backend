import { db } from "@/db";
import { appUsers, userFormPermissions, userActivityPermissions } from "@/db/schema";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";

async function inject() {
  console.log("Starting injection...");
  try {
    const passwordHash = await bcrypt.hash("Hello@2026", 12);
    
    // Get next entry_no
    const result = await db.execute(sql`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM app_users`);
    const nextEntryNo = Number(result[0]?.next_entry_no || 1);

    const [inserted] = await db
      .insert(appUsers)
      .values({
        entry_no: nextEntryNo,
        username: "superadmin",
        password_hash: passwordHash,
        user_group: "admin",
      })
      .returning({ id: appUsers.id });

    const adminUserId = inserted!.id;

    // Grant all activity permissions
    await db.insert(userActivityPermissions).values({
      user_id: adminUserId,
      can_view: true,
      can_edit: true,
      can_delete: true,
    });

    console.log("✅ Custom user injected successfully!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error injecting user:", err);
    process.exit(1);
  }
}

inject();
