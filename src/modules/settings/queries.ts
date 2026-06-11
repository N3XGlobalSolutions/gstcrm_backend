import { db } from "@/db";
import {
  companyDetails,
  appUsers,
  userFormPermissions,
  userActivityPermissions,
  printTemplates,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import type { Database } from "@/db";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

// ─── Company ──────────────────────────────────────────────────────────────────

export async function getCompanyDetails() {
  const [row] = await db.select().from(companyDetails).limit(1);
  return row ?? null;
}

export async function upsertCompanyDetails(
  data: Partial<typeof companyDetails.$inferInsert>,
) {
  const existing = await getCompanyDetails();
  if (existing) {
    const [row] = await db
      .update(companyDetails)
      .set({ ...data, updated_at: new Date() })
      .where(eq(companyDetails.id, existing.id))
      .returning();
    return row!;
  }
  const { v4: uuidv4 } = await import("uuid");
  const [row] = await db
    .insert(companyDetails)
    .values({ id: uuidv4(), ...data })
    .returning();
  return row!;
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function findAllUsers() {
  return db
    .select({
      id: appUsers.id,
      entry_no: appUsers.entry_no,
      username: appUsers.username,
      user_group: appUsers.user_group,
      created_at: appUsers.created_at,
      is_deleted: appUsers.is_deleted,
    })
    .from(appUsers)
    .where(eq(appUsers.is_deleted, false));
}

export async function findUserById(id: string) {
  const [row] = await db
    .select()
    .from(appUsers)
    .where(and(eq(appUsers.id, id), eq(appUsers.is_deleted, false)));
  return row ?? null;
}

export async function findUserByUsername(username: string) {
  const [row] = await db
    .select()
    .from(appUsers)
    .where(
      and(eq(appUsers.username, username), eq(appUsers.is_deleted, false)),
    );
  return row ?? null;
}

export async function insertUser(tx: Tx, data: typeof appUsers.$inferInsert) {
  const [row] = await tx.insert(appUsers).values(data).returning();
  return row!;
}

export async function updateUserPasswordHash(id: string, passwordHash: string) {
  const [row] = await db
    .update(appUsers)
    .set({ password_hash: passwordHash, updated_at: new Date() })
    .where(eq(appUsers.id, id))
    .returning();
  return row!;
}

export async function softDeleteUser(id: string) {
  await db
    .update(appUsers)
    .set({ is_deleted: true })
    .where(eq(appUsers.id, id));
}

// ─── Form Permissions ─────────────────────────────────────────────────────────

export async function getFormPermissions(userId: string) {
  return db
    .select()
    .from(userFormPermissions)
    .where(eq(userFormPermissions.user_id, userId));
}

export async function upsertFormPermissions(
  userId: string,
  permissions: Array<{ module: string; form_name: string; allowed: boolean }>,
) {
  // Delete existing permissions for this user, then re-insert
  await db
    .delete(userFormPermissions)
    .where(eq(userFormPermissions.user_id, userId));
  if (permissions.length === 0) return [];
  const { v4: uuidv4 } = await import("uuid");
  return db
    .insert(userFormPermissions)
    .values(
      permissions.map((p) => ({
        id: uuidv4(),
        user_id: userId,
        module: p.module,
        form_name: p.form_name,
        allowed: p.allowed,
      })),
    )
    .returning();
}

// ─── Activity Permissions ─────────────────────────────────────────────────────

export async function getActivityPermissions(userId: string) {
  const [row] = await db
    .select()
    .from(userActivityPermissions)
    .where(eq(userActivityPermissions.user_id, userId));
  return row ?? null;
}

export async function upsertActivityPermissions(
  userId: string,
  data: { can_view: boolean; can_edit: boolean; can_delete: boolean },
) {
  const existing = await getActivityPermissions(userId);
  if (existing) {
    const [row] = await db
      .update(userActivityPermissions)
      .set(data)
      .where(eq(userActivityPermissions.user_id, userId))
      .returning();
    return row!;
  }
  const { v4: uuidv4 } = await import("uuid");
  const [row] = await db
    .insert(userActivityPermissions)
    .values({ id: uuidv4(), user_id: userId, ...data })
    .returning();
  return row!;
}

// ─── Print Templates ──────────────────────────────────────────────────────────

export async function findAllPrintTemplates() {
  return db
    .select()
    .from(printTemplates)
    .where(eq(printTemplates.status, true));
}

export async function findPrintTemplateById(id: string) {
  const [row] = await db
    .select()
    .from(printTemplates)
    .where(eq(printTemplates.id, id));
  return row ?? null;
}

export async function insertPrintTemplate(
  tx: Tx,
  data: typeof printTemplates.$inferInsert,
) {
  const [row] = await tx.insert(printTemplates).values(data).returning();
  return row!;
}

export async function updatePrintTemplate(
  id: string,
  data: Partial<typeof printTemplates.$inferInsert>,
) {
  const [row] = await db
    .update(printTemplates)
    .set(data)
    .where(eq(printTemplates.id, id))
    .returning();
  return row!;
}

export async function softDeletePrintTemplate(id: string) {
  await db
    .update(printTemplates)
    .set({ status: false })
    .where(eq(printTemplates.id, id));
}
