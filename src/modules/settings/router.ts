import { router, protectedProcedure, superadminProcedure } from "@/lib/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { eq, and, desc, count, ilike, sql } from "drizzle-orm";
import { generateEntryNo } from "@/lib/entryNoGenerator";
import { AppError } from "@/types/errors";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import crypto from "crypto";
import {
  appUsers,
  userFormPermissions,
  userActivityPermissions,
  companyDetails,
  taxMaster,
  accounts,
} from "@/db/schema";
import {
  ListTaxMasterSchema,
  CreateTaxMasterSchema,
  UpdateTaxMasterSchema,
  DeleteTaxMasterSchema,
} from "./schema";
import bcrypt from "bcryptjs";
import { env } from "@/config/env";
import { generateEntryNo as genNo } from "@/lib/entryNoGenerator";
import { createSystemNotification } from "@/modules/notifications/service";
import { writeAuditLog, diffFields, type AuditEntry } from "@/modules/logs/audit";
import { diffFormPermissions, diffActivityPermissions } from "@/modules/logs/helpers";

// ─── Audit helpers ────────────────────────────────────────────────────────────

type AuditCtx = {
  user: { id: string; username: string };
  ip?: string | null;
  userAgent?: string | null;
};

/** actor / ip / user agent of the caller, for writeAuditLog. */
function auditBy(ctx: AuditCtx): Pick<AuditEntry, "actor" | "ip" | "userAgent"> {
  return {
    actor: { id: ctx.user.id, username: ctx.user.username },
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  };
}

/** For changes that already happened outside a transaction: log, never fail the request. */
async function auditAfter(entry: AuditEntry): Promise<void> {
  try {
    await writeAuditLog(entry);
  } catch (err) {
    console.error(`[audit] Failed to write "${entry.action}":`, err);
  }
}

// ─── Users ────────────────────────────────────────────────────────────────────

const usersRouter = router({
  list: superadminProcedure.query(async () => {
    return db.select({
      id: appUsers.id,
      entry_no: appUsers.entry_no,
      username: appUsers.username,
      user_group: appUsers.user_group,
      is_deleted: appUsers.is_deleted,
      created_at: appUsers.created_at,
      updated_at: appUsers.updated_at,
    }).from(appUsers).where(eq(appUsers.is_deleted, false));
  }),

  create: superadminProcedure
    .input(z.object({ username: z.string().min(2), user_group: z.string(), password: z.string().min(6) }))
    .mutation(async ({ input, ctx }) => {
      const password_hash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS ?? 12);
      return db.transaction(async (tx) => {
        const entry_no = await genNo(tx, "app_users");
        const [user] = await tx.insert(appUsers).values({ entry_no, username: input.username, user_group: input.user_group, password_hash }).returning({ id: appUsers.id, username: appUsers.username, user_group: appUsers.user_group });

        await writeAuditLog({
          ...auditBy(ctx),
          action: "user_created",
          targetType: "user",
          targetId: user!.id,
          targetLabel: user!.username,
          changes: diffFields(null, { username: user!.username, user_group: user!.user_group }, ["username", "user_group"]),
        }, tx);

        await createSystemNotification(
          tx,
          `User '${input.username}' (${input.user_group}) was created by ${ctx.user.username}`,
          ctx.user.id
        );

        return user!;
      });
    }),

  changePassword: superadminProcedure
    .input(z.object({ id: z.string().uuid(), new_password: z.string().min(6), confirm_password: z.string().min(6), keyword: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      if (input.new_password !== input.confirm_password) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Passwords do not match",
        });
      }
      
      const [existing] = await db.select({ username: appUsers.username }).from(appUsers).where(eq(appUsers.id, input.id)).limit(1);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found",
        });
      }

      const isTargetAdmin = existing.username.toLowerCase() === 'superadmin';
      if (isTargetAdmin) {
        if (!input.keyword || input.keyword !== "goldcrmbyn3x") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid security keyword. Password change denied.",
          });
        }
      }

      const password_hash = await bcrypt.hash(input.new_password, env.BCRYPT_ROUNDS ?? 12);
      await db.transaction(async (tx) => {
        await tx.update(appUsers).set({ password_hash, updated_at: new Date() }).where(eq(appUsers.id, input.id));

        await writeAuditLog({
          ...auditBy(ctx),
          action: "password_reset_by_admin",
          targetType: "user",
          targetId: input.id,
          targetLabel: existing.username,
        }, tx);
      });

      await createSystemNotification(
        db,
        `Password was changed for user '${existing.username}' by ${ctx.user.username}`,
        ctx.user.id
      );

      return { success: true };
    }),

  delete: superadminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      await db.transaction(async (tx) => {
        const [existing] = await tx.select({ username: appUsers.username, is_deleted: appUsers.is_deleted }).from(appUsers).where(eq(appUsers.id, input.id)).limit(1);
        await tx.update(appUsers).set({ is_deleted: true, updated_at: new Date() }).where(eq(appUsers.id, input.id));

        if (existing && !existing.is_deleted) {
          await writeAuditLog({
            ...auditBy(ctx),
            action: "user_deleted",
            targetType: "user",
            targetId: input.id,
            targetLabel: existing.username,
          }, tx);
        }

        if (existing) {
          await createSystemNotification(
            tx,
            `User '${existing.username}' was deleted by ${ctx.user.username}`,
            ctx.user.id
          );
        }
      });

      return { success: true };
    }),
});

