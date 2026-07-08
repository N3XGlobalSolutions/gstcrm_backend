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
      const entry_no = await genNo(db, "app_users");
      const password_hash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS ?? 12);
      const [user] = await db.insert(appUsers).values({ entry_no, username: input.username, user_group: input.user_group, password_hash }).returning({ id: appUsers.id, username: appUsers.username, user_group: appUsers.user_group });
      
      await createSystemNotification(
        db,
        `User '${input.username}' (${input.user_group}) was created by ${ctx.user.username}`,
        ctx.user.id
      );

      return user!;
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
      await db.update(appUsers).set({ password_hash, updated_at: new Date() }).where(eq(appUsers.id, input.id));
      
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
      const [existing] = await db.select({ username: appUsers.username }).from(appUsers).where(eq(appUsers.id, input.id)).limit(1);
      await db.update(appUsers).set({ is_deleted: true, updated_at: new Date() }).where(eq(appUsers.id, input.id));
      
      if (existing) {
        await createSystemNotification(
          db,
          `User '${existing.username}' was deleted by ${ctx.user.username}`,
          ctx.user.id
        );
      }

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
    .mutation(async ({ input }) => {
      // Delete existing permissions for this user, then insert fresh set
      await db.delete(userFormPermissions).where(eq(userFormPermissions.user_id, input.userId));
      if (input.permissions.length > 0) {
        await db.insert(userFormPermissions).values(
          input.permissions.map((perm) => ({
            user_id: input.userId,
            module: perm.module,
            form_name: perm.form_name,
            allowed: perm.allowed,
          })),
        );
      }
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
    .mutation(async ({ input }) => {
      // Delete existing activity permissions for this user, then insert fresh
      await db.delete(userActivityPermissions).where(eq(userActivityPermissions.user_id, input.userId));
      await db.insert(userActivityPermissions).values({
        user_id: input.userId,
        can_view: input.can_view,
        can_edit: input.can_edit,
        can_delete: input.can_delete,
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
    }))
    .mutation(async ({ input }) => {
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

      const [existing] = await db.select({ id: companyDetails.id }).from(companyDetails).limit(1);
      if (existing) {
        const [row] = await db.update(companyDetails).set(valuesToSave).where(eq(companyDetails.id, existing.id)).returning();
        return row!;
      }
      const [row] = await db.insert(companyDetails).values({
        ...valuesToSave,
        updated_at: new Date()
      }).returning();
      return row!;
    }),
});

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
    .mutation(async () => {
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
        // These six tables hold every stock movement, bill, expense, and
        // opening entry. Nothing we keep has a foreign key into them, and
        // `entries` is the only child of `entry_groups`, so TRUNCATE ... CASCADE
        // is safe and self-contained.
        const tablesToWipe = [
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
    .mutation(async ({ input }) => {
      const entry_no = await generateEntryNo(db, "tax_master");
      const [newTax] = await db
        .insert(taxMaster)
        .values({
          entry_no,
          category: input.category,
          name: input.name,
          code: input.code || null,
          percentage: input.percentage,
        })
        .returning();
      return newTax!;
    }),

  update: protectedProcedure
    .input(UpdateTaxMasterSchema)
    .mutation(async ({ input }) => {
      const [updated] = await db
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
      return updated;
    }),

  delete: protectedProcedure
    .input(DeleteTaxMasterSchema)
    .mutation(async ({ input }) => {
      const [deleted] = await db
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
      return { success: true };
    }),
});

// ─── Settings root router ─────────────────────────────────────────────────────

export const settingsRouter = router({
  users: usersRouter,
  permissions: permissionsRouter,
  company: companyRouter,
  backup: backupRouter,
  taxMaster: taxMasterRouter,
});
