import { router, protectedProcedure } from "@/lib/trpc";
import { z } from "zod";
import { db } from "@/db";
import { notifications, appUsers } from "@/db/schema";
import { eq, and, desc, count, ilike, not } from "drizzle-orm";
import { generateEntryNo } from "@/lib/entryNoGenerator";
import { AppError } from "@/types/errors";

const ListSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  isGst: z.boolean().optional(),
});
const CreateSchema = z.object({ message: z.string().min(1) });
const DeleteSchema = z.object({ id: z.string().uuid() });
const MarkReadSchema = z.object({ id: z.string().uuid() });

export const notificationsRouter = router({
  list: protectedProcedure.input(ListSchema).query(async ({ input, ctx }) => {
    const isSuperAdmin = ctx.user!.username.toLowerCase() === "superadmin";
    if (!isSuperAdmin && !input.isGst) {
      return { data: [], total: 0 };
    }

    const offset = (input.page - 1) * input.limit;
    const conditions = [eq(notifications.is_deleted, false)];
    if (input.isGst) {
      conditions.push(ilike(notifications.message, "%converted%to GST%"));
    } else {
      conditions.push(not(ilike(notifications.message, "%converted%to GST%")));
    }
    if (input.search) conditions.push(ilike(notifications.message, `%${input.search}%`));
    const where = and(...conditions);

    const [data, [countRow]] = await Promise.all([
      db
        .select({
          id: notifications.id,
          entry_no: notifications.entry_no,
          message: notifications.message,
          created_by: notifications.created_by,
          created_by_username: appUsers.username,
          is_read: notifications.is_read,
          is_deleted: notifications.is_deleted,
          created_at: notifications.created_at,
        })
        .from(notifications)
        .leftJoin(appUsers, eq(notifications.created_by, appUsers.id))
        .where(where)
        .orderBy(desc(notifications.created_at))
        .limit(input.limit)
        .offset(offset),
      db.select({ total: count() }).from(notifications).where(where),
    ]);

    return { data, total: countRow?.total ?? 0 };
  }),

  getUnreadCount: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user!.username.toLowerCase() !== "superadmin") {
      return { count: 0 };
    }
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
    return { count: countRow?.total ?? 0 };
  }),

  markAsRead: protectedProcedure.input(MarkReadSchema).mutation(async ({ input, ctx }) => {
    if (ctx.user!.username.toLowerCase() !== "superadmin") {
      throw new AppError("FORBIDDEN", "Only superadmin can perform this action");
    }

    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.id, input.id), eq(notifications.is_deleted, false)))
      .limit(1);

    if (!existing) throw new AppError("NOT_FOUND", "Notification not found");

    await db
      .update(notifications)
      .set({ is_read: true })
      .where(eq(notifications.id, input.id));

    return { success: true };
  }),

  markAllAsRead: protectedProcedure.mutation(async ({ ctx }) => {
    if (ctx.user!.username.toLowerCase() !== "superadmin") {
      throw new AppError("FORBIDDEN", "Only superadmin can perform this action");
    }

    await db
      .update(notifications)
      .set({ is_read: true })
      .where(eq(notifications.is_deleted, false));

    return { success: true };
  }),

  create: protectedProcedure.input(CreateSchema).mutation(async ({ input, ctx }) => {
    const entry_no = await generateEntryNo(db, "notifications");
    const [row] = await db
      .insert(notifications)
      .values({ entry_no, message: input.message, created_by: ctx.user!.id })
      .returning();
    return row!;
  }),

  delete: protectedProcedure.input(DeleteSchema).mutation(async ({ input, ctx }) => {
    const isSuperAdmin = ctx.user!.username.toLowerCase() === "superadmin";

    const [existing] = await db
      .select({ id: notifications.id, message: notifications.message })
      .from(notifications)
      .where(and(eq(notifications.id, input.id), eq(notifications.is_deleted, false)))
      .limit(1);

    if (!existing) throw new AppError("NOT_FOUND", "Notification not found");

    const isGstNotification = existing.message.toLowerCase().includes("gst");
    if (!isSuperAdmin && !isGstNotification) {
      throw new AppError("FORBIDDEN", "Only superadmin can perform this action");
    }

    await db
      .update(notifications)
      .set({ is_deleted: true })
      .where(eq(notifications.id, input.id));

    return { success: true };
  }),
});
