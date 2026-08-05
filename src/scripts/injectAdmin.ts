import { db } from "@/db";
import { appUsers, userFormPermissions, userActivityPermissions } from "@/db/schema";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";

const MODULES_FORMS: Array<{ module: string; form_name: string }> = [
  { module: "dashboard", form_name: "dashboard" },
  { module: "notifications", form_name: "notifications" },
  { module: "items", form_name: "items" },
  { module: "accounts", form_name: "accounts" },
  { module: "transactions", form_name: "purchase" },
  { module: "transactions", form_name: "sales" },
  { module: "transactions", form_name: "labourBill" },
  { module: "transactions", form_name: "jobWork" },
  { module: "stock", form_name: "stock" },
  { module: "expense", form_name: "expense" },
  { module: "settings", form_name: "users" },
  { module: "settings", form_name: "permissions" },
  { module: "settings", form_name: "backup" },
  { module: "settings", form_name: "company" },
];

async function inject() {
  console.log("Starting superadmin injection/update...");
  try {
    const passwordHash = await bcrypt.hash("Hello@2026", 12);
    
    // Check if superadmin already exists
    const [existing] = await db
      .select()
      .from(appUsers)
      .where(eq(appUsers.username, "superadmin"))
      .limit(1);

    let superadminId: string;

    if (existing) {
      console.log(`Found existing superadmin user (ID: ${existing.id}). Updating password and status...`);
      await db
        .update(appUsers)
        .set({
          password_hash: passwordHash,
          user_group: "admin",
          is_deleted: false,
          updated_at: new Date(),
        })
        .where(eq(appUsers.id, existing.id));
      superadminId = existing.id;
    } else {
      console.log("Superadmin user not found. Creating new superadmin user...");
      const result = await db.execute(sql`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM app_users`);
      const nextEntryNo = Number(result[0]?.next_entry_no || 1);

      const [inserted] = await db
        .insert(appUsers)
        .values({
          entry_no: nextEntryNo,
          username: "superadmin",
          password_hash: passwordHash,
          user_group: "admin",
          is_deleted: false,
        })
        .returning({ id: appUsers.id });

      superadminId = inserted!.id;
    }

    // Grant all form permissions
    for (const perm of MODULES_FORMS) {
      await db
        .insert(userFormPermissions)
        .values({
          user_id: superadminId,
          module: perm.module,
          form_name: perm.form_name,
          allowed: true,
        })
        .onConflictDoNothing();
    }

    // Grant activity permissions
    const [existingActPerm] = await db
      .select()
      .from(userActivityPermissions)
      .where(eq(userActivityPermissions.user_id, superadminId))
      .limit(1);

    if (existingActPerm) {
      await db
        .update(userActivityPermissions)
        .set({
          can_view: true,
          can_edit: true,
          can_delete: true,
        })
        .where(eq(userActivityPermissions.user_id, superadminId));
    } else {
      await db.insert(userActivityPermissions).values({
        user_id: superadminId,
        can_view: true,
        can_edit: true,
        can_delete: true,
      });
    }

    console.log("✅ Superadmin user upserted successfully!");
    console.log(`Username: superadmin`);
    console.log(`Password: Hello@2026`);
    console.log(`User ID: ${superadminId}`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Error setting superadmin user:", err);
    process.exit(1);
  }
}

inject();

