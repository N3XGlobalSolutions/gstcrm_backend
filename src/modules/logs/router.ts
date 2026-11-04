import { router, protectedProcedure, superadminProcedure } from "@/lib/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "@/db";
import { and, asc, count, desc, eq, gte, ilike, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { appUsers, loginHistory, activityLogs, auditLogs } from "@/db/schema";
import { recordClientEvent } from "./activity";
import { istDateRange, likePattern, LOG_DATE_REGEX, LOGIN_EVENTS } from "./helpers";

// ─── Logs (Settings › Logs) ───────────────────────────────────────────────────
// Three separate logs, superadmin only: Login History, Activity Log, Audit Log.
// from / to are inclusive local dates in Asia/Kolkata.

const logDate = z.string().regex(LOG_DATE_REGEX, "Date must be YYYY-MM-DD");

const PageInput = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(5000).default(50),
  from: logDate.optional(),
  to: logDate.optional(),
  search: z.string().trim().max(200).optional(),
};

/** created_at bounds for the inclusive from / to dates. */
function dateConditions(column: PgColumn, from?: string, to?: string): SQL[] {
  if (from && to && from > to) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "From date must be on or before To date" });
  }
  const { start, endExclusive } = istDateRange(from, to);
  const conds: SQL[] = [];
  if (start) conds.push(gte(column, start));
  if (endExclusive) conds.push(lt(column, endExclusive));
  return conds;
}

function searchCondition(search: string | undefined, columns: PgColumn[]): SQL | undefined {
  if (!search) return undefined;
  const pattern = likePattern(search);
  return or(...columns.map((c) => ilike(c, pattern)));
}