// ─── Permissions ──────────────────────────────────────────────────────────────

const permissionsRouter = router({
  getFormPermissions: protectedProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      if (ctx.user!.username.toLowerCase() !== "superadmin" && ctx.user!.id !== input.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to view other users' permissions.",
        });
      }
      return db.select().from(userFormPermissions).where(eq(userFormPermissions.user_id, input.userId));
    }),

  saveFormPermissions: superadminProcedure
    .input(z.object({ userId: z.string().uuid(), permissions: z.array(z.object({ module: z.string(), form_name: z.string(), allowed: z.boolean() })) }))
    .mutation(async ({ input, ctx }) => {
      await db.transaction(async (tx) => {
        const before = await tx
          .select({ module: userFormPermissions.module, form_name: userFormPermissions.form_name, allowed: userFormPermissions.allowed })
          .from(userFormPermissions)
          .where(eq(userFormPermissions.user_id, input.userId));

        // Delete existing permissions for this user, then insert fresh set
        await tx.delete(userFormPermissions).where(eq(userFormPermissions.user_id, input.userId));
        if (input.permissions.length > 0) {
          await tx.insert(userFormPermissions).values(
            input.permissions.map((perm) => ({
              user_id: input.userId,
              module: perm.module,
              form_name: perm.form_name,
              allowed: perm.allowed,
            })),
          );
        }

        // Audit only the forms that were switched on / off.
        const changes = diffFormPermissions(before, input.permissions);
        if (changes.length) {
          const [target] = await tx.select({ username: appUsers.username }).from(appUsers).where(eq(appUsers.id, input.userId)).limit(1);
          await writeAuditLog({
            ...auditBy(ctx),
            action: "form_permissions_changed",
            targetType: "permissions",
            targetId: input.userId,
            targetLabel: target?.username ?? null,
            changes,
          }, tx);
        }
      });
      return { success: true };
    }),

  getActivityPermissions: protectedProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      if (ctx.user!.username.toLowerCase() !== "superadmin" && ctx.user!.id !== input.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to view other users' permissions.",
        });
      }
      const [row] = await db.select().from(userActivityPermissions).where(eq(userActivityPermissions.user_id, input.userId)).limit(1);
      return row ?? { can_view: false, can_edit: false, can_delete: false };
    }),

  saveActivityPermissions: superadminProcedure
    .input(z.object({ userId: z.string().uuid(), can_view: z.boolean(), can_edit: z.boolean(), can_delete: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      await db.transaction(async (tx) => {
        const [before] = await tx
          .select({ can_view: userActivityPermissions.can_view, can_edit: userActivityPermissions.can_edit, can_delete: userActivityPermissions.can_delete })
          .from(userActivityPermissions)
          .where(eq(userActivityPermissions.user_id, input.userId))
          .limit(1);

        // Delete existing activity permissions for this user, then insert fresh
        await tx.delete(userActivityPermissions).where(eq(userActivityPermissions.user_id, input.userId));
        await tx.insert(userActivityPermissions).values({
          user_id: input.userId,
          can_view: input.can_view,
          can_edit: input.can_edit,
          can_delete: input.can_delete,
        });

        const changes = diffActivityPermissions(before, input);
        if (changes.length) {
          const [target] = await tx.select({ username: appUsers.username }).from(appUsers).where(eq(appUsers.id, input.userId)).limit(1);
          await writeAuditLog({
            ...auditBy(ctx),
            action: "activity_permissions_changed",
            targetType: "permissions",
            targetId: input.userId,
            targetLabel: target?.username ?? null,
            changes,
          }, tx);
        }
      });
      return { success: true };
    }),
});

