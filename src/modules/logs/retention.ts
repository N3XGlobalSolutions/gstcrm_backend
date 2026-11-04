import { and, lt, sql, type SQL } from "drizzle-orm";
import { db, type Database } from "@/db";
import {
  loginHistory,
  activityLogs,
} from "@/db/schema";
import { env } from "@/config/env";

// ─── Log retention ────────────────────────────────────────────────────────────
// Daily: drop login history / activity / audit rows older than
// LOG_RETENTION_DAYS (default 365), Bill & Data History (data_audit_log) rows
// older than DATA_AUDIT_RETENTION_DAYS (default 2922 = 8 years).
// (Gold CRM also clears expired 2FA tickets / trusted devices and old
// login_attempts here; GST CRM has no 2FA or IP blocking, and its
// login_attempts table is left as it was.)
//
// The log tables are tamper-protected by the database (migration 0025): a DELETE
// only goes through inside a transaction that sets gstcrm.retention = 'on', and
// only for rows older than a floor (300 days for the security logs, 8 years for
// data_audit_log). The WHERE clauses below repeat those floors so a smaller
// setting just keeps rows longer instead of failing the whole cleanup.

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const DAY_MS = 24 * 60 * 60 * 1000;
/** Database floors (must match gstcrm_protect_audit_delete trigger arguments). */
const SECURITY_LOG_FLOOR = sql`now() - interval '300 days'`;
const DATA_AUDIT_FLOOR = sql`now() - interval '8 years'`;

export interface RetentionResult {
  loginHistory: number;
  activityLogs: number;
  auditLogs: number;
  dataAudit: number;
}

/** Run deletes on the protected log tables (transaction-local gstcrm.retention = 'on'). */
function withRetention<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('gstcrm.retention', 'on', true)`);
    return fn(tx);
  });
}

/**
 * Trim a hash-chained log (audit_logs / data_audit_log): delete only a leading
 * run of the chain — sealed rows older than the cutoff whose seal_seq is below
 * the first row that stays. Verification anchors on the first remaining row's
 * prev_hash, so this never looks like a gap. Unsealed rows wait until sealed.
 */
async function trimChain(tx: Tx, table: SQL, cutoff: Date, floor: SQL): Promise<number> {
  const at = sql`least(${cutoff.toISOString()}::timestamptz, ${floor})`;
  const rows = await tx.execute<{ id: string }>(sql`
    delete from ${table} d
     where d.created_at < ${at}
       and d.seal_seq is not null
       and d.seal_seq < coalesce(
         (select k.seal_seq from ${table} k
           where k.seal_seq is not null and k.created_at >= ${at}
           order by k.seal_seq limit 1),
         9223372036854775807)
    returning d.id::text as id
  `);
  return rows.length;
}

export async function runLogRetention(now: Date = new Date()): Promise<RetentionResult> {
  const result: RetentionResult = {
    loginHistory: 0,
    activityLogs: 0,
    auditLogs: 0,
    dataAudit: 0,
  };

  const days = env.LOG_RETENTION_DAYS;
  if (Number.isFinite(days) && days >= 1) {
    if (days < 300) console.warn(`[retention] LOG_RETENTION_DAYS=${days} — the database keeps security logs at least 300 days`);
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    await withRetention(async (tx) => {
      result.loginHistory = (
        await tx
          .delete(loginHistory)
          .where(and(lt(loginHistory.created_at, cutoff), lt(loginHistory.created_at, SECURITY_LOG_FLOOR)))
          .returning({ id: loginHistory.id })
      ).length;
      result.activityLogs = (
        await tx
          .delete(activityLogs)
          .where(and(lt(activityLogs.created_at, cutoff), lt(activityLogs.created_at, SECURITY_LOG_FLOOR)))
          .returning({ id: activityLogs.id })
      ).length;
      result.auditLogs = await trimChain(tx, sql`"audit_logs"`, cutoff, SECURITY_LOG_FLOOR);
    });
  } else {
    console.warn(`[retention] LOG_RETENTION_DAYS=${days} — log tables are not trimmed`);
  }

  const dataDays = env.DATA_AUDIT_RETENTION_DAYS;
  if (Number.isFinite(dataDays) && dataDays >= 1) {
    if (dataDays < 2922) console.warn(`[retention] DATA_AUDIT_RETENTION_DAYS=${dataDays} — the database keeps bill history at least 8 years`);
    const cutoff = new Date(now.getTime() - dataDays * DAY_MS);
    result.dataAudit = await withRetention((tx) => trimChain(tx, sql`"data_audit_log"`, cutoff, DATA_AUDIT_FLOOR));
  } else {
    console.warn(`[retention] DATA_AUDIT_RETENTION_DAYS=${dataDays} — bill history is not trimmed`);
  }

  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

async function runSafely() {
  try {
    const r = await runLogRetention();
    const total = Object.values(r).reduce((a, b) => a + b, 0);
    if (total > 0) console.log("[retention] Old log rows removed:", r);
  } catch (err) {
    console.error("[retention] Cleanup failed:", err);
  }
}

/** Runs once now, then every 24 hours. Safe to call more than once. */
export function startLogRetentionJob(): void {
  if (timer) return;
  void runSafely();
  timer = setInterval(() => void runSafely(), DAY_MS);
  timer.unref?.();
}

export function stopLogRetentionJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