export const logsRouter = router({
  loginHistory: superadminProcedure
    .input(z.object({
      ...PageInput,
      userId: z.string().uuid().optional(),
      event: z.string().max(30).optional(),
      ip: z.string().max(45).optional(),
      newDeviceOnly: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      const conds: (SQL | undefined)[] = [...dateConditions(loginHistory.created_at, input.from, input.to)];
      if (input.userId) conds.push(eq(loginHistory.user_id, input.userId));
      if (input.event) conds.push(eq(loginHistory.event, input.event));
      if (input.ip) conds.push(eq(loginHistory.ip, input.ip.trim()));
      if (input.newDeviceOnly) conds.push(eq(loginHistory.new_device, true));
      conds.push(searchCondition(input.search, [
        loginHistory.username,
        loginHistory.ip,
        loginHistory.city,
        loginHistory.country,
        loginHistory.browser,
      ]));
      const where = and(...conds);

      const [rows, [countRow]] = await Promise.all([
        db
          .select({
            id: loginHistory.id,
            user_id: loginHistory.user_id,
            username: loginHistory.username,
            event: loginHistory.event,
            reason: loginHistory.reason,
            method: loginHistory.method,
            ip: loginHistory.ip,
            city: loginHistory.city,
            region: loginHistory.region,
            country: loginHistory.country,
            browser: loginHistory.browser,
            os: loginHistory.os,
            device_type: loginHistory.device_type,
            new_device: loginHistory.new_device,
            created_at: loginHistory.created_at,
          })
          .from(loginHistory)
          .where(where)
          .orderBy(desc(loginHistory.created_at), desc(loginHistory.id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        db.select({ total: count() }).from(loginHistory).where(where),
      ]);
      return { rows, total: countRow?.total ?? 0 };
    }),

  activity: superadminProcedure
    .input(z.object({
      ...PageInput,
      userId: z.string().uuid().optional(),
      module: z.string().max(50).optional(),
      action: z.string().max(50).optional(),
      success: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      const conds: (SQL | undefined)[] = [...dateConditions(activityLogs.created_at, input.from, input.to)];
      if (input.userId) conds.push(eq(activityLogs.user_id, input.userId));
      if (input.module) conds.push(eq(activityLogs.module, input.module));
      if (input.action) conds.push(eq(activityLogs.action, input.action));
      if (input.success !== undefined) conds.push(eq(activityLogs.success, input.success));
      conds.push(searchCondition(input.search, [
        activityLogs.username,
        activityLogs.module,
        activityLogs.action,
        activityLogs.procedure,
        activityLogs.record_ref,
        activityLogs.ip,
      ]));
      const where = and(...conds);

      const [rows, [countRow]] = await Promise.all([
        db
          .select({
            id: activityLogs.id,
            user_id: activityLogs.user_id,
            username: activityLogs.username,
            module: activityLogs.module,
            action: activityLogs.action,
            procedure: activityLogs.procedure,
            record_ref: activityLogs.record_ref,
            success: activityLogs.success,
            error: activityLogs.error,
            ip: activityLogs.ip,
            browser: activityLogs.browser,
            os: activityLogs.os,
            created_at: activityLogs.created_at,
          })
          .from(activityLogs)
          .where(where)
          .orderBy(desc(activityLogs.created_at), desc(activityLogs.id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        db.select({ total: count() }).from(activityLogs).where(where),
      ]);
      return { rows, total: countRow?.total ?? 0 };
    }),

  audit: superadminProcedure
    .input(z.object({
      ...PageInput,
      actorUserId: z.string().uuid().optional(),
      action: z.string().max(60).optional(),
      targetType: z.string().max(40).optional(),
    }))
    .query(async ({ input }) => {
      const conds: (SQL | undefined)[] = [...dateConditions(auditLogs.created_at, input.from, input.to)];
      if (input.actorUserId) conds.push(eq(auditLogs.actor_user_id, input.actorUserId));
      if (input.action) conds.push(eq(auditLogs.action, input.action));
      if (input.targetType) conds.push(eq(auditLogs.target_type, input.targetType));
      conds.push(searchCondition(input.search, [
        auditLogs.actor_username,
        auditLogs.action,
        auditLogs.target_label,
        auditLogs.reason,
        auditLogs.ip,
      ]));
      const where = and(...conds);

      const [rows, [countRow]] = await Promise.all([
        db
          .select({
            id: auditLogs.id,
            actor_user_id: auditLogs.actor_user_id,
            actor_username: auditLogs.actor_username,
            action: auditLogs.action,
            target_type: auditLogs.target_type,
            target_id: auditLogs.target_id,
            target_label: auditLogs.target_label,
            changes: auditLogs.changes,
            reason: auditLogs.reason,
            ip: auditLogs.ip,
            created_at: auditLogs.created_at,
          })
          .from(auditLogs)
          .where(where)
          .orderBy(desc(auditLogs.created_at), desc(auditLogs.id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        db.select({ total: count() }).from(auditLogs).where(where),
      ]);
      return { rows, total: countRow?.total ?? 0 };
    }),

  filterOptions: superadminProcedure.query(async () => {
    const [users, modules, activityActions, auditActions, loginEvents] = await Promise.all([
      db.select({ id: appUsers.id, username: appUsers.username }).from(appUsers).orderBy(asc(appUsers.username)),
      db.selectDistinct({ v: activityLogs.module }).from(activityLogs).orderBy(asc(activityLogs.module)),
      db.selectDistinct({ v: activityLogs.action }).from(activityLogs).orderBy(asc(activityLogs.action)),
      db.selectDistinct({ v: auditLogs.action }).from(auditLogs).orderBy(asc(auditLogs.action)),
      db.selectDistinct({ v: loginHistory.event }).from(loginHistory).orderBy(asc(loginHistory.event)),
    ]);
    const events = new Set<string>(LOGIN_EVENTS);
    for (const r of loginEvents) events.add(r.v);
    return {
      users,
      modules: modules.map((r) => r.v),
      activityActions: activityActions.map((r) => r.v),
      auditActions: auditActions.map((r) => r.v),
      loginEvents: [...events],
    };
  }),

  // Any signed-in user: exports / prints reported by the browser.
  logClientEvent: protectedProcedure
    .input(z.object({
      module: z.string().trim().min(1).max(50),
      action: z.enum(["export", "print"]),
      recordRef: z.string().trim().max(100).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await recordClientEvent({
        ctx,
        module: input.module,
        action: input.action,
        recordRef: input.recordRef ?? null,
      });
      return { success: true };
    }),
});