// ─── Company ──────────────────────────────────────────────────────────────────

const companyRouter = router({
  get: protectedProcedure.query(async () => {
    const [row] = await db.select().from(companyDetails).limit(1);
    return row ?? null;
  }),

  update: superadminProcedure
    .input(z.object({
      company_name: z.string().optional(),
      address: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      gst_no: z.string().optional(),
      pan_no: z.string().optional(),
      logo_url: z.string().optional(),
      // New Fields
      businessName: z.string().optional(),
      addressLine1: z.string().optional(),
      city: z.string().optional(),
      pincode: z.string().optional(),
      state: z.string().optional(),
      stateCode: z.string().optional(),
      country: z.string().optional(),
      phoneNumber: z.string().optional(),
      gstin: z.string().optional(),
      panNumber: z.string().optional(),
      placeOfSupply: z.string().optional(),
      businessType: z.string().optional(),
      bank_details: z.string().optional(),
      defaultTdsPercent: z.string().optional(),
      defaultTcsPercent: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Keep old fields synced for compatibility
      const company_name = input.businessName || input.company_name || "";
      const phone = input.phoneNumber || input.phone;
      const gst_no = input.gstin || input.gst_no;
      const pan_no = input.panNumber || input.pan_no;
      
      let address = input.address;
      if (input.addressLine1) {
        address = `${input.addressLine1}, ${input.city || ""}${(input.city && input.pincode) ? " - " : ""}${input.pincode || ""}, ${input.state || ""}`;
      }

      const valuesToSave = {
        ...input,
        company_name,
        phone,
        gst_no,
        pan_no,
        address,
        updated_at: new Date()
      };

      return db.transaction(async (tx) => {
        const [existing] = await tx.select().from(companyDetails).limit(1);
        let row: typeof companyDetails.$inferSelect;
        if (existing) {
          [row] = (await tx.update(companyDetails).set(valuesToSave).where(eq(companyDetails.id, existing.id)).returning()) as [typeof companyDetails.$inferSelect];
        } else {
          [row] = (await tx.insert(companyDetails).values({
            ...valuesToSave,
            updated_at: new Date()
          }).returning()) as [typeof companyDetails.$inferSelect];
        }

        const changes = diffFields(existing ?? null, row, COMPANY_AUDIT_FIELDS);
        if (changes.length) {
          await writeAuditLog({
            ...auditBy(ctx),
            action: "company_details_changed",
            targetType: "company_details",
            targetId: row.id,
            targetLabel: row.businessName || row.company_name || "Company details",
            changes,
          }, tx);
        }
        return row;
      });
    }),
});

/** Company columns compared for the audit log (all user-editable ones). */
const COMPANY_AUDIT_FIELDS: (keyof typeof companyDetails.$inferSelect & string)[] = [
  "businessName",
  "company_name",
  "addressLine1",
  "address",
  "city",
  "pincode",
  "state",
  "stateCode",
  "country",
  "phoneNumber",
  "phone",
  "email",
  "gstin",
  "gst_no",
  "panNumber",
  "pan_no",
  "placeOfSupply",
  "businessType",
  "bank_details",
  "logo_url",
  "defaultTdsPercent",
  "defaultTcsPercent",
];

// ─── Backup ───────────────────────────────────────────────────────────────────

const backupRouter = router({
  create: superadminProcedure
    .input(
      z.object({
        from_date: z.string().optional(),
        to_date: z.string().optional(),
        modules: z.array(z.string()).optional(),
        format: z.enum(["JSON"]).optional(),
      }).optional()
    )
    .mutation(async ({ ctx }) => {
      // Get all table names in the public schema
      const tables = await db.execute(sql`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_type = 'BASE TABLE'
      `);

      let sqlDump = `-- Gold CRM Database SQL Dump\n-- Exported at: ${new Date().toISOString()}\n\n`;

      for (const table of tables) {
        const tableName = table.table_name as string;
        // Fetch all rows for the table dynamically
        const rows = await db.execute(sql.raw(`SELECT * FROM "${tableName}"`));
        
        if (rows.length === 0) continue;
        
        sqlDump += `-- Table: ${tableName}\n`;
        for (const row of rows) {
          const cols = Object.keys(row).map(k => `"${k}"`).join(", ");
          const vals = Object.values(row).map(v => {
            if (v === null) return "NULL";
            if (typeof v === "number" || typeof v === "boolean") return v;
            if (v instanceof Date) return `'${v.toISOString()}'`;
            // Escape single quotes for SQL string
            return `'${String(v).replace(/'/g, "''")}'`;
          }).join(", ");
          
          sqlDump += `INSERT INTO "${tableName}" (${cols}) VALUES (${vals});\n`;
        }
        sqlDump += `\n`;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `goldcrm_backup_${timestamp}.sql.enc`;

      // Encrypt the SQL dump
      const password = env.BACKUP_ENCRYPTION_PASSWORD;
      if (!password) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "BACKUP_ENCRYPTION_PASSWORD is not set in the environment.",
        });
      }

      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(16);
      const key = crypto.scryptSync(password, salt, 32);
      const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
      let encryptedHex = cipher.update(sqlDump, "utf8", "hex");
      encryptedHex += cipher.final("hex");
      
      const payload = `${salt.toString("hex")}:${iv.toString("hex")}:${encryptedHex}`;

      // Save a copy to the server's disk
      try {
        const dir = join(process.cwd(), "backups");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, filename), payload);
      } catch(e) {
        console.error("Failed to write backup to disk", e);
      }

      await auditAfter({
        ...auditBy(ctx),
        action: "backup_created",
        targetType: "settings",
        targetLabel: filename,
      });

      // Return the encrypted dump payload
      return { success: true, filename, data: payload };
    }),

  factoryReset: superadminProcedure
    .input(z.object({ keyword: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // 1. Verify Security Keyword
      if (input.keyword !== "goldcrmbyn3x") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid security keyword. Factory reset denied.",
        });
      }

      console.log(`🧹 Factory reset (transactions only) initiated by user '${ctx.user.username}'`);

      // 2. Wipe ONLY transactional data inside a single transaction.
      //
      //    DELETES: stock, all bills (purchase / sale / labour / job-work + GST
      //    history), expenses, and opening stock / opening balances.
      //    KEEPS: accounts (parties), items, users & permissions, company
      //    details, GST tax rates, print templates, and notifications.
      //
      //    Stock and expenses are not separate tables — they are derived from
      //    `entries` / `entry_groups`, so wiping those six tables clears
      //    everything the user asked to remove in one shot.
      await db.transaction(async (tx) => {
        // These tables hold every stock movement, bill, expense, and
        // opening entry. Melting entries post MELTING entry groups (0023) and
        // reference entry_groups, so they go too (CASCADE would take them
        // anyway) — the metals master is kept. `entries` and melting_entries
        // are the only children of `entry_groups`, so TRUNCATE ... CASCADE
        // is safe and self-contained.
        const tablesToWipe = [
          "melting_alloys",
          "melting_lines",
          "melting_entries",
          "entries",
          "entry_groups",
          "labour_bill_cycles",
          "job_work_cycles",
          "gst_sales_history",
          "gst_purchase_history",
        ];

        for (const table of tablesToWipe) {
          await tx.execute(sql.raw(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`));
          console.log(`✅ Table truncated: ${table}`);
        }

        // The OPENING entries (opening stock + opening balances) were deleted
        // above. Zero the stored reference columns on every account so they stay
        // consistent with the now-empty ledger (balances are computed from
        // entries, so all party balances are already 0).
        await tx.execute(
          sql`UPDATE accounts SET opening_pure_balance = '0', opening_cash_balance = '0'`
        );
        console.log(`✅ Account opening balances reset to zero`);

        await writeAuditLog({
          ...auditBy(ctx),
          action: "factory_reset",
          targetType: "settings",
          targetLabel: "Transactions wiped (master data kept)",
        }, tx);
      });

      console.log(`✅ Factory reset complete — master data preserved`);
      return { success: true };
    }),
});

// ─── Tax Master ──────────────────────────────────────────────────────────────

const taxMasterRouter = router({
  list: protectedProcedure
    .input(ListTaxMasterSchema)
    .query(async ({ input }) => {
      const conditions = [eq(taxMaster.is_deleted, false)];
      if (input.category) {
        conditions.push(eq(taxMaster.category, input.category));
      }
      return db
        .select()
        .from(taxMaster)
        .where(and(...conditions))
        .orderBy(desc(taxMaster.created_at));
    }),

  create: protectedProcedure
    .input(CreateTaxMasterSchema)
    .mutation(async ({ input, ctx }) => {
      return db.transaction(async (tx) => {
        const entry_no = await generateEntryNo(tx, "tax_master");
        const [newTax] = await tx
          .insert(taxMaster)
          .values({
            entry_no,
            category: input.category,
            name: input.name,
            code: input.code || null,
            percentage: input.percentage,
          })
          .returning();

        await writeAuditLog({
          ...auditBy(ctx),
          action: "tax_master_created",
          targetType: "tax_master",
          targetId: newTax!.id,
          targetLabel: newTax!.name,
          changes: diffFields(null, newTax!, TAX_AUDIT_FIELDS),
        }, tx);
        return newTax!;
      });
    }),

  update: protectedProcedure
    .input(UpdateTaxMasterSchema)
    .mutation(async ({ input, ctx }) => {
      return db.transaction(async (tx) => {
        const [existing] = await tx.select().from(taxMaster).where(eq(taxMaster.id, input.id)).limit(1);
        const [updated] = await tx
          .update(taxMaster)
          .set({
            name: input.name,
            code: input.code || null,
            percentage: input.percentage,
            updated_at: new Date(),
          })
          .where(eq(taxMaster.id, input.id))
          .returning();

        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Tax record not found",
          });
        }

        const changes = diffFields(existing ?? null, updated, TAX_AUDIT_FIELDS);
        if (changes.length) {
          await writeAuditLog({
            ...auditBy(ctx),
            action: "tax_master_changed",
            targetType: "tax_master",
            targetId: updated.id,
            targetLabel: updated.name,
            changes,
          }, tx);
        }
        return updated;
      });
    }),

  delete: protectedProcedure
    .input(DeleteTaxMasterSchema)
    .mutation(async ({ input, ctx }) => {
      return db.transaction(async (tx) => {
        const [existing] = await tx.select().from(taxMaster).where(eq(taxMaster.id, input.id)).limit(1);
        const [deleted] = await tx
          .update(taxMaster)
          .set({
            is_deleted: true,
            updated_at: new Date(),
          })
          .where(eq(taxMaster.id, input.id))
          .returning();

        if (!deleted) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Tax record not found",
          });
        }

        if (!existing?.is_deleted) {
          await writeAuditLog({
            ...auditBy(ctx),
            action: "tax_master_deleted",
            targetType: "tax_master",
            targetId: deleted.id,
            targetLabel: deleted.name,
            changes: diffFields(existing, null, TAX_AUDIT_FIELDS),
          }, tx);
        }
        return { success: true };
      });
    }),
});

const TAX_AUDIT_FIELDS: (keyof typeof taxMaster.$inferSelect & string)[] = ["category", "name", "code", "percentage"];

// ─── Settings root router ─────────────────────────────────────────────────────

export const settingsRouter = router({
  users: usersRouter,
  permissions: permissionsRouter,
  company: companyRouter,
  backup: backupRouter,
  taxMaster: taxMasterRouter,
});
