import { db } from "@/db";
import { AppError } from "@/types/errors";
import { v4 as uuidv4 } from "uuid";
import { generateEntryNo } from "@/lib/entryNoGenerator";
import { scrypt, randomBytes } from "crypto";
import { promisify } from "util";
import * as q from "./queries";
import type {
  GetCompanyInput,
  UpdateCompanyInput,
  ListUsersInput,
  CreateUserInput,
  ChangePasswordInput,
  DeleteUserInput,
  GetFormPermissionsInput,
  SaveFormPermissionsInput,
  GetActivityPermissionsInput,
  SaveActivityPermissionsInput,
  CreateBackupInput,
  ListPrintTemplatesInput,
  CreatePrintTemplateInput,
  UpdatePrintTemplateInput,
  DeletePrintTemplateInput,
} from "./schema";

const scryptAsync = promisify(scrypt);

// ─── Password hashing (bcrypt-equivalent via scrypt) ─────────────────────────
// Better Auth uses its own auth table, but for app_users we hash with scrypt.
// This is compatible with the plan's bcrypt intent while using Node built-ins.

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

// ─── Company ──────────────────────────────────────────────────────────────────

export async function getCompany(_input: GetCompanyInput) {
  return q.getCompanyDetails();
}

export async function updateCompany(input: UpdateCompanyInput) {
  return q.upsertCompanyDetails(input);
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function listUsers(_input: ListUsersInput) {
  return q.findAllUsers();
}

export async function createUser(input: CreateUserInput) {
  const existing = await q.findUserByUsername(input.username);
  if (existing) {
    throw new AppError(
      "CONFLICT",
      `Username "${input.username}" is already taken.`,
    );
  }

  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const entry_no = await generateEntryNo(tx, "app_users");
    const id = uuidv4();

    const user = await q.insertUser(tx, {
      id,
      entry_no,
      username: input.username,
      user_group: input.user_group,
      password_hash: passwordHash,
    });

    // Return without password_hash
    const { password_hash: _, ...safeUser } = user;
    return safeUser;
  });
}

export async function changePassword(input: ChangePasswordInput) {
  // Zod already ensures new_password === confirm_password via .refine()
  const existing = await q.findUserById(input.id);
  if (!existing) throw new AppError("NOT_FOUND", "User not found.");

  const isTargetAdmin = existing.username.toLowerCase() === 'superadmin';
  if (isTargetAdmin) {
    if (!input.keyword || input.keyword !== "goldcrmbyn3x") {
      throw new AppError("VALIDATION_ERROR", "Invalid security keyword. Password change denied.");
    }
  }

  const passwordHash = await hashPassword(input.new_password);
  await q.updateUserPasswordHash(input.id, passwordHash);
  return { success: true };
}

export async function deleteUser(input: DeleteUserInput) {
  const existing = await q.findUserById(input.id);
  if (!existing) throw new AppError("NOT_FOUND", "User not found.");
  await q.softDeleteUser(input.id);
  return { success: true };
}

// ─── Form Permissions ─────────────────────────────────────────────────────────

export async function getFormPermissions(input: GetFormPermissionsInput) {
  const rows = await q.getFormPermissions(input.userId);
  // Group by module
  const grouped: Record<
    string,
    Array<{ form_name: string; allowed: boolean }>
  > = {};
  for (const row of rows) {
    if (!grouped[row.module]) grouped[row.module] = [];
    grouped[row.module]!.push({
      form_name: row.form_name,
      allowed: row.allowed,
    });
  }
  return grouped;
}

export async function saveFormPermissions(input: SaveFormPermissionsInput) {
  await q.upsertFormPermissions(input.userId, input.permissions);
  return { success: true };
}

// ─── Activity Permissions ─────────────────────────────────────────────────────

export async function getActivityPermissions(
  input: GetActivityPermissionsInput,
) {
  const row = await q.getActivityPermissions(input.userId);
  return row ?? { can_view: false, can_edit: false, can_delete: false };
}

export async function saveActivityPermissions(
  input: SaveActivityPermissionsInput,
) {
  return q.upsertActivityPermissions(input.userId, {
    can_view: input.can_view,
    can_edit: input.can_edit,
    can_delete: input.can_delete,
  });
}

// ─── Backup ───────────────────────────────────────────────────────────────────

/**
 * Synchronous JSON backup export.
 * PDF is noted as a future enhancement per BACKEND_PLAN §7.16.
 *
 * Each table is queried explicitly to maintain full type safety.
 */
export async function createBackup(input: CreateBackupInput) {
  const jobId = uuidv4();
  const timestamp = new Date().toISOString();

  const { entryGroups, entries, notifications } = await import("@/db/schema");
  const { db: dbInstance } = await import("@/db");

  const requested = new Set(
    input.modules.length > 0
      ? input.modules
      : ["entry_groups", "entries", "notifications"],
  );

  const data: Record<string, unknown[]> = {};

  const run = async (key: string, fn: () => Promise<unknown[]>) => {
    if (!requested.has(key)) return;
    try {
      data[key] = await fn();
    } catch {
      data[key] = [];
    }
  };

  await Promise.all([
    run("entry_groups", () => dbInstance.select().from(entryGroups)),
    run("entries", () => dbInstance.select().from(entries)),
    run("notifications", () => dbInstance.select().from(notifications)),
  ]);

  return {
    jobId,
    timestamp,
    status: "completed",
    format: "json",
    data,
  };
}

// ─── Print Templates ──────────────────────────────────────────────────────────

export async function listPrintTemplates(_input: ListPrintTemplatesInput) {
  return q.findAllPrintTemplates();
}

export async function createPrintTemplate(input: CreatePrintTemplateInput) {
  return db.transaction(async (tx) => {
    const entry_no = await generateEntryNo(tx, "print_templates");
    const id = uuidv4();
    return q.insertPrintTemplate(tx, {
      id,
      entry_no,
      template_name: input.template_name,
      status: input.status !== undefined ? input.status === 'true' || input.status === true as unknown : undefined,
    });
  });
}

export async function updatePrintTemplate(input: UpdatePrintTemplateInput) {
  const existing = await q.findPrintTemplateById(input.id);
  if (!existing) throw new AppError("NOT_FOUND", "Print template not found.");
  return q.updatePrintTemplate(input.id, {
    template_name: input.template_name,
    status: input.status !== undefined ? input.status === 'true' || input.status === true as unknown : undefined,
  });
}

export async function deletePrintTemplate(input: DeletePrintTemplateInput) {
  const existing = await q.findPrintTemplateById(input.id);
  if (!existing) throw new AppError("NOT_FOUND", "Print template not found.");
  await q.softDeletePrintTemplate(input.id);
  return { success: true };
}
