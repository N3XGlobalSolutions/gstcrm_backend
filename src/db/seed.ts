import { db } from "@/db";
import {
  appUsers,
  accounts,
  items,
  userFormPermissions,
  userActivityPermissions,
  companyDetails,
} from "@/db/schema";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { SYSTEM_ACCOUNTS, SYSTEM_ITEMS } from "@/config/constants";

// ─── Modules and forms for admin permissions ──────────────────────────────────

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

async function seed() {
  console.log("🌱 Starting seed...");

  // ── 1. System accounts ────────────────────────────────────────────────────
  const systemAccountsToCreate = [
    {
      id: SYSTEM_ACCOUNTS.SHOP_ID,
      name: "Shop",
      type: "SHOP" as const,
    },
    {
      id: SYSTEM_ACCOUNTS.CASH_ID,
      name: "Cash",
      type: "CASH" as const,
    },
    {
      id: SYSTEM_ACCOUNTS.BANK_ID,
      name: "Bank",
      type: "BANK" as const,
    },
    {
      id: SYSTEM_ACCOUNTS.LOSS_ID,
      name: "Loss / Wastage",
      type: "LOSS" as const,
    },
    {
      id: SYSTEM_ACCOUNTS.EXPENSE_ID,
      name: "General Expense",
      type: "EXPENSE" as const,
    },
    {
      id: SYSTEM_ACCOUNTS.OPENING_STOCK_ID,
      name: "Opening Stock",
      type: "OPENING_STOCK" as const,
    },
  ];

  for (let i = 0; i < systemAccountsToCreate.length; i++) {
    const acc = systemAccountsToCreate[i]!;
    const existing = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, acc.id))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(accounts).values({
        id: acc.id,
        entry_no: 1000000 + i + 1,
        name: acc.name,
        type: acc.type,
        is_system_account: true,
      });
      console.log(`✅ System account created: ${acc.name}`);
    } else {
      console.log(`ℹ️  System account already exists: ${acc.name}`);
    }
  }

  // ── 2. System item — RUPEE ─────────────────────────────────────────────────
  const existingRupee = await db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.id, SYSTEM_ITEMS.RUPEE_ITEM_ID))
    .limit(1);

  if (existingRupee.length === 0) {
    await db.insert(items).values({
      id: SYSTEM_ITEMS.RUPEE_ITEM_ID,
      entry_no: 1000001,
      name: "Rupee",
      type: "MONEY",
      unit: "RUPEE",
    });
    console.log("✅ RUPEE system item created");
  } else {
    console.log("ℹ️  RUPEE item already exists");
  }

  // ── 3. Admin user ─────────────────────────────────────────────────────────
  const [existingAdmin] = await db
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(eq(appUsers.username, "superadmin"))
    .limit(1);

  let adminUserId: string;

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash("Hello@2026", 12);
    const [inserted] = await db
      .insert(appUsers)
      .values({
        entry_no: 1,
        username: "superadmin",
        password_hash: passwordHash,
        user_group: "admin",
      })
      .returning({ id: appUsers.id });

    adminUserId = inserted!.id;
    console.log("✅ Superadmin user created");
  } else {
    adminUserId = existingAdmin.id;
    console.log("ℹ️  Superadmin user already exists");
  }

  // ── 4. Admin form permissions ─────────────────────────────────────────────
  for (const perm of MODULES_FORMS) {
    await db
      .insert(userFormPermissions)
      .values({
        user_id: adminUserId,
        module: perm.module,
        form_name: perm.form_name,
        allowed: true,
      })
      .onConflictDoNothing();
  }
  console.log("✅ Form permissions seeded");

  // ── 5. Admin activity permissions ─────────────────────────────────────────
  await db
    .insert(userActivityPermissions)
    .values({
      user_id: adminUserId,
      can_view: true,
      can_edit: true,
      can_delete: true,
    })
    .onConflictDoNothing();
  console.log("✅ Activity permissions seeded");

  // ── 6. Placeholder company details ────────────────────────────────────────
  const [existingCompany] = await db.select().from(companyDetails).limit(1);
  if (!existingCompany) {
    await db.insert(companyDetails).values({
      company_name: "Gold Jewellers",
      address: "",
      phone: "",
      email: "",
      gst_no: "",
      pan_no: "",
    });
    console.log("✅ Company details seeded");
  } else {
    console.log("ℹ️  Company details already exist");
  }

  console.log("🌱 Seed complete.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
